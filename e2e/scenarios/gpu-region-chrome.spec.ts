/**
 * Region chrome and the reach preview, proved on the pixels of the real
 * Electron window.
 *
 * Operator test 2026-11-14: region resize, region hover and region
 * boundary/nesting on the GPU canvas. Every claim here is read from a
 * Playwright PNG (and, for the cursor, the canvas's own computed cursor):
 *
 *   1. an unselected region hovers its title bar and its 12-unit frame strips,
 *      shows the grab cursor there, and takes nothing from its interior;
 *   2. a selected region's four corners and four edges are resize grips, with
 *      the corner and one-axis cursors, and a grip drag paints the region at
 *      its new size while the model is still unchanged;
 *   3. a drag that crosses a region boundary paints the reach preview on the
 *      frame it crossed: green rings (gains) or orange dashed rings (loses),
 *      and the summary pill beside the card the pointer holds — for a card
 *      drag and for a region drag.
 *
 * The hook supplies rectangles and ids only. No assertion is that the hook
 * agrees with itself; the pixels and the model reads decide.
 *
 * Run: JUNTO_E2E_FEATURES=gpuCanvas scripts/run-e2e.sh e2e/scenarios/gpu-region-chrome.spec.ts
 */

import { expect, test, type Page } from "@playwright/test";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchJunto, type JuntoHandle } from "../harness/launch";
import { readModelCanvas, modelFixture, modelRegion, modelSeat, modelTask } from "../harness/model";
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
const SHOTS = process.env["JUNTO_GPU_REGION_SHOTS"] ?? join("/tmp", "junto-gpu-region-proof");

const MAIN = "region-main";
const LEFT = "region-left";
const RIGHT = "region-right";
const SEAT = "seat-left";
const TASK = "task-right";

type Rect = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
type Point = { readonly x: number; readonly y: number };
type Rgb = readonly [number, number, number];

/**
 * The operator's board: one region holding a seat, a sibling region holding a
 * task, both nested in a parent, so crossing either child's boundary is also a
 * nesting change. The right region holds its cards so a region drag carries the
 * task, and the pair starts out of reach of each other (sibling regions).
 */
const fixture = modelFixture([
  modelRegion({ id: MAIN, x: 0, y: 0, width: 1240, height: 720, label: "Stage" }),
  modelRegion({ id: LEFT, x: 60, y: 100, width: 520, height: 380, label: "Left" }),
  modelRegion({ id: RIGHT, x: 660, y: 100, width: 340, height: 240, label: "Right", hold: true }),
  modelSeat({ id: SEAT, key: "local:region-seat", label: "planner", x: 120, y: 140 }),
  modelTask(TASK, 700, 150),
]);

const centre = (rect: Rect): Point => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });

const rgbAt = (image: PngImage, point: Point): Rgb => {
  const x = Math.max(0, Math.min(image.width - 1, Math.round(point.x)));
  const y = Math.max(0, Math.min(image.height - 1, Math.round(point.y)));
  const at = (y * image.width + x) * 4;
  return [image.data[at] ?? 0, image.data[at + 1] ?? 0, image.data[at + 2] ?? 0];
};

const distance = (a: Rgb, b: Rgb): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

const brightness = (pixel: Rgb): number => (pixel[0] + pixel[1] + pixel[2]) / 3;

const areaOf = (rect: Rect): number => Math.max(1, rect.width * rect.height);

/** How far a pixel leans amber: red over blue. */
const warmth = (pixel: Rgb): number => pixel[0] - pixel[2];

const greenish = (pixel: Rgb): boolean => pixel[1] > pixel[0] + 8 && pixel[1] > pixel[2] + 6;

const orangish = (pixel: Rgb): boolean => pixel[0] > pixel[1] + 10 && pixel[0] > pixel[2] + 8;

