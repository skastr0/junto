/**
 * The GPU cull draws what the CPU list draws (issue 917), proved on Electron
 * pixels. Same board, same cameras: the CPU arm and the GPU arm are each
 * screenshotted at rest at near, mid and far, and every pixel that does not
 * move between frames must match.
 *
 * The GPU arm once wrote each band's base as an indirect draw's
 * firstInstance, which needs the optional indirect-first-instance feature; on
 * a device without it the draw is a no-op, and the GPU arm drew no seats,
 * notes or badges while regions drew over and over. Counting frames never saw
 * it; these pixels do.
 *
 * Rings turn and pulse every display frame, and the motion law keeps them
 * turning here too, so a pixel that changes between three frames of one arm
 * is motion and is left out of the comparison (with a few pixels' margin).
 *
 * Run: bun run test:e2e fast e2e/scenarios/gpu-cull-parity.spec.ts
 */

import { expect, test, type Page } from "@playwright/test";
import { createRequire } from "node:module";
import { cameraSettled, canvasReady, pane } from "../harness/canvas";
import { launchJunto } from "../harness/launch";
import { modelFixture, modelNote, modelRegion, modelSeat } from "../harness/model";

interface PngImage {
  readonly width: number;
  readonly height: number;
  readonly data: Buffer;
}
const { PNG } = createRequire(import.meta.url)("pngjs") as {
  readonly PNG: { readonly sync: { read(buf: Buffer): PngImage } };
};

const CANVAS = "factory";
type Rect = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
type Mode = "cpu" | "gpu";

/** A board with every band: regions behind, seats and notes in front, a cluster at far. */
const board = () => {
  const nodes = [
    modelRegion({ id: "region-a", label: "Alpha", x: 0, y: 0, width: 1400, height: 900 }),
    modelRegion({ id: "region-b", label: "Beta", x: 1600, y: 0, width: 1200, height: 900 }),
  ];
  for (let i = 0; i < 12; i += 1) {
    const id = `seat-${String(i)}`;
    nodes.push(modelSeat({ id, key: `local:${id}`, bindingId: `local:${id}`, label: `Seat ${String(i)}`, x: 80 + (i % 4) * 300, y: 120 + Math.floor(i / 4) * 240 }) as never);
  }
  // A tight triplet in region B gathers into a badge at far.
  for (let i = 0; i < 3; i += 1) {
    const id = `tight-${String(i)}`;
    nodes.push(modelSeat({ id, key: `local:${id}`, bindingId: `local:${id}`, label: `T${String(i)}`, x: 1900 + i * 40, y: 300 }) as never);
  }
  for (let i = 0; i < 4; i += 1) nodes.push(modelNote(`note-${String(i)}`, `Note ${String(i)}: the GPU arm draws this`, 1700 + (i % 2) * 520, 560 + Math.floor(i / 2) * 160) as never);
  return modelFixture(nodes);
};

const shot = async (page: Page, clip: Rect): Promise<PngImage> => PNG.sync.read(await page.screenshot({ clip, scale: "css" }));

const frames = (page: Page, count: number): Promise<void> =>
  page.evaluate(
    (n) =>
      new Promise<void>((resolve) => {
        let left = n;
        const step = (): void => {
          left -= 1;
          if (left <= 0) resolve();
          else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }),
    count,
  );

/** Atlas work done and nothing on screen waiting for a cell. */
const atRest = async (page: Page): Promise<void> => {
  await cameraSettled(page);
  await page.waitForFunction(
    () => {
      const hook = window.__juntoCanvas as unknown as { atlasPending?: () => number; atlasStats?: () => { visibleBlank?: number } };
      return (hook.atlasPending?.() ?? 0) === 0 && (hook.atlasStats?.().visibleBlank ?? 0) === 0;
    },
    undefined,
    { timeout: 30_000 },
  );
  await frames(page, 6);
};

const cullFrames = (page: Page): Promise<{ gpu: number; standalone: number }> =>
  page.evaluate(() => {
    const stats = window.__juntoCanvas!.stats() as { cullFrames?: { gpu: number; standalone: number } };
    return stats.cullFrames ?? { gpu: 0, standalone: 0 };
  });

const setCull = (page: Page, mode: Mode): Promise<void> =>
  page.evaluate((m) => (window.__juntoCanvas as unknown as { setCull: (mode: Mode) => void }).setCull(m), mode);

/** Three shots of one arm, a few frames apart. */
const arm = async (page: Page, clip: Rect): Promise<PngImage[]> => {
  const out: PngImage[] = [];
  for (let i = 0; i < 3; i += 1) {
    out.push(await shot(page, clip));
    await frames(page, 3);
  }
  return out;
};

const TOLERANCE = 6;
/** The share of still pixels the two arms may differ in. */
const OFF_SHARE = 0.001;
/**
 * The ink a frame must carry for the comparison to mean anything: ten times
 * the share allowed to differ, so a GPU arm that drew no cards fails it by
 * an order of magnitude. A near frame of seats on a pale region inks about
 * 5% on the mini.
 */
const MIN_INK = 10 * OFF_SHARE;
const differs = (a: PngImage, b: PngImage, at: number): boolean =>
  Math.abs(a.data[at]! - b.data[at]!) > TOLERANCE ||
  Math.abs(a.data[at + 1]! - b.data[at + 1]!) > TOLERANCE ||
  Math.abs(a.data[at + 2]! - b.data[at + 2]!) > TOLERANCE;

/** Pixels that change between frames of either arm, grown by a margin. */
const motionMask = (shots: ReadonlyArray<PngImage>, grow: number): Uint8Array => {
  const { width, height } = shots[0]!;
  const moved = new Uint8Array(width * height);
  for (let i = 1; i < shots.length; i += 1) {
    for (let p = 0; p < width * height; p += 1) if (differs(shots[0]!, shots[i]!, p * 4)) moved[p] = 1;
  }
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (moved[y * width + x] !== 1) continue;
      for (let dy = -grow; dy <= grow; dy += 1) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (let dx = -grow; dx <= grow; dx += 1) {
          const xx = x + dx;
          if (xx >= 0 && xx < width) mask[yy * width + xx] = 1;
        }
      }
    }
  }
  return mask;
};

