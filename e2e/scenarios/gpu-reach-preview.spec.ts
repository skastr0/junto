/**
 * The reach preview rides a GPU drag: the cards the drop would move into or
 * out of reach light up while the pointer is down, and the light goes on the
 * drop.
 *
 * Plan 0.10/01 rule 6. The rules are shared with the DOM canvas; what this
 * spec holds is the wiring. The proof is the PNG: the seat that stays still
 * while another card or a region crosses a boundary changes only at its edge,
 * in the hue of the change (green for reach, orange for loss), and returns to
 * its resting pixels when the pointer goes up.
 *
 * Run: bun run test:e2e e2e/scenarios/gpu-reach-preview.spec.ts
 */

import { expect, test, type Page } from "@playwright/test";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchJunto, type JuntoHandle } from "../harness/launch";
import { modelFixture, modelRegion, modelSeat, modelTask, readModelCanvas } from "../harness/model";
import { cameraSettled } from "../harness/canvas";

interface PngImage {
  readonly width: number;
  readonly height: number;
  readonly data: Buffer;
}
const { PNG } = createRequire(import.meta.url)("pngjs") as {
  readonly PNG: { readonly sync: { read(buf: Buffer): PngImage } };
};

type Rect = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
type Point = { readonly x: number; readonly y: number };
type Rgb = readonly [number, number, number];
type Camera = { readonly x: number; readonly y: number; readonly zoom: number };

const CANVAS = "factory";
const SHOTS = process.env["JUNTO_REACH_SHOTS"] ?? join("/tmp", "junto-reach-preview");

const A = "region-a";
const C = "region-c";
const SEAT = "seat-a";
const TA = "task-a";
const TC = "task-c";

// A holds the seat and TA; the sibling C holds TC. Two regions that are not on
// one line, so the seat in A reaches TA and not TC. The root is on a line with
// everything, so a card that falls out of its region comes into reach.
const cards = modelFixture([
  modelRegion({ id: A, label: "Alpha", x: 0, y: 0, width: 520, height: 420 }),
  modelRegion({ id: C, label: "Charlie", x: 620, y: 0, width: 520, height: 420 }),
  modelSeat({ id: SEAT, label: "Seat", x: 40, y: 120 }),
  modelTask(TA, 300, 120),
  modelTask(TC, 660, 140),
]);

// C is smaller than A, and holds its task: dragging C inside A nests it, and
// TC comes into reach of the seat that never moves.
const nested = modelFixture([
  modelRegion({ id: A, label: "Alpha", x: 0, y: 0, width: 700, height: 600 }),
  modelRegion({ id: C, label: "Charlie", x: 760, y: 0, width: 300, height: 240, hold: true }),
  modelSeat({ id: SEAT, label: "Seat", x: 40, y: 120 }),
  modelTask(TA, 300, 120),
  modelTask(TC, 800, 100),
]);

const rgbAt = (image: PngImage, point: Point): Rgb => {
  const x = Math.max(0, Math.min(image.width - 1, Math.round(point.x)));
  const y = Math.max(0, Math.min(image.height - 1, Math.round(point.y)));
  const at = (y * image.width + x) * 4;
  return [image.data[at] ?? 0, image.data[at + 1] ?? 0, image.data[at + 2] ?? 0];
};

const distance = (a: Rgb, b: Rgb): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Pixels in `rect` whose colour moved, and the mean of the ones that did. */
const moved = (before: PngImage, after: PngImage, tolerance = 18): { count: number; mean: Rgb } => {
  let count = 0;
  let r = 0;
  let g = 0;
  let b = 0;
  const width = Math.min(before.width, after.width);
  const height = Math.min(before.height, after.height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const was = rgbAt(before, { x, y });
      const now = rgbAt(after, { x, y });
      if (distance(was, now) <= tolerance) continue;
      count += 1;
      r += now[0];
      g += now[1];
      b += now[2];
    }
  }
  return count === 0 ? { count, mean: [0, 0, 0] } : { count, mean: [r / count, g / count, b / count] };
};

const grow = (rect: Rect, by: number): Rect => ({ x: rect.x - by, y: rect.y - by, width: rect.width + by * 2, height: rect.height + by * 2 });

const shot = async (page: Page, name: string, clip?: Rect): Promise<PngImage> => {
  const buffer = await page.screenshot(clip === undefined ? { scale: "css" } : { clip, scale: "css" });
  mkdirSync(SHOTS, { recursive: true });
  writeFileSync(join(SHOTS, `${name}.png`), buffer);
  return PNG.sync.read(buffer);
};

