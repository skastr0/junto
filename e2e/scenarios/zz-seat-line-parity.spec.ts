/**
 * The seat status line parity proof (canvas-verifier's gap on
 * `dark|1|default|agent`): a still seat's line reads "fresh next" on the GPU
 * card exactly as the DOM card does, and a running seat's line matches too.
 * Real Electron pixels in both arms — the GPU engine first, then the DOM
 * canvas — cropped to each card's status-line band so a wrong word cannot
 * hide inside the card's pixel budget.
 *
 *   bun run test:e2e:fast e2e/scenarios/zz-seat-line-parity.spec.ts
 */
import { test, expect, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { launchJunto, type JuntoHandle } from "../harness/launch";
import { galleryFixture } from "../harness/gallery-fixture";
import { crewOccupySeat, crewPlayFactory, crewSeat, installCrewSeatHarness } from "../harness/crew-fixture";
import { card, canvasReady, pane } from "../harness/canvas";

const CANVAS = "factory";
const STILL = "gal-agent-a";
const RUNNER = "gal-agent-b";
const VISUAL_DIR = join(process.cwd(), "test-results", "seat-line-parity");

interface PngImage {
  readonly width: number;
  readonly height: number;
  readonly data: Buffer;
}
const { PNG } = createRequire(import.meta.url)("pngjs") as {
  readonly PNG: { readonly sync: { read(buf: Buffer): PngImage } };
};

const SETTLE_MS = 260;

const openRetry = async (gpu: boolean): Promise<JuntoHandle> => {
  let last: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const junto = await launchJunto({
        seedModels: { [CANVAS]: galleryFixture },
        afterSeed: installCrewSeatHarness,
        ...(gpu ? { seedExperimentalFeatures: ["gpuCanvas" as const] } : {}),
      });
      try {
        await canvasReady(junto.page);
        if (gpu) {
          await junto.page
            .waitForFunction(() => typeof window.__juntoCanvas?.ready === "function", undefined, { timeout: 30_000 })
            .catch(() => undefined);
          await canvasReady(junto.page);
        }
      } catch (error) {
        await junto.close().catch(() => undefined);
        throw error;
      }
      return junto;
    } catch (error) {
      last = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 3_000 * attempt));
    }
  }
  throw last;
};

const setDark = async (page: Page): Promise<void> => {
  await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "dark" } }));
  await page.waitForTimeout(SETTLE_MS);
};

/** Both arms at one exact camera: the pane's centre on the board's origin at zoom 1. */
const placeCamera = async (page: Page): Promise<void> => {
  const box = await pane(page).box();
  if (box === null) throw new Error("no pane to place the camera in");
  const target = { x: box.width / 2, y: box.height / 2, zoom: 1 };
  const placed = await page.evaluate((to) => {
    const gpu = window.__juntoCanvas;
    if (typeof gpu?.moveCamera === "function") {
      gpu.moveCamera(to);
      return "gpu";
    }
    if (window.__juntoDomCanvas !== undefined) {
      window.__juntoDomCanvas.moveCamera(to);
      return "dom";
    }
    return "";
  }, target);
  if (placed === "") throw new Error("this canvas has no test camera setter");
  await expect
    .poll(async () => {
      const at = await page.evaluate(() => {
        const gpu = window.__juntoCanvas;
        if (typeof gpu?.camera === "function") return gpu.camera();
        return window.__juntoDomCanvas?.camera() ?? { x: 0, y: 0, zoom: 0 };
      });
      return Math.max(Math.abs(at.x - target.x), Math.abs(at.y - target.y), Math.abs(at.zoom - target.zoom));
    }, { message: "the camera lands exactly at zoom 1", timeout: 10_000 })
    .toBeLessThanOrEqual(0.01);
  await page.waitForTimeout(SETTLE_MS);
};

const clampClip = (rect: { x: number; y: number; width: number; height: number }, paneRect: { x: number; y: number; width: number; height: number }) => {
  const x = Math.max(Math.ceil(paneRect.x), Math.floor(rect.x));
  const y = Math.max(Math.ceil(paneRect.y), Math.floor(rect.y));
  const right = Math.min(Math.floor(paneRect.x + paneRect.width), Math.ceil(rect.x + rect.width));
  const bottom = Math.min(Math.floor(paneRect.y + paneRect.height), Math.ceil(rect.y + rect.height));
  return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
};

/**
 * The status-line band of a seat card: the text column right of the ring,
 * below the name. A wrong word here is a large fraction of these pixels,
 * where inside the whole card it would hide under the 2% budget.
 */
const lineClip = async (page: Page, id: string): Promise<{ x: number; y: number; width: number; height: number }> => {
  const rect = await card(page, id).box();
  if (rect === null) throw new Error(`card ${id} has no rect`);
  const paneRect = await pane(page).box();
  if (paneRect === null) throw new Error("no canvas pane");
  return clampClip(
    { x: rect.x + 56, y: rect.y + 24, width: 156, height: 28 },
    paneRect,
  );
};

