// Section 7's look test: the same cards drawn by the DOM canvas and by the
// GPU engine must match within a tolerance, in both themes, across zooms.
// Each card's screen rectangle comes from the harness (DOM backend or the
// test hook), the page is clipped to it, and the two PNGs are compared
// pixel by pixel. Skips until the gpuCanvas build exposes the test hook, so
// it can never pass DOM against DOM.
//
// The fixture and kind list live in e2e/harness/gallery-fixture.ts; the
// state/tier matrix and the padded clip are canvas-verifier's half.

import { test, expect, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { launchJunto, type JuntoHandle } from "../harness/launch";
import { GALLERY_ENTRIES, GALLERY_IDS, GALLERY_IMAGE_BYTES, galleryFixture, type GalleryEntry } from "../harness/gallery-fixture";
import { writeFixtureContentObject } from "../harness/sandbox";
import { camera, cameraSettled, card, canvasReady, pane, type CanvasCamera } from "../harness/canvas";

const CANVAS = "factory";

// pngjs is a transitive dep (via qrcode) with no types; require it minimally.
interface PngImage {
  readonly width: number;
  readonly height: number;
  readonly data: Buffer;
}
const { PNG } = createRequire(import.meta.url)("pngjs") as {
  readonly PNG: { readonly sync: { read(buf: Buffer): PngImage } };
};
const VISUAL_DIR = join(process.cwd(), "test-results", "look-gallery");

export const IDS: ReadonlyArray<string> = GALLERY_IDS;
export const ZOOMS = [1, 0.5, 0.3, 0.15] as const;
export const THEMES = ["dark", "bright"] as const;

/** The app under one canvas: off = today's DOM, on = the GPU engine. */
const open = async (gpu: boolean): Promise<JuntoHandle> => {
  const junto = await launchJunto({
    seedModels: { [CANVAS]: galleryFixture },
    // gal-file-img's path is a junto-content:// URL; the object must be a
    // verified manifest row with bytes on disk or both canvases paint the
    // kind-seat fallback instead of the image branch.
    afterSeed: (sandbox) =>
      writeFixtureContentObject(sandbox, {
        bytes: GALLERY_IMAGE_BYTES,
        mediaType: "image/png",
        displayName: "cover.png",
      }).then(() => undefined),
    ...(gpu ? { seedExperimentalFeatures: ["gpuCanvas" as const] } : {}),
  });
  try {
    await canvasReady(junto.page);
    if (gpu) {
      // The feature can swap the canvas after first paint; wait for the hook
      // before deciding the arm is missing.
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
};

/** Electron can quit a launch that races the previous arm's teardown; one retry is the fix. */
const openRetry = async (gpu: boolean): Promise<JuntoHandle> => {
  let last: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await open(gpu);
    } catch (error) {
      last = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 5_000 * attempt));
    }
  }
  throw last;
};

const setTheme = async (page: Page, theme: (typeof THEMES)[number]): Promise<void> => {
  await page.evaluate((t) => window.junto!.settingsPatch({ appearance: { theme: t } }), theme);
  await expect
    .poll(() => page.locator("html").getAttribute("data-theme"), { timeout: 10_000 })
    .toBe(theme === "bright" ? "bright" : null);
};

/**
 * Put both arms at one exact camera. The zoom is the spec's; the pan is the
 * pane's centre on the board's origin, so a card lands on the same screen
 * pixel in both arms and the crops differ only by how each canvas draws.
 */
const placeCamera = async (page: Page, zoom: number): Promise<CanvasCamera> => {
  const box = await pane(page).box();
  if (box === null) throw new Error("no pane to place the camera in");
  const target = { x: box.width / 2, y: box.height / 2, zoom };
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
      const at = await camera(page);
      return Math.max(Math.abs(at.x - target.x), Math.abs(at.y - target.y), Math.abs(at.zoom - target.zoom));
    }, { message: `the camera lands exactly at zoom ${zoom}`, timeout: 10_000 })
    .toBeLessThanOrEqual(0.01);
  await page.waitForTimeout(SETTLE_MS);
  await cameraSettled(page);
  return target;
};

