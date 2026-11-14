/**
 * The GPU canvas's pointer, proved against rendered pixels, not the hook.
 *
 * Operator alarm 2026-11-14: cards were drawn at (board - camera) * zoom with
 * owner zero while picking used board * zoom + camera, so the shell's mirror
 * and `pickAt` agreed with each other and the screenshot did not. Every claim
 * here is read from a Playwright PNG of the real Electron window:
 *
 *   1. a click at a card's drawn pixels selects that card;
 *   2. a marquee on the pane draws a box where it was dragged and selects the
 *      cards inside it;
 *   3. a card drag paints the card under the pointer, and the drop writes it;
 *   4. a handle drag paints a wire in the gap, and the drop writes the edge;
 *   5. a wheel pan moves the painted board in the wheel's direction.
 *
 * The hook supplies rectangles and ids only. No assertion is that the hook
 * agrees with itself; the pixels decide.
 *
 * Run: bun run test:e2e fast e2e/scenarios/gpu-pointer-pixels.spec.ts
 */

import { expect, test, type Page } from "@playwright/test";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchJunto, type JuntoHandle } from "../harness/launch";
import { readModelCanvas, modelFixture, modelNote, modelTask } from "../harness/model";
import { cameraSettled } from "../harness/canvas";

interface PngImage {
  readonly width: number;
  readonly height: number;
  readonly data: Buffer;
}
const { PNG } = createRequire(import.meta.url)("pngjs") as {
  readonly PNG: { readonly sync: { read(buf: Buffer): PngImage } };
};

const CANVAS = "factory";
const SHOTS = process.env["JUNTO_GPU_PIXEL_SHOTS"] ?? join("/tmp", "junto-gpu-pixel-proof");

/**
 * Notes carry the four gestures: their shells paint a real card fill and
 * border without the atlas. Tasks (kind seats) take their ring, icon and text
 * from the atlas, so they are here for the one pair a note cannot join: the
 * task -> task connect, whose wire the wire layer paints on its own.
 */
const NOTE_A = "note-a";
const NOTE_B = "note-b";
const NOTE_C = "note-c";
const TASK_A = "task-a";
const TASK_B = "task-b";

const fixture = modelFixture([
  modelNote(NOTE_A, "Alpha note", 0, 0),
  modelNote(NOTE_B, "Bravo note", 420, 0),
  modelNote(NOTE_C, "Charlie note", 0, 250),
  modelTask(TASK_A, 0, 430),
  modelTask(TASK_B, 420, 430),
]);

type Rect = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
type Point = { readonly x: number; readonly y: number };
type Rgb = readonly [number, number, number];

const centre = (rect: Rect): Point => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });

const rgbAt = (image: PngImage, point: Point): Rgb => {
  const x = Math.max(0, Math.min(image.width - 1, Math.round(point.x)));
  const y = Math.max(0, Math.min(image.height - 1, Math.round(point.y)));
  const at = (y * image.width + x) * 4;
  return [image.data[at] ?? 0, image.data[at + 1] ?? 0, image.data[at + 2] ?? 0];
};

const distance = (a: Rgb, b: Rgb): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** The fraction of a 7x7 grid inside `rect` whose pixel differs from `ground`. */
const ink = (image: PngImage, rect: Rect, ground: Rgb): number => {
  let total = 0;
  let marked = 0;
  for (let iy = 1; iy <= 7; iy += 1) {
    for (let ix = 1; ix <= 7; ix += 1) {
      const point = { x: rect.x + (rect.width * ix) / 8, y: rect.y + (rect.height * iy) / 8 };
      total += 1;
      if (distance(rgbAt(image, point), ground) > 18) marked += 1;
    }
  }
  return marked / total;
};

/** The number of pixels in `rect` whose colour differs from `before` by more than `tol`. */
const changed = (after: PngImage, before: PngImage, rect: Rect, tol = 20): number => {
  const left = Math.max(0, Math.floor(rect.x));
  const top = Math.max(0, Math.floor(rect.y));
  const right = Math.min(after.width, Math.ceil(rect.x + rect.width));
  const bottom = Math.min(after.height, Math.ceil(rect.y + rect.height));
  let count = 0;
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      if (distance(rgbAt(after, { x, y }), rgbAt(before, { x, y })) > tol) count += 1;
    }
  }
  return count;
};

const shot = async (page: Page, name: string): Promise<PngImage> => {
  const buffer = await page.screenshot({ scale: "css" });
  mkdirSync(SHOTS, { recursive: true });
  writeFileSync(join(SHOTS, `${name}.png`), buffer);
  return PNG.sync.read(buffer);
};

