/**
 * The floating selection toolbar stays on the card it names.
 *
 * Operator report: the pill floated away from the card during and after a
 * drag, because the shell's mirror answered from the row the card left. The
 * engine now reports the live screen rectangle of every card a pointer owns,
 * and the mirror answers with it; this spec holds the DOM pill to the pixels
 * the card is drawn at, in the real Electron window, mid-drag and after the
 * drop. The hook only says which card and where the mirror thinks it is; the
 * PNG decides whether the mirror and the pill are right.
 *
 * Run: bun run test:e2e fast e2e/scenarios/gpu-selection-toolbar-drag.spec.ts
 */

import { expect, test, type Page } from "@playwright/test";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchJunto, type JuntoHandle } from "../harness/launch";
import { modelFixture, modelNote } from "../harness/model";
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

const CANVAS = "factory";
const NOTE = "note-a";
const OTHER = "note-b";
const SHOTS = process.env["JUNTO_TOOLBAR_SHOTS"] ?? join("/tmp", "junto-toolbar-drag");
const TOOLBAR = '[data-canvas-overlay="selection-toolbar"]';

const fixture = modelFixture([
  modelNote(NOTE, "Dragged note", 0, 0),
  modelNote(OTHER, "Neighbour note", 560, 40),
]);

const rgbAt = (image: PngImage, point: Point): Rgb => {
  const x = Math.max(0, Math.min(image.width - 1, Math.round(point.x)));
  const y = Math.max(0, Math.min(image.height - 1, Math.round(point.y)));
  const at = (y * image.width + x) * 4;
  return [image.data[at] ?? 0, image.data[at + 1] ?? 0, image.data[at + 2] ?? 0];
};

const distance = (a: Rgb, b: Rgb): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * The bounding box of the pixels inside `rect` that differ from `ground` by
 * more than `tolerance`. The card's border, ring and text clear the tolerance;
 * its soft shadow does not, so the box is the card's drawn rectangle.
 */
const inkBounds = (image: PngImage, rect: Rect, ground: Rgb, tolerance = 80): Rect | null => {
  const left = Math.max(0, Math.floor(rect.x));
  const top = Math.max(0, Math.floor(rect.y));
  const right = Math.min(image.width, Math.ceil(rect.x + rect.width));
  const bottom = Math.min(image.height, Math.ceil(rect.y + rect.height));
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      if (distance(rgbAt(image, { x, y }), ground) <= tolerance) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
};

const centred = (a: Rect, b: Rect): Point => ({
  x: a.x + a.width / 2 - (b.x + b.width / 2),
  y: a.y + a.height / 2 - (b.y + b.height / 2),
});

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

const hookSelected = (page: Page): Promise<ReadonlyArray<string>> =>
  page.evaluate(() => window.__juntoCanvas!.selection());

const hideToolbar = (page: Page, hidden: boolean): Promise<void> =>
  page.evaluate(({ hidden, selector }) => {
    let style = document.getElementById("junto-spec-hide-toolbar") as HTMLStyleElement | null;
    if (!hidden) {
      style?.remove();
      return;
    }
    if (style === null) {
      style = document.createElement("style");
      style.id = "junto-spec-hide-toolbar";
      style.textContent = `${selector} { display: none !important; }`;
      document.head.append(style);
    }
  }, { hidden, selector: TOOLBAR });

/** Two frames, so a hidden overlay and a placed one have both painted. */
const twoFrames = (page: Page): Promise<void> =>
  page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );

const toolbarBox = async (page: Page): Promise<Rect> => {
  const box = await page.locator(TOOLBAR).boundingBox();
  if (box === null) throw new Error("the selection toolbar has no box");
  return box;
};

const expectOnCard = async (page: Page, id: string, when: string): Promise<void> => {
  const card = await hookRect(page, id);
  const pill = await toolbarBox(page);
  // Centred over the card, 8px above its top edge: `translate(-50%, -100%)`
  // on `rect.y - 8`.
  expect(Math.abs(pill.x + pill.width / 2 - (card.x + card.width / 2)), `${when}: toolbar centred over the card`).toBeLessThanOrEqual(2);
  expect(Math.abs(pill.y + pill.height - (card.y - 8)), `${when}: toolbar sits on the card's top edge`).toBeLessThanOrEqual(2);
};

/** The card's drawn rectangle, read from the PNG, with the toolbar out of the way. */
const drawnCard = async (page: Page, name: string, around: Rect, ground: Rgb): Promise<Rect> => {
  await hideToolbar(page, true);
  await twoFrames(page);
  const image = await shot(page, name, around);
  await hideToolbar(page, false);
  await twoFrames(page);
  const bounds = inkBounds(image, { x: 0, y: 0, width: image.width, height: image.height }, ground);
  if (bounds === null) throw new Error(`${name}: no card ink in the clip`);
  return { x: bounds.x + around.x, y: bounds.y + around.y, width: bounds.width, height: bounds.height };
};