const hookRect = (page: Page, id: string): Promise<Rect> =>
  page.evaluate((id) => {
    const rect = window.__juntoCanvas!.rectOf(id);
    if (rect === undefined) throw new Error(`no rect for ${id}`);
    return rect as Rect;
  }, id);

const hookCamera = (page: Page): Promise<Camera> => page.evaluate(() => window.__juntoCanvas!.camera() as Camera);

type Mark = { readonly id: string; readonly effect?: string; readonly summary?: string };
const hookMarks = (page: Page): Promise<ReadonlyArray<Mark> | null> =>
  page.evaluate(() => (window.__juntoCanvas!.reachMarks?.() ?? null) as ReadonlyArray<{ id: string; effect?: string; summary?: string }> | null);

const twoFrames = (page: Page): Promise<void> =>
  page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

/** A board point on the page, through the live camera and canvas origin. */
const toScreen = async (page: Page, board: Point): Promise<Point> => {
  const pane = await page.evaluate(() => window.__juntoCanvas!.rectOf("") as Rect | undefined);
  if (pane === undefined) throw new Error("no canvas rect");
  const camera = await hookCamera(page);
  return { x: pane.x + camera.x + board.x * camera.zoom, y: pane.y + camera.y + board.y * camera.zoom };
};

const cardClip = (rect: Rect): Rect => grow(rect, 14);

const expectHue = (measured: { count: number; mean: Rgb }, hue: "gains" | "loses", what: string): void => {
  expect(measured.count, `${what}: the card's edge changed`).toBeGreaterThan(40);
  const [r, g, b] = measured.mean;
  if (hue === "gains") {
    expect(g, `${what}: green leads red (mean ${r.toFixed(0)},${g.toFixed(0)},${b.toFixed(0)})`).toBeGreaterThan(r + 6);
    expect(g, `${what}: green leads blue`).toBeGreaterThan(b + 6);
  } else {
    expect(r, `${what}: red leads green (mean ${r.toFixed(0)},${g.toFixed(0)},${b.toFixed(0)})`).toBeGreaterThan(g + 10);
    expect(g, `${what}: orange leads blue`).toBeGreaterThan(b + 6);
  }
};

const boot = async (page: Page, problem: typeof cards): Promise<void> => {
  const adapter = await page.evaluate(async () => (navigator.gpu === undefined ? false : (await navigator.gpu.requestAdapter()) !== null));
  test.skip(!adapter, "this host has no WebGPU adapter, so the GPU canvas cannot run");
  await page.waitForFunction(() => Boolean(window.junto?.settingsPatch), undefined, { timeout: 30_000 });
  await page.evaluate(() => window.junto!.settingsPatch({ advanced: { experimental: { gpuCanvas: true } } }));
  await expect.poll(() => page.evaluate(() => typeof window.__juntoCanvas?.ready === "function"), { timeout: 30_000 }).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__juntoCanvas!.ready()), { timeout: 30_000 }).toBe(true);
  // The hook's `cardIds` names non-region cards; the regions are in `regionIds`.
  const regionCount = problem.nodes.filter((node) => node.kind === "region").length;
  await expect.poll(() => page.evaluate(() => window.__juntoCanvas!.cardIds().length), { timeout: 30_000 }).toBe(problem.nodes.length - regionCount);
  await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "dark" } }));
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset["theme"] ?? "dark"), { timeout: 10_000 }).toBe("dark");
  await cameraSettled(page, { timeout: 20_000 });
  await page.waitForTimeout(400);
};

test("a card dragged out of a region paints the loss, and the drop clears it", async () => {
  test.setTimeout(420_000);
  const junto: JuntoHandle = await launchJunto({ seedModels: { [CANVAS]: cards } });
  const { page } = junto;
  try {
    await boot(page, cards);
    const seat = await hookRect(page, SEAT);
    const clip = cardClip(seat);
    await shot(page, "10-board");
    const rest = await shot(page, "11-seat-rest", clip);

    // TA dragged out of the seat's region into the sibling: the seat loses it
    // and the seat's own pixels are the proof, since it never moves.
    const ta = await hookRect(page, TA);
    const from = { x: ta.x + ta.width / 2, y: ta.y + ta.height / 2 };
    const to = await toScreen(page, { x: 760, y: 240 });
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 18 });
    await twoFrames(page);
    await shot(page, "12-during-loss");
    const loses = moved(rest, await shot(page, "13-seat-loses", clip));
    console.log("seat loses", JSON.stringify(loses));
    expectHue(loses, "loses", "the seat while TA crosses out");

    // The drop takes the light with it.
    await page.mouse.up();
    await twoFrames(page);
    await page.waitForTimeout(120);
    const after = moved(rest, await shot(page, "14-seat-after-loss", clip));
    expect(after.count, "the seat's mark is gone after the drop").toBeLessThan(20);
  } finally {
    await junto.close();
  }
});