const hook = (page: Page) =>
  page.evaluate(() => {
    const canvas = window.__juntoCanvas!;
    return {
      rects: Object.fromEntries(canvas.cardIds().map((id) => [id, canvas.rectOf(id) ?? null])),
      pane: canvas.rectOf("") ?? null,
      camera: canvas.camera(),
      selected: canvas.selection(),
    };
  });

const rectOf = async (page: Page, id: string): Promise<Rect> => {
  const rect = (await hook(page)).rects[id];
  if (rect === null || rect === undefined) throw new Error(`no rect for ${id}`);
  return rect;
};

const outside = (rects: ReadonlyArray<Rect>, point: Point, margin = 20): boolean =>
  rects.every((rect) => point.x < rect.x - margin || point.x > rect.x + rect.width + margin || point.y < rect.y - margin || point.y > rect.y + rect.height + margin);

const inside = (rect: Rect, point: Point): boolean =>
  point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height;

/** An empty pane point near one of the pane's corners. */
const emptyPanePoint = async (page: Page, corner: "tl" | "bl" | "tr" | "br"): Promise<Point> => {
  const { rects, pane } = await hook(page);
  if (pane === null || pane === undefined) throw new Error("no canvas rect");
  const cards = Object.values(rects).filter((rect): rect is Rect => rect !== null);
  const pad = 16;
  const candidates: Point[] = [
    { x: pane.x + pad, y: pane.y + pad },
    { x: pane.x + pad, y: pane.y + pane.height - pad },
    { x: pane.x + pane.width - pad, y: pane.y + pad },
    { x: pane.x + pane.width - pad, y: pane.y + pane.height - pad },
    { x: pane.x + pane.width / 2, y: pane.y + pane.height - pad },
    { x: pane.x + pane.width / 2, y: pane.y + pad },
  ];
  const ordered = corner === "tl" ? candidates : corner === "bl" ? [...candidates.slice(1), candidates[0], ...candidates.slice(2)] : candidates;
  const found = ordered.find((point) => outside(cards, point, 6));
  if (found === undefined) throw new Error("no empty pane point");
  return found;
};