/** The card's shot, padded for its tag, shadow and selected outline. */
const PAD = { top: 8, right: 8, bottom: 10, left: 8 } as const;
/** A region is its title and frame, not the whole board it holds. */
const REGION_CLIP = { width: 420, height: 160 } as const;

const clampClip = (rect: { x: number; y: number; width: number; height: number }, paneRect: { x: number; y: number; width: number; height: number }) => {
  const x = Math.max(Math.ceil(paneRect.x), Math.floor(rect.x));
  const y = Math.max(Math.ceil(paneRect.y), Math.floor(rect.y));
  const right = Math.min(Math.floor(paneRect.x + paneRect.width), Math.ceil(rect.x + rect.width));
  const bottom = Math.min(Math.floor(paneRect.y + paneRect.height), Math.ceil(rect.y + rect.height));
  return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
};

interface Shot {
  readonly png: PngImage;
  /** The card's own screen origin: the pair must agree, so position stays tested. */
  readonly origin: { readonly x: number; readonly y: number };
}

const shotFor = async (page: Page, entry: GalleryEntry, dest?: string, bottom: number = PAD.bottom, top: number = PAD.top): Promise<Shot> => {
  const rect = await card(page, entry.id).box();
  if (rect === null) throw new Error(`card ${entry.id} has no rect`);
  const paneRect = await pane(page).box();
  if (paneRect === null) throw new Error("no canvas pane");
  const clip = entry.kind === "region"
    ? clampClip({ x: rect.x, y: rect.y, width: Math.min(rect.width, REGION_CLIP.width), height: Math.min(rect.height, REGION_CLIP.height) }, paneRect)
    : clampClip({ x: rect.x - PAD.left, y: rect.y - top, width: rect.width + PAD.left + PAD.right, height: rect.height + top + bottom }, paneRect);
  const buffer = await page.screenshot({ clip });
  if (dest !== undefined) await writeFile(dest, buffer);
  return { png: PNG.sync.read(buffer), origin: { x: rect.x, y: rect.y } };
};

const CARD_ENTRIES = GALLERY_ENTRIES.filter((entry) => entry.kind !== "region");
/** Selected and hovered are pointer states; far and overview keep the default card. */
const STATE_ZOOMS: ReadonlySet<number> = new Set([1, 0.5]);
/** Longer than the longest card transition (DURATION.state, 180 ms). */
const SETTLE_MS = 260;

/** Park the pointer on empty pane: clears the selection and every hover. */
const park = async (page: Page): Promise<void> => {
  await pane(page).click({ position: { x: 8, y: 8 } });
  await page.waitForTimeout(SETTLE_MS);
};

const channelClose = (a: PngImage, ai: number, b: PngImage, bi: number, tol: number): boolean =>
  Math.abs(a.data[ai]! - b.data[bi]!) <= tol &&
  Math.abs(a.data[ai + 1]! - b.data[bi + 1]!) <= tol &&
  Math.abs(a.data[ai + 2]! - b.data[bi + 2]!) <= tol;

/**
 * Fraction of pixels whose colour has no match in the other arm's 3 by 3
 * neighbourhood. Electron's text rasteriser leaves a little anti-aliasing
 * residue that is not a shape, colour, position or word difference; one
 * pixel of slack in every direction forgives it while a moved edge, a wrong
 * colour or different words still find no match.
 */