const shotPng = async (page: Page, clip: { x: number; y: number; width: number; height: number }, dest?: string): Promise<PngImage> => {
  const buffer = await page.screenshot({ clip });
  if (dest !== undefined) await writeFile(dest, buffer);
  return PNG.sync.read(buffer);
};

const channelClose = (a: PngImage, ai: number, b: PngImage, bi: number, tol: number): boolean =>
  Math.abs(a.data[ai]! - b.data[bi]!) <= tol &&
  Math.abs(a.data[ai + 1]! - b.data[bi + 1]!) <= tol &&
  Math.abs(a.data[ai + 2]! - b.data[bi + 2]!) <= tol;

/** Fraction of pixels with no colour match in the other arm's 3 by 3 neighbourhood (look-gallery's rule). */
const mismatch = (a: PngImage, b: PngImage, label: string, tol = 24): number => {
  expect(Math.abs(a.width - b.width), `${label} clip widths`).toBeLessThanOrEqual(3);
  expect(Math.abs(a.height - b.height), `${label} clip heights`).toBeLessThanOrEqual(3);
  const width = Math.min(a.width, b.width);
  const height = Math.min(a.height, b.height);
  let bad = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * a.width + x) * 4;
      let matched = false;
      for (let dy = -1; dy <= 1 && !matched; dy += 1) {
        const by = y + dy;
        if (by < 0 || by >= b.height) continue;
        for (let dx = -1; dx <= 1 && !matched; dx += 1) {
          const bx = x + dx;
          if (bx < 0 || bx >= b.width) continue;
          matched = channelClose(a, i, b, (by * b.width + bx) * 4, tol);
        }
      }
      if (!matched) bad += 1;
    }
  }
  return bad / (width * height);
};

interface Arm {
  readonly junto: JuntoHandle;
  readonly still: PngImage;
  readonly runner: PngImage;
}

/** One arm: the gallery canvas, the still seat's answer settled, one seat running. */
const arm = async (gpu: boolean): Promise<Arm> => {
  const junto = await openRetry(gpu);
  const prefix = gpu ? "gpu" : "dom";
  try {
    const { page } = junto;
    await setDark(page);
    await crewPlayFactory(page);
    const runner = crewSeat(junto.sandbox, CANVAS, RUNNER);
    await crewOccupySeat(page, CANVAS, { id: RUNNER }, runner);
    await runner.ready();
    await runner.control({ screen: { mode: "working" } });

    if (gpu) {
      // The feed asks main once per still seat; wait on the same answer the
      // card's hook reads, then settle for ask → op → paint.
      await expect
        .poll(
          () =>
            page
              .evaluate(async ([canvas, id]) => {
                const read = window.junto?.modelSeatLaunchState;
                if (read === undefined) return false;
                const answer = await read({ canvas, id }).catch(() => undefined);
                return answer?.nextTurn?.fresh === true;
              }, [CANVAS, STILL] as const),
          { timeout: 30_000 },
        )
        .toBe(true);
      await page.waitForTimeout(1_500);
    } else {
      await expect
        .poll(() => card(page, STILL).text(), { timeout: 30_000 })
        .toContain("fresh next");
      await expect
        .poll(() => card(page, RUNNER).text(), { timeout: 30_000 })
        .toMatch(/working|running/);
    }
    // The runner's state lands through the seat observer on both arms; the
    // DOM arm already waited on its words, the GPU arm settles the same beat.
    await page.waitForTimeout(gpu ? 3_500 : 500);

    await placeCamera(page);
    await page.waitForTimeout(SETTLE_MS);
    const stillClip = await lineClip(page, STILL);
    const runnerClip = await lineClip(page, RUNNER);
    const still = await shotPng(page, stillClip, join(VISUAL_DIR, `${prefix}-still-line.png`));
    const run = await shotPng(page, runnerClip, join(VISUAL_DIR, `${prefix}-runner-line.png`));
    return { junto, still, runner: run };
  } catch (error) {
    await junto.close().catch(() => undefined);
    throw error;
  }
};

test("the GPU seat line matches the DOM card: fresh next still, the state line running", async () => {
  test.setTimeout(300_000);
  await mkdir(VISUAL_DIR, { recursive: true });
  // One canvas at a time, GPU first: two Electron apps racing for the adapter
  // can leave the second on the DOM fallback (look-gallery's order).
  const gpu = await arm(true);
  await gpu.junto.close();
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  const dom = await arm(false);
  try {
    const stillBad = mismatch(gpu.still, dom.still, "still seat line");
    const runBad = mismatch(gpu.runner, dom.runner, "running seat line");
    console.log(`SEAT LINE parity: still=${(stillBad * 100).toFixed(2)}% runner=${(runBad * 100).toFixed(2)}%`);
    expect(stillBad, "the still seat's status line differs between GPU and DOM").toBeLessThanOrEqual(0.02);
    expect(runBad, "the running seat's status line differs between GPU and DOM").toBeLessThanOrEqual(0.02);
  } finally {
    await dom.junto.close();
  }
});