test("the GPU canvas draws where it picks, marquees, drags, connects and pans", async () => {
  const junto: JuntoHandle = await launchJunto({
    seedModels: { [CANVAS]: fixture },
  });
  try {
    const { page } = junto;
    const adapter = await page.evaluate(async () => (navigator.gpu === undefined ? false : (await navigator.gpu.requestAdapter()) !== null));
    test.skip(!adapter, "this host has no WebGPU adapter, so the GPU canvas cannot run");
    // The operator's own path: the experimental switch turns the GPU canvas on
    // live, in the open window. Waiting for boot with it seeded reloads the
    // canvas under the harness and made the launch race its own window.
    await page.waitForFunction(() => Boolean(window.junto?.settingsPatch), undefined, { timeout: 30_000 });
    await page.evaluate(() => window.junto!.settingsPatch({ advanced: { experimental: { gpuCanvas: true } } }));
    await expect
      .poll(() => page.evaluate(() => typeof window.__juntoCanvas?.ready === "function"), { timeout: 30_000 })
      .toBe(true);
    await expect.poll(() => page.evaluate(() => window.__juntoCanvas!.ready()), { timeout: 30_000 }).toBe(true);
    await expect.poll(() => page.evaluate(() => window.__juntoCanvas!.cardIds().length), { timeout: 30_000 }).toBe(5);
    // The sandbox can inherit the operator's appearance; pin dark so the card
    // fills and the amber marquee are measured against one ground.
    await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "dark" } }));
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset["theme"] ?? "dark"), { timeout: 10_000 }).toBe("dark");
    await cameraSettled(page, { timeout: 20_000 });
    await page.waitForTimeout(400);

    const start = await hook(page);
    const pane = start.pane;
    if (pane === null || pane === undefined) throw new Error("no canvas rect");
    // Top left: clear of every card and of the bottom bars, which are DOM
    // overlays over the canvas and would take a click meant for the pane.
    const empty = await emptyPanePoint(page, "tl");
    const baseline = await shot(page, "0-baseline");
    const ground = rgbAt(baseline, empty);

    // 1. Every drawn card has ink exactly where the hook says it is.
    for (const id of [NOTE_A, NOTE_B, NOTE_C]) {
      const rect = start.rects[id]!;
      expect(ink(baseline, rect, ground), `${id} is drawn at its rect`).toBeGreaterThan(0.5);
    }

    // 2. Clicking a card's drawn centre selects it.
    const aRect = start.rects[NOTE_A]!;
    const aCentre = centre(aRect);
    expect(ink(baseline, { x: aCentre.x - 2, y: aCentre.y - 2, width: 4, height: 4 }, ground)).toBe(1);
    await page.mouse.click(aCentre.x, aCentre.y);
    await expect.poll(async () => (await hook(page)).selected, { timeout: 5_000 }).toEqual([NOTE_A]);
    const afterClick = await shot(page, "1-clicked-a");
    expect(ink(afterClick, aRect, ground), "the clicked card is still the card painted there").toBeGreaterThan(0.5);

    // 3. A marquee on the pane draws a box where the pointer dragged and
    // selects the cards inside it. Start above/left of every card.
    await page.mouse.click(empty.x, empty.y);
    await expect.poll(async () => (await hook(page)).selected, { timeout: 5_000 }).toEqual([]);
    const beforeMarquee = await shot(page, "2-before-marquee");
    const from = await emptyPanePoint(page, "tl");
    const { rects: marqueeRects } = await hook(page);
    const cards = Object.values(marqueeRects).filter((rect): rect is Rect => rect !== null);
    const right = Math.max(...cards.map((rect) => rect.x + rect.width));
    const bottom = Math.max(...cards.map((rect) => rect.y + rect.height));
    const to = { x: Math.min(pane.x + pane.width - 8, right + 10), y: Math.min(pane.y + pane.height - 8, bottom + 10) };
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 12 });
    await page.waitForTimeout(120);
    const dragging = await shot(page, "3-marquee-drag");
    const box = { x: Math.min(from.x, to.x), y: Math.min(from.y, to.y), width: Math.abs(to.x - from.x), height: Math.abs(to.y - from.y) };
    // The border is a warm hairline; the fill is a faint amber over the ground.
    const topEdge = rgbAt(dragging, { x: box.x + box.width / 2, y: box.y });
    expect(topEdge[0], `marquee top edge is warm (${topEdge.join(",")})`).toBeGreaterThan(topEdge[2] + 20);
    expect(distance(topEdge, ground), "marquee edge is not the ground").toBeGreaterThan(20);
    expect(changed(dragging, beforeMarquee, box, 8), "the marquee paints a box over the pane").toBeGreaterThan(5_000);
    await page.mouse.up();
    await expect.poll(async () => (await hook(page)).selected, { timeout: 5_000 }).toHaveLength(5);
    await expect(page.getByTestId("canvas-marquee")).toBeHidden();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(160);
    const afterMarquee = await shot(page, "4-after-marquee");
    const leftBack = rgbAt(afterMarquee, { x: box.x + box.width / 2, y: box.y });
    expect(distance(leftBack, ground), "the marquee box is gone after release").toBeLessThan(12);
    await page.mouse.click(empty.x, empty.y);
    await page.waitForTimeout(220);

    // 4. A card drag paints the card under the pointer at every move, and the
    // drop writes the new board position through the real model.
    const beforeDrag = await shot(page, "5-before-card-drag");
    const bRect = (await hook(page)).rects[NOTE_B]!;
    const bCentre = centre(bRect);
    const zoom = (await hook(page)).camera.zoom;
    const bBoardBefore = (await readModelCanvas(page, CANVAS)).nodes.find((node) => node.id === NOTE_B)!.x;
    const delta = { x: 132, y: 84 };
    await page.mouse.move(bCentre.x, bCentre.y);
    await page.mouse.down();
    await page.mouse.move(bCentre.x + delta.x, bCentre.y + delta.y, { steps: 10 });
    await page.waitForTimeout(120);
    const midDrag = await shot(page, "6-card-drag-mid");
    const movedCentre = { x: bCentre.x + delta.x, y: bCentre.y + delta.y };
    expect(ink(midDrag, { x: movedCentre.x - bRect.width / 2, y: movedCentre.y - bRect.height / 2, width: bRect.width, height: bRect.height }, ground), "the dragged card is painted under the pointer").toBeGreaterThan(0.5);
    // The new place overlaps the old by the drag delta's complement; the left
    // strip of the old rect is uncovered, and it is empty while the drag runs.
    const oldLeft = { x: bRect.x + 4, y: bRect.y + 4, width: bRect.width * 0.28, height: bRect.height - 8 };
    expect(ink(midDrag, oldLeft, ground), "the dragged card has left its old pixels").toBeLessThan(0.1);
    expect(ink(beforeDrag, oldLeft, ground), "the card was painted at its old pixels before the drag").toBeGreaterThan(0.5);
    await page.mouse.up();
    await expect
      .poll(async () => (await rectOf(page, NOTE_B)).x, { timeout: 8_000 })
      .toBeGreaterThan(bRect.x + delta.x - 4);
    const dragged = await shot(page, "7-card-dropped");
    expect(ink(dragged, { x: bRect.x + delta.x, y: bRect.y + delta.y, width: bRect.width, height: bRect.height }, ground), "the drop keeps the card painted at the new place").toBeGreaterThan(0.5);
    const opened = await readModelCanvas(page, CANVAS);
    const bNode = opened.nodes.find((node) => node.id === NOTE_B);
    if (bNode === undefined) throw new Error("the dragged card left the model");
    // The write is board units: the screen drag divided by the zoom.
    expect(Math.abs(bNode.x - bBoardBefore - delta.x / zoom)).toBeLessThan(2.5);
    expect(Math.abs(bNode.y - delta.y / zoom)).toBeLessThan(2.5);

    // 5. A handle drag paints a wire across the gap, and the drop writes it.
    const beforeConnect = await shot(page, "8-before-connect");
    const fresh = await hook(page);
    const aNow = fresh.rects[TASK_A]!;
    const bNow = fresh.rects[TASK_B]!;
    const handle = await page.evaluate((id) => {
      const canvas = window.__juntoCanvas as unknown as { rectOf(id: string, part?: string): Rect | null };
      return canvas.rectOf(id, "handle:source:right");
    }, TASK_A);
    if (handle === null) throw new Error("no source handle");
    await page.mouse.move(centre(handle).x, centre(handle).y);
    await page.mouse.down();
    await page.mouse.move(centre(bNow).x, centre(bNow).y, { steps: 14 });
    await page.waitForTimeout(140);
    const connecting = await shot(page, "9-connecting");
    const gap = {
      x: aNow.x + aNow.width + 6,
      y: Math.min(aNow.y, bNow.y) - 30,
      width: Math.max(8, bNow.x - (aNow.x + aNow.width) - 12),
      height: Math.max(aNow.height, bNow.height) + 60,
    };
    expect(changed(connecting, beforeConnect, gap, 20), "the connect preview paints in the gap").toBeGreaterThan(40);
    await page.mouse.up();
    await expect
      .poll(async () => (await readModelCanvas(page, CANVAS)).wires.length, { timeout: 8_000 })
      .toBeGreaterThan(0);
    await page.waitForTimeout(220);
    const wired = await shot(page, "10-wired");
    expect(changed(wired, beforeConnect, gap, 20), "the committed wire is painted in the gap").toBeGreaterThan(40);
    const withWire = await readModelCanvas(page, CANVAS);
    expect(withWire.wires.some((wire) => wire.from === TASK_A && wire.to === TASK_B)).toBe(true);

    // 6. A wheel pan moves the painted board the way the wheel says: a
    // downward scroll brings the board up, so the card's new pixels are above
    // the old ones.
    await page.mouse.click(empty.x, empty.y);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(220);
    const beforePan = await shot(page, "11-before-pan");
    const camBefore = (await hook(page)).camera;
    const aBefore = (await hook(page)).rects[NOTE_A]!;
    await page.mouse.move(empty.x, empty.y);
    await page.mouse.wheel(0, 30);
    await cameraSettled(page, { timeout: 8_000 });
    await page.waitForTimeout(220);
    const camAfter = (await hook(page)).camera;
    const aAfter = (await hook(page)).rects[NOTE_A]!;
    expect(camAfter.y, "a downward wheel scrolls the board up").toBeLessThan(camBefore.y - 20);
    expect(camAfter.x).toBeCloseTo(camBefore.x, 0);
    expect(aAfter.y).toBeLessThan(aBefore.y - 20);
    const afterPan = await shot(page, "12-after-pan");
    expect(ink(afterPan, aAfter, ground), "the card is painted at its post-pan rect").toBeGreaterThan(0.5);
    // The old card's bottom edge is below the panned card's new bottom edge.
    const oldBottom = { x: aBefore.x + aBefore.width * 0.25, y: aBefore.y + aBefore.height - 18, width: aBefore.width * 0.5, height: 12 };
    expect(ink(afterPan, oldBottom, ground), "the card is no longer painted at its old bottom edge").toBeLessThan(0.2);
    expect(ink(beforePan, oldBottom, ground), "the card was painted at its pre-pan bottom edge").toBeGreaterThan(0.5);
  } finally {
    await junto.close();
  }
});