/** The pixels in `area` that satisfy `test`. */
const countWhere = (image: PngImage, area: Rect, test: (pixel: Rgb) => boolean): number => {
  const left = Math.max(0, Math.floor(area.x));
  const top = Math.max(0, Math.floor(area.y));
  const right = Math.min(image.width, Math.ceil(area.x + area.width));
  const bottom = Math.min(image.height, Math.ceil(area.y + area.height));
  let count = 0;
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      if (test(rgbAt(image, { x, y }))) count += 1;
    }
  }
  return count;
};

/** The number of pixels in `area` whose colour differs from `before` by more than `tol`. */
const changed = (after: PngImage, before: PngImage, area: Rect, tol = 20): number => {
  const left = Math.max(0, Math.floor(area.x));
  const top = Math.max(0, Math.floor(area.y));
  const right = Math.min(after.width, Math.ceil(area.x + area.width));
  const bottom = Math.min(after.height, Math.ceil(area.y + area.height));
  let count = 0;
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      if (distance(rgbAt(after, { x, y }), rgbAt(before, { x, y })) > tol) count += 1;
    }
  }
  return count;
};

/** The warmest pixel on the horizontal line `y` in `[x0, x1]`, and where it is. */
const warmestOnRow = (image: PngImage, x0: number, x1: number, y: number): { readonly at: number; readonly warmth: number } => {
  let best = { at: Math.round(x0), warmth: -Infinity };
  for (let x = Math.floor(x0); x <= Math.ceil(x1); x += 1) {
    const w = warmth(rgbAt(image, { x, y }));
    if (w > best.warmth) best = { at: x, warmth: w };
  }
  return best;
};

const shot = async (page: Page, name: string): Promise<PngImage> => {
  const buffer = await page.screenshot({ scale: "css" });
  mkdirSync(SHOTS, { recursive: true });
  writeFileSync(join(SHOTS, `${name}.png`), buffer);
  return PNG.sync.read(buffer);
};

const rectOf = (page: Page, id: string): Promise<Rect | null> =>
  page.evaluate((id) => (window.__juntoCanvas!.rectOf(id) as Rect | null | undefined) ?? null, id);

const selected = (page: Page): Promise<ReadonlyArray<string>> =>
  page.evaluate(() => [...window.__juntoCanvas!.selection()]);

const cursorOf = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const canvas = document.querySelector('[data-testid="gpu-canvas"]');
    return canvas instanceof HTMLElement ? canvas.style.cursor : "";
  });

/** Move the pointer and let a frame land, then the cursor the shell now shows. */
const hover = async (page: Page, at: Point): Promise<string> => {
  await page.mouse.move(at.x, at.y);
  await page.waitForTimeout(140);
  return cursorOf(page);
};

const parked = async (page: Page, at: Point): Promise<void> => {
  await page.mouse.move(at.x, at.y);
  await page.waitForTimeout(180);
};

const modelNode = async (page: Page, id: string) => {
  const opened = await readModelCanvas(page, CANVAS);
  const node = opened.nodes.find((candidate) => candidate.id === id);
  if (node === undefined) throw new Error(`${id} is not in the model`);
  return node;
};