/** The share of pixels unlike the frame's top-left corner (the board's ground): proof the frame draws the board. */
const inkShare = (png: PngImage): number => {
  const ground = cornerOf(png);
  let ink = 0;
  for (let p = 0; p < png.width * png.height; p += 1) if (differs(png, ground, p * 4)) ink += 1;
  return ink / (png.width * png.height);
};
const cornerOf = (png: PngImage): PngImage => {
  const data = Buffer.alloc(png.data.length);
  for (let p = 0; p < png.width * png.height; p += 1) png.data.copy(data, p * 4, 0, 4);
  return { width: png.width, height: png.height, data };
};

const CAMERAS = [
  { name: "near", zoom: 1, at: { x: 500, y: 350 } },
  { name: "mid", zoom: 0.5, at: { x: 900, y: 450 } },
  { name: "far", zoom: 0.2, at: { x: 1400, y: 450 } },
] as const;

test("the GPU cull draws the same pixels as the CPU list at near, mid and far", async () => {
  test.setTimeout(240_000);
  const junto = await launchJunto({ seedModels: { [CANVAS]: board() }, seedExperimentalFeatures: ["gpuCanvas"] });
  try {
    const { page } = junto;
    await canvasReady(page);
    await page.waitForFunction(() => typeof window.__juntoCanvas?.ready === "function", undefined, { timeout: 30_000 }).catch(() => undefined);
    test.skip(!(await page.evaluate(() => typeof window.__juntoCanvas?.ready === "function")), "no GPU canvas hook in this build");
    const box = await pane(page).box();
    if (box === null) throw new Error("no canvas pane");
    const clip = { x: Math.ceil(box.x), y: Math.ceil(box.y), width: Math.floor(box.width), height: Math.floor(box.height) };

    for (const camera of CAMERAS) {
      await page.evaluate(
        ({ zoom, at, w, h }) => window.__juntoCanvas!.moveCamera?.({ zoom, x: w / 2 - at.x * zoom, y: h / 2 - at.y * zoom }),
        { zoom: camera.zoom, at: camera.at, w: box.width, h: box.height },
      );
      await setCull(page, "cpu");
      await atRest(page);
      const cpu = await arm(page, clip);

      const before = await cullFrames(page);
      await setCull(page, "gpu");
      await atRest(page);
      const gpu = await arm(page, clip);
      const after = await cullFrames(page);
      await setCull(page, "cpu");

      expect(after.gpu - before.gpu, `${camera.name}: the compute pass culled the frames the GPU arm drew`).toBeGreaterThan(0);
      expect(after.standalone - before.standalone, `${camera.name}: no frame fell back to the CPU list`).toBe(0);
      expect(inkShare(cpu[0]!), `${camera.name}: the CPU arm draws the board`).toBeGreaterThan(MIN_INK);

      const mask = motionMask(cpu, 3);
      const gpuMask = motionMask(gpu, 3);
      const { width, height } = cpu[0]!;
      let compared = 0;
      let off = 0;
      for (let p = 0; p < width * height; p += 1) {
        if (mask[p] === 1 || gpuMask[p] === 1) continue;
        compared += 1;
        if (differs(cpu[0]!, gpu[0]!, p * 4)) off += 1;
      }
      // Most of the frame is still; the comparison is meaningless otherwise.
      expect(compared / (width * height), `${camera.name}: most of the frame is still`).toBeGreaterThan(0.5);
      expect(off / Math.max(1, compared), `${camera.name}: ${String(off)} of ${String(compared)} still pixels differ`).toBeLessThan(OFF_SHARE);
    }
  } finally {
    await junto.close();
  }
});