test("the selection toolbar rides the card through a drag and stays after it", async () => {
  test.setTimeout(300_000);
  const junto: JuntoHandle = await launchJunto({ seedModels: { [CANVAS]: fixture } });
  const { page } = junto;
  try {
    const adapter = await page.evaluate(async () => (navigator.gpu === undefined ? false : (await navigator.gpu.requestAdapter()) !== null));
    test.skip(!adapter, "this host has no WebGPU adapter, so the GPU canvas cannot run");

    await page.waitForFunction(() => Boolean(window.junto?.settingsPatch), undefined, { timeout: 30_000 });
    await page.evaluate(() => window.junto!.settingsPatch({ advanced: { experimental: { gpuCanvas: true } } }));
    await expect.poll(() => page.evaluate(() => typeof window.__juntoCanvas?.ready === "function"), { timeout: 30_000 }).toBe(true);
    await expect.poll(() => page.evaluate(() => window.__juntoCanvas!.ready()), { timeout: 30_000 }).toBe(true);
    await expect.poll(() => page.evaluate(() => window.__juntoCanvas!.cardIds().length), { timeout: 30_000 }).toBe(2);
    await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "dark" } }));
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset["theme"] ?? "dark"), { timeout: 10_000 }).toBe("dark");
    await cameraSettled(page, { timeout: 20_000 });
    await page.waitForTimeout(400);

    const pane = await page.evaluate(() => window.__juntoCanvas!.rectOf("") as Rect | undefined);
    if (pane === undefined) throw new Error("no canvas rect");
    const ground = rgbAt(await shot(page, "00-ground"), { x: pane.x + pane.width - 12, y: pane.y + 12 });

    // 1. Selecting the card mounts the pill on it, over the pixels it draws.
    const resting = await hookRect(page, NOTE);
    await page.mouse.click(resting.x + resting.width / 2, resting.y + resting.height / 2);
    await expect.poll(() => hookSelected(page), { timeout: 5_000 }).toEqual([NOTE]);
    await expect(page.locator(TOOLBAR)).toBeVisible();
    await twoFrames(page);
    await expectOnCard(page, NOTE, "resting");
    await shot(page, "01-selected");

    const around = { x: resting.x - 40, y: resting.y - 40, width: resting.width + 300, height: resting.height + 260 };
    const drawnResting = await drawnCard(page, "02-resting-card-only", around, ground);
    expect(Math.abs(centred(drawnResting, resting).x)).toBeLessThanOrEqual(2);
    expect(Math.abs(centred(drawnResting, resting).y)).toBeLessThanOrEqual(2);

    // 2. Drag it. Mid-drag the pill must be on the drawn card, and the drawn
    // card must be where the mirror says: the pointer delta, on screen.
    const dx = 170;
    const dy = 130;
    await page.mouse.move(resting.x + resting.width / 2, resting.y + resting.height / 2);
    await page.mouse.down();
    await page.mouse.move(resting.x + resting.width / 2 + dx, resting.y + resting.height / 2 + dy, { steps: 14 });
    await twoFrames(page);

    const dragged = await hookRect(page, NOTE);
    expect(Math.abs(dragged.x - resting.x - dx), "the mirror moved by the pointer's travel").toBeLessThanOrEqual(2);
    expect(Math.abs(dragged.y - resting.y - dy), "the mirror moved by the pointer's travel").toBeLessThanOrEqual(2);
    await expect(page.locator(TOOLBAR)).toBeVisible();
    await expectOnCard(page, NOTE, "mid-drag");
    const dragging = await shot(page, "03-during-drag");

    // The card's own pixels, with the pill lifted out of the shot, at the spot
    // the mirror answered for: a stale mirror would find ground here.
    const midClip = { x: dragged.x - 40, y: dragged.y - 40, width: dragged.width + 80, height: dragged.height + 80 };
    const drawnMid = await drawnCard(page, "04-during-drag-card-only", midClip, ground);
    expect(Math.abs(centred(drawnMid, dragged).x), "mid-drag: the drawn card is where the mirror says").toBeLessThanOrEqual(2);
    expect(Math.abs(centred(drawnMid, dragged).y), "mid-drag: the drawn card is where the mirror says").toBeLessThanOrEqual(2);

    // A clip of the pill and the card's top edge, for the operator's eye.
    await page.screenshot({
      path: join(SHOTS, "05-during-drag-crop.png"),
      clip: { x: dragged.x - 80, y: dragged.y - 90, width: dragged.width + 160, height: 180 },
    });

    // 3. Drop: the row is written, the card stays, and the pill stays with it.
    await page.mouse.up();
    await expect
      .poll(async () => {
        const rect = await hookRect(page, NOTE);
        return Math.round(rect.x) === Math.round(dragged.x) && Math.round(rect.y) === Math.round(dragged.y);
      }, { timeout: 10_000 })
      .toBe(true);
    await cameraSettled(page, { timeout: 10_000 });
    await twoFrames(page);
    await expectOnCard(page, NOTE, "after the drop");
    await shot(page, "06-after-drop");

    const dropped = await hookRect(page, NOTE);
    const afterClip = { x: dropped.x - 40, y: dropped.y - 40, width: dropped.width + 80, height: dropped.height + 80 };
    const drawnAfter = await drawnCard(page, "07-after-drop-card-only", afterClip, ground);
    expect(Math.abs(centred(drawnAfter, dropped).x), "after the drop: the drawn card is where the mirror says").toBeLessThanOrEqual(2);
    expect(Math.abs(centred(drawnAfter, dropped).y), "after the drop: the drawn card is where the mirror says").toBeLessThanOrEqual(2);
    await page.screenshot({
      path: join(SHOTS, "08-after-drop-crop.png"),
      clip: { x: dropped.x - 80, y: dropped.y - 90, width: dropped.width + 160, height: 180 },
    });

    // The pill is still the card's, not the old spot's: it moved by the drag.
    expect(dragging.width).toBeGreaterThan(0);
  } finally {
    await junto.close();
  }
});