test("region hover, selected region resize and the reach preview paint in the real window", async () => {
  const junto: JuntoHandle = await launchJunto({ seedModels: { [CANVAS]: fixture } });
  try {
    const { page } = junto;
    const adapter = await page.evaluate(async () => (navigator.gpu === undefined ? false : (await navigator.gpu.requestAdapter()) !== null));
    test.skip(!adapter, "this host has no WebGPU adapter, so the GPU canvas cannot run");

    await page.waitForFunction(() => Boolean(window.junto?.settingsPatch), undefined, { timeout: 30_000 });
    await page.evaluate(() => window.junto!.settingsPatch({ advanced: { experimental: { gpuCanvas: true } } }));
    await expect.poll(() => page.evaluate(() => typeof window.__juntoCanvas?.ready === "function"), { timeout: 30_000 }).toBe(true);
    await expect.poll(() => page.evaluate(() => window.__juntoCanvas!.ready()), { timeout: 30_000 }).toBe(true);
    await expect.poll(() => page.evaluate(() => window.__juntoCanvas!.regionIds().length), { timeout: 30_000 }).toBe(3);
    await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "dark" } }));
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset["theme"] ?? "dark"), { timeout: 10_000 }).toBe("dark");
    await cameraSettled(page, { timeout: 20_000 });
    await page.waitForTimeout(400);
    expect(await page.evaluate(() => window.__juntoCanvas!.tier())).toMatch(/^(near|mid)$/);

    const left = await rectOf(page, LEFT);
    const main = await rectOf(page, MAIN);
    if (left === null || main === null) throw new Error("the regions are not drawn");
    // A pane point inside the parent but outside both children.
    const pane = { x: main.x + main.width * 0.5, y: main.y + main.height * 0.9 };
    await parked(page, pane);
    const baseline = await shot(page, "00-region-baseline");

    // 1. The unselected region's title bar: grab, and a hover wash on the bar.
    const titleAt = { x: left.x + left.width * 0.66, y: left.y + 10 };
    expect(await hover(page, titleAt), "the title bar shows the grab cursor").toBe("grab");
    const titleHover = await shot(page, "01-region-title-hover");
    const titleBar = { x: left.x + left.width * 0.7, y: left.y + 2, width: left.width * 0.25, height: 20 };
    expect(changed(titleHover, baseline, titleBar, 4), "hovering the title bar washes it").toBeGreaterThan(200);
    // Moving off it restores the bar, so the wash is the hover and not motion.
    await parked(page, pane);
    const titleBack = await shot(page, "01b-region-title-rested");
    expect(changed(titleBack, baseline, titleBar, 4), "the wash goes with the hover").toBeLessThan(60);

    // 2. A 12-unit frame strip: grab, and the border turns amber.
    const frameAt = { x: left.x + 5, y: left.y + left.height * 0.55 };
    expect(await hover(page, frameAt), "the frame strip shows the grab cursor").toBe("grab");
    const frameHover = await shot(page, "02-region-frame-hover");
    const strip = { x: left.x - 1, y: left.y + left.height * 0.3, width: 3, height: left.height * 0.4 };
    expect(changed(frameHover, titleBack, strip, 10), "the hovered frame border changes colour").toBeGreaterThan(40);
    const borderY = Math.round(left.y + left.height * 0.55);
    expect(warmestOnRow(frameHover, left.x - 2, left.x + 2, borderY).warmth, "the hovered border leans amber").toBeGreaterThan(12);
    // The interior is the pane, as the DOM has it.
    expect(await hover(page, { x: left.x + left.width * 0.5, y: left.y + left.height * 0.8 })).toBe("default");

    // 3. Select the region: eight grips and their cursors.
    await page.mouse.click(titleAt.x, titleAt.y);
    await expect.poll(() => selected(page), { timeout: 5_000 }).toContain(LEFT);
    await parked(page, pane);
    await shot(page, "03-region-selected");
    const corners: ReadonlyArray<{ readonly at: Point; readonly name: string; readonly cursor: string }> = [
      { at: { x: left.x, y: left.y }, name: "nw", cursor: "nwse-resize" },
      { at: { x: left.x + left.width, y: left.y }, name: "ne", cursor: "nesw-resize" },
      { at: { x: left.x + left.width, y: left.y + left.height }, name: "se", cursor: "nwse-resize" },
      { at: { x: left.x, y: left.y + left.height }, name: "sw", cursor: "nesw-resize" },
    ];
    for (const corner of corners) expect(await hover(page, corner.at), `corner ${corner.name}`).toBe(corner.cursor);
    const edges: ReadonlyArray<{ readonly at: Point; readonly name: string; readonly cursor: string }> = [
      { at: { x: left.x + left.width / 2, y: left.y }, name: "n", cursor: "ns-resize" },
      { at: { x: left.x + left.width, y: left.y + left.height / 2 }, name: "e", cursor: "ew-resize" },
      { at: { x: left.x + left.width / 2, y: left.y + left.height }, name: "s", cursor: "ns-resize" },
      { at: { x: left.x, y: left.y + left.height / 2 }, name: "w", cursor: "ew-resize" },
    ];
    for (const edge of edges) expect(await hover(page, edge.at), `edge ${edge.name}`).toBe(edge.cursor);
    const gripHover = { at: { x: left.x + left.width, y: left.y + left.height }, name: "se" };
    await hover(page, gripHover.at);
    await shot(page, "04-region-grip-hover");

    // 4. A grip drag draws the region at its new size before the model moves.
    const zoom = await page.evaluate(() => window.__juntoCanvas!.camera().zoom);
    const travel = { x: -100, y: -60 };
    const beforeResize = await shot(page, "05a-region-before-resize");
    await page.mouse.move(gripHover.at.x, gripHover.at.y);
    await page.mouse.down();
    await page.mouse.move(gripHover.at.x + travel.x, gripHover.at.y + travel.y, { steps: 10 });
    await page.waitForTimeout(160);
    const midResize = await shot(page, "05-region-resize-mid");
    const liveRight = left.x + left.width + travel.x;
    const liveBottom = left.y + left.height + travel.y;
    const rowY = Math.round(left.y + (left.height + travel.y) * 0.55);
    const newEdge = warmestOnRow(midResize, liveRight - 5, liveRight + 5, rowY);
    expect(newEdge.warmth, `the grown-in border is painted at ${newEdge.at}`).toBeGreaterThan(12);
    const oldEdge = warmestOnRow(midResize, left.x + left.width - 2, left.x + left.width + 2, rowY);
    const oldEdgeBefore = warmestOnRow(beforeResize, left.x + left.width - 2, left.x + left.width + 2, rowY);
    expect(oldEdgeBefore.warmth, "the selected region's old border was amber").toBeGreaterThan(12);
    expect(oldEdge.warmth, "the region has left its old border behind").toBeLessThan(oldEdgeBefore.warmth - 8);
    expect(liveBottom).toBeLessThan(left.y + left.height);
    // No write while the pointer holds the grip.
    const heldModel = await modelNode(page, LEFT);
    expect(heldModel.width, "a resize in progress writes nothing").toBe(520);
    expect(heldModel.height).toBe(380);
    await page.mouse.up();
    const expectedWidth = 520 + Math.floor(travel.x / zoom);
    const expectedHeight = 380 + Math.floor(travel.y / zoom);
    await expect.poll(async () => (await modelNode(page, LEFT)).width, { timeout: 8_000 }).toBeGreaterThan(expectedWidth - 3);
    await expect.poll(async () => (await modelNode(page, LEFT)).width, { timeout: 8_000 }).toBeLessThan(expectedWidth + 3);
    const doneModel = await modelNode(page, LEFT);
    expect(Math.abs(doneModel.height - expectedHeight)).toBeLessThan(3);
    await page.waitForTimeout(240);
    const resized = await shot(page, "06-region-resize-done");
    const resizedRect = await rectOf(page, LEFT);
    if (resizedRect === null) throw new Error("the resized region left the canvas");
    expect(Math.abs(resizedRect.width - (left.width + travel.x))).toBeLessThan(4);
    expect(Math.abs(resizedRect.height - (left.height + travel.y))).toBeLessThan(4);
    const doneEdge = warmestOnRow(resized, resizedRect.x + resizedRect.width - 3, resizedRect.x + resizedRect.width + 3, Math.round(resizedRect.y + resizedRect.height * 0.55));
    expect(doneEdge.warmth, "the dropped region keeps its new border painted").toBeGreaterThan(12);

    // 5. Reach, gains: the task crosses out of the sibling region into the
    // seat's, and the frame it crosses shows green rings and the pill.
    await page.mouse.click(pane.x, pane.y);
    await page.waitForTimeout(200);
    const leftNow = await rectOf(page, LEFT);
    const task = await rectOf(page, TASK);
    const right = await rectOf(page, RIGHT);
    const seat = await rectOf(page, SEAT);
    if (leftNow === null || task === null || right === null || seat === null) throw new Error("the reach cards are not drawn");
    const taskNode = await modelNode(page, TASK);
    const leftNode = await modelNode(page, LEFT);
    // The destination is wholly inside the shrunk left region, below the seat.
    const destination = { x: leftNode.x + 80, y: leftNode.y + 150 };
    // The pointer holds the card's middle, so its middle is what travels by the
    // board delta; the card's own rectangle lands at the destination.
    const target = {
      x: centre(task).x + (destination.x - taskNode.x) * zoom,
      y: centre(task).y + (destination.y - taskNode.y) * zoom,
    };
    const beforeReach = await shot(page, "07a-reach-before");
    await page.mouse.move(centre(task).x, centre(task).y);
    await page.mouse.down();
    await page.mouse.move(target.x, target.y, { steps: 14 });
    await page.waitForTimeout(200);
    const gains = await shot(page, "07-reach-gains-mid");
    const liveTask = { x: task.x + (target.x - centre(task).x), y: task.y + (target.y - centre(task).y), width: task.width, height: task.height };
    const taskBand = { x: liveTask.x + liveTask.width * 0.25, y: liveTask.y - 10, width: liveTask.width * 0.5, height: 8 };
    const seatBand = { x: seat.x + seat.width * 0.25, y: seat.y - 10, width: seat.width * 0.5, height: 8 };
    const taskGain = countWhere(gains, taskBand, greenish);
    const seatGain = countWhere(gains, seatBand, greenish);
    expect(taskGain, "the task wears the green gain ring").toBeGreaterThan(20);
    expect(seatGain, "the seat wears the green gain ring").toBeGreaterThan(20);
    // The rings are what the drag added: the card's own halo does not green.
    expect(taskGain - countWhere(beforeReach, taskBand, greenish), "the task gains green pixels it did not have").toBeGreaterThan(20);
    expect(seatGain - countWhere(beforeReach, seatBand, greenish), "the seat gains green pixels it did not have").toBeGreaterThan(20);
    const gainPill = { x: liveTask.x + liveTask.width + 30, y: liveTask.y + liveTask.height / 2 - 8, width: 80, height: 16 };
    // The pill is a filled rounded rect, not just its words: its background
    // covers most of this box, while the words alone cover under a third.
    expect(changed(gains, beforeReach, gainPill, 8), "the summary pill stands beside the task").toBeGreaterThan(areaOf(gainPill) * 0.45);
    await page.mouse.up();
    await expect.poll(async () => (await modelNode(page, TASK)).x, { timeout: 8_000 }).toBeGreaterThan(destination.x - 3);
    await page.waitForTimeout(220);
    const gained = await shot(page, "08-reach-gains-done");
    expect(countWhere(gained, taskBand, greenish), "the rings go with the drop").toBeLessThan(8);

    // 6. Reach, loses: the task goes back across the boundary, and the rings
    // are the dashed orange the losing side wears.
    const taskBack = await rectOf(page, TASK);
    if (taskBack === null) throw new Error("the dropped task is not drawn");
    const taskHome = await modelNode(page, TASK);
    const home = { x: centre(taskBack).x + (700 - taskHome.x) * zoom, y: centre(taskBack).y + (150 - taskHome.y) * zoom };
    const beforeLose = await shot(page, "09a-reach-loses-before");
    await page.mouse.move(centre(taskBack).x, centre(taskBack).y);
    await page.mouse.down();
    await page.mouse.move(home.x, home.y, { steps: 14 });
    await page.waitForTimeout(220);
    const loses = await shot(page, "09-reach-loses-mid");
    const liveBack = { x: taskBack.x + (home.x - centre(taskBack).x), y: taskBack.y + (home.y - centre(taskBack).y), width: taskBack.width, height: taskBack.height };
    const loseBand = { x: liveBack.x + liveBack.width * 0.25, y: liveBack.y - 10, width: liveBack.width * 0.5, height: 8 };
    const loseSeatBand = { x: seat.x + seat.width * 0.25, y: seat.y - 10, width: seat.width * 0.5, height: 8 };
    const taskLose = countWhere(loses, loseBand, orangish);
    const seatLose = countWhere(loses, loseSeatBand, orangish);
    expect(taskLose, "the task wears the orange lose ring").toBeGreaterThan(20);
    expect(seatLose, "the seat wears the orange lose ring").toBeGreaterThan(20);
    // The dashed outline is a delta: an idle ring's warm halo is not a lose mark.
    expect(taskLose - countWhere(beforeLose, loseBand, orangish), "the task gains orange pixels it did not have").toBeGreaterThan(20);
    expect(seatLose - countWhere(beforeLose, loseSeatBand, orangish), "the seat gains orange pixels it did not have").toBeGreaterThan(20);
    await page.mouse.up();
    await expect.poll(async () => (await modelNode(page, TASK)).x, { timeout: 8_000 }).toBeLessThan(704);
    await page.waitForTimeout(220);
    await shot(page, "10-reach-loses-done");

    // 7. A region drag carries its task across the boundary, and the pill
    // rides the region the pointer holds.
    const rightNow = await rectOf(page, RIGHT);
    const taskNow = await rectOf(page, TASK);
    if (rightNow === null || taskNow === null) throw new Error("the right region is not drawn");
    const rightNode = await modelNode(page, RIGHT);
    // A selected card's floating toolbar is DOM over the canvas; the pane
    // click clears the selection so no chrome stands over the region's title.
    await page.mouse.click(pane.x, pane.y);
    await page.waitForTimeout(180);
    const rightTitle = { x: rightNow.x + rightNow.width * 0.2, y: rightNow.y + 10 };
    const rightDestination = { x: leftNode.x + 40, y: leftNode.y + 60 };
    const regionTarget = {
      x: rightTitle.x + (rightDestination.x - rightNode.x) * zoom,
      y: rightTitle.y + (rightDestination.y - rightNode.y) * zoom,
    };
    const beforeRegionDrag = await shot(page, "11a-region-drag-before");
    await page.mouse.move(rightTitle.x, rightTitle.y);
    await page.mouse.down();
    await page.mouse.move(regionTarget.x, regionTarget.y, { steps: 14 });
    await page.waitForTimeout(220);
    const regionDrag = await shot(page, "11-region-drag-reach-mid");
    const liveRegion = {
      x: rightNow.x + (regionTarget.x - rightTitle.x),
      y: rightNow.y + (regionTarget.y - rightTitle.y),
      width: rightNow.width,
      height: rightNow.height,
    };
    const liveRider = {
      x: taskNow.x + (regionTarget.x - rightTitle.x),
      y: taskNow.y + (regionTarget.y - rightTitle.y),
      width: taskNow.width,
      height: taskNow.height,
    };
    expect(countWhere(regionDrag, { x: liveRider.x + liveRider.width * 0.25, y: liveRider.y - 10, width: liveRider.width * 0.5, height: 8 }, greenish), "the carried task wears the gain ring").toBeGreaterThan(20);
    const regionPill = { x: liveRegion.x + liveRegion.width + 30, y: liveRegion.y + liveRegion.height / 2 - 8, width: 80, height: 16 };
    expect(changed(regionDrag, beforeRegionDrag, regionPill, 8), "the summary pill stands beside the region under the pointer").toBeGreaterThan(areaOf(regionPill) * 0.4);
    // The pixels above are the proof; the hook says which marks the shell
    // handed the canvas, so a passing pill cannot be a stale frame.
    const dragging = await page.evaluate(() => window.__juntoCanvas!.reachMarks?.() ?? null);
    expect(dragging).toEqual(
      expect.arrayContaining([
        { id: SEAT, effect: "gains" },
        { id: TASK, effect: "gains" },
        { id: RIGHT, summary: "1 comes into reach" },
      ]),
    );
    await page.mouse.up();
    await expect.poll(async () => (await modelNode(page, RIGHT)).x, { timeout: 8_000 }).toBeLessThan(220);
    await page.waitForTimeout(220);
    await shot(page, "12-region-drag-reach-done");
    expect(await page.evaluate(() => window.__juntoCanvas!.reachMarks?.() ?? null), "the marks go with the drop").toBeNull();
  } finally {
    await junto.close();
  }
});