// The shadow branch: a gains mark is a green rim and glow drawn in the lifted
// band, with no paint inside the card (the shadow quad's hole). It painted an
// opaque black box until f14369f6c fixed the shadow profile's layer stride.
test("a card dragged into a region paints the reach it gains", async () => {
  test.setTimeout(420_000);
  const junto: JuntoHandle = await launchJunto({ seedModels: { [CANVAS]: cards } });
  const { page } = junto;
  try {
    await boot(page, cards);
    const seat = await hookRect(page, SEAT);
    const clip = cardClip(seat);
    await shot(page, "20-board");
    const rest = await shot(page, "21-seat-rest", clip);

    const tc = await hookRect(page, TC);
    const from = { x: tc.x + tc.width / 2, y: tc.y + tc.height / 2 };
    const to = await toScreen(page, { x: 220, y: 350 });
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 18 });
    await twoFrames(page);
    await shot(page, "22-during-gain");
    const gains = moved(rest, await shot(page, "23-seat-gains", clip));
    console.log("seat gains", JSON.stringify(gains));
    expectHue(gains, "gains", "the seat while TC crosses in");
    await page.mouse.up();
  } finally {
    await junto.close();
  }
});

test("a region dragged into another nests, and the reach it brings shows while it moves", async () => {
  test.setTimeout(420_000);
  const junto: JuntoHandle = await launchJunto({ seedModels: { [CANVAS]: nested } });
  const { page } = junto;
  try {
    await boot(page, nested);
    const seat = await hookRect(page, SEAT);
    const clip = cardClip(seat);
    await shot(page, "30-board");
    const rest = await shot(page, "31-seat-rest", clip);

    // The region's title bar, carried so its task rides inside it.
    const grab = await toScreen(page, { x: 760 + 60, y: 10 });
    const into = await toScreen(page, { x: 360 + 60, y: 300 + 10 });
    await page.mouse.move(grab.x, grab.y);
    await page.mouse.down();
    await page.mouse.move(into.x, into.y, { steps: 18 });
    await twoFrames(page);
    await shot(page, "32-during-region-drag");
    // The shell's marks for this frame: the seat and the task gain each other,
    // and the dragged region carries the words (a summary-only mark, no ring).
    const marks = await hookMarks(page);
    console.log("marks on region drag", JSON.stringify(marks));
    expect(marks).toEqual(
      expect.arrayContaining([
        { id: SEAT, effect: "gains" },
        { id: TC, effect: "gains" },
        { id: C, summary: "1 comes into reach" },
      ]),
    );
    const gains = moved(rest, await shot(page, "33-seat-marked", clip));
    console.log("seat marked on region drag", JSON.stringify(gains));
    await page.mouse.up();

    // 4. Nested membership is written: the region is wholly inside the other.
    const a = await page.evaluate((canvas) => window.junto!.modelOpen({ canvas }), CANVAS);
    const regionA = a.nodes.find((node) => node.id === A);
    const regionC = a.nodes.find((node) => node.id === C);
    if (regionA === undefined || regionC === undefined) throw new Error("a region is missing after the drop");
    expect(regionC.x).toBeGreaterThanOrEqual(regionA.x);
    expect(regionC.y).toBeGreaterThanOrEqual(regionA.y);
    expect(regionC.x + regionC.width).toBeLessThanOrEqual(regionA.x + regionA.width);
    expect(regionC.y + regionC.height).toBeLessThanOrEqual(regionA.y + regionA.height);
    await twoFrames(page);
    await page.waitForTimeout(120);
    expect(await hookMarks(page), "the marks are gone after the drop").toBeNull();
    const after = moved(rest, await shot(page, "34-seat-after-region-drop", clip));
    expect(after.count, "the seat's pixels are back after the region drop").toBeLessThan(20);
    await shot(page, "35-after-region-drop");
  } finally {
    await junto.close();
  }
});