const mismatch = (a: PngImage, b: PngImage, label: string, tol = 24): number => {
  // A fractional card rect can round a clip one pixel apart between the two
  // backends; compare the overlap rather than failing on the clip arithmetic.
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

/** Capture one canvas from every theme, tier and state, keyed for the pair. */
const shoot = async (page: Page, save: boolean, prefix: "gpu" | "dom"): Promise<ReadonlyMap<string, Shot>> => {
  const shots = new Map<string, Shot>();
  if (save) await mkdir(VISUAL_DIR, { recursive: true });
  const key = (theme: string, zoom: number, state: string, entry: GalleryEntry): string =>
    `${theme}|${zoom}|${state}|${entry.kind}|${entry.id}`;

  for (const theme of THEMES) {
    await setTheme(page, theme);
    await page.waitForTimeout(SETTLE_MS);
    for (const zoom of ZOOMS) {
      await placeCamera(page, zoom);
      await park(page);
      for (const entry of GALLERY_ENTRIES) {
        const shotKey = key(theme, zoom, "default", entry);
        shots.set(shotKey, await shotFor(page, entry, save ? join(VISUAL_DIR, `${prefix}-${shotKey.replaceAll("|", "-")}.png`) : undefined, zoom <= 0.3 ? 14 : 10, zoom <= 0.3 ? 14 : PAD.top));
      }
      if (save) await page.screenshot({ path: join(VISUAL_DIR, `${prefix}-full-${theme}-${zoom}.png`) });
      if (!STATE_ZOOMS.has(zoom)) continue;

      for (const entry of CARD_ENTRIES) {
        await card(page, entry.id).click();
        // Keep the selection, drop the pointer hover: the card's hover chrome
        // is not the selected card, and the DOM popover would otherwise sit in
        // the clip.
        await page.mouse.move(8, 8);
        await page.waitForTimeout(SETTLE_MS);
        const shotKey = key(theme, zoom, "selected", entry);
        shots.set(shotKey, await shotFor(page, entry, save ? join(VISUAL_DIR, `${prefix}-${shotKey.replaceAll("|", "-")}.png`) : undefined, 10));
      }

      await park(page);
      for (const entry of CARD_ENTRIES) {
        const rect = await card(page, entry.id).box();
        if (rect === null) throw new Error(`card ${entry.id} has no rect to hover`);
        await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
        await page.waitForTimeout(SETTLE_MS);
        const shotKey = key(theme, zoom, "hovered", entry);
        shots.set(shotKey, await shotFor(page, entry, save ? join(VISUAL_DIR, `${prefix}-${shotKey.replaceAll("|", "-")}.png`) : undefined, 10));
      }
    }
  }
  return shots;
};

test("look gallery: GPU cards match the DOM cards in both themes, every tier, in card states", async () => {
  test.setTimeout(1_800_000);
  // One canvas at a time, the GPU first: two Electron apps racing for the
  // adapter on the same machine can leave the second on the DOM fallback
  // (no test hook), and a closed app's GPU process can linger for a moment.
  const gpu = await openRetry(true);
  let gpuShots: ReadonlyMap<string, Shot>;
  try {
    // The GPU run must really be the engine, never a DOM fallback.
    const hooked = await gpu.page.evaluate(() => typeof window.__juntoCanvas?.ready === "function");
    test.skip(!hooked, "window.__juntoCanvas absent — the GPU canvas is not in this build yet");
    gpuShots = await shoot(gpu.page, true, "gpu");
  } finally {
    await gpu.close();
  }
  // The closed arm's macOS quit event can still land on a launch that starts
  // in its shadow; give it room before the other arm boots.
  await new Promise((resolve) => setTimeout(resolve, 8_000));

  const dom = await openRetry(false);
  try {
    const domShots = await shoot(dom.page, true, "dom");
    const failures: string[] = [];
    const worst = new Map<string, number>();
    for (const [key, gpuShot] of gpuShots) {
      const domShot = domShots.get(key);
      if (domShot === undefined) {
        failures.push(`${key}: no DOM shot`);
        continue;
      }
      const dx = Math.abs(gpuShot.origin.x - domShot.origin.x);
      const dy = Math.abs(gpuShot.origin.y - domShot.origin.y);
      if (dx > 1 || dy > 1) failures.push(`${key}: card origins differ by ${dx.toFixed(2)}, ${dy.toFixed(2)} CSS px`);
      const bad = mismatch(gpuShot.png, domShot.png, key);
      const kind = key.split("|")[3] ?? "?";
      worst.set(kind, Math.max(worst.get(kind) ?? 0, bad));
      if (bad > 0.02) failures.push(`${key}: ${(bad * 100).toFixed(2)}% pixels differ`);
    }
    const summary = [...worst.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([kind, bad]) => `${kind}=${(bad * 100).toFixed(2)}%`)
      .join(" ");
    console.log(`GALLERY worst by kind: ${summary}`);
    expect(failures, failures.join("\n")).toEqual([]);
  } finally {
    await dom.close();
  }
});
