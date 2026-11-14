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
import { createRequire } from "node:module";
import { launchJunto, type JuntoHandle } from "../harness/launch";
import { GALLERY_ENTRIES, GALLERY_IDS, GALLERY_IMAGE_BYTES, galleryFixture, type GalleryEntry } from "../harness/gallery-fixture";
import { writeFixtureContentObject } from "../harness/sandbox";
import { camera, cameraSettled, card, canvasReady, pane } from "../harness/canvas";

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
  await canvasReady(junto.page);
  if (gpu) {
    // The feature can swap the canvas after first paint; wait for the hook
    // before deciding the arm is missing.
    await junto.page
      .waitForFunction(() => typeof window.__juntoCanvas?.ready === "function", undefined, { timeout: 30_000 })
      .catch(() => undefined);
    await canvasReady(junto.page);
  }
  return junto;
};

const setTheme = async (page: Page, theme: (typeof THEMES)[number]): Promise<void> => {
  await page.evaluate((t) => window.junto!.settingsPatch({ appearance: { theme: t } }), theme);
  await expect
    .poll(() => page.locator("html").getAttribute("data-theme"), { timeout: 10_000 })
    .toBe(theme === "bright" ? "bright" : null);
};

/** Wheel the camera toward a zoom, then let it settle. */
const zoomTo = async (page: Page, zoom: number): Promise<void> => {
  const deadline = Date.now() + 20_000;
  const cdp = await page.context().newCDPSession(page);
  try {
    for (;;) {
      const cam = await camera(page);
      if (Math.abs(cam.zoom - zoom) < 0.005) break;
      const box = await pane(page).box();
      if (box === null) throw new Error("no pane to zoom over");
      // Ctrl+wheel is the browser's zoom gesture (a macOS pinch, ten times
      // faster); a bare wheel pans. Size the step from the multiplicative
      // wheel law so it lands on the target instead of overshooting forever.
      const factor = 0.002 * 10;
      const delta = -Math.log2(zoom / cam.zoom) / factor;
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: box.x + box.width / 2,
        y: box.y + box.height / 2,
        deltaX: 0,
        deltaY: Math.max(-240, Math.min(240, delta)),
        modifiers: 2,
      });
      if (Date.now() >= deadline) throw new Error(`camera never reached zoom ${zoom} (at ${cam.zoom})`);
      await page.waitForTimeout(80);
    }
    await cameraSettled(page);
  } finally {
    await cdp.detach();
  }
};

/** The card's shot, padded for its tag, shadow and selected outline. */
const PAD = { top: 10, right: 14, bottom: 56, left: 14 } as const;
/** A region is its title and frame, not the whole board it holds. */
const REGION_CLIP = { width: 420, height: 160 } as const;

const clampClip = (rect: { x: number; y: number; width: number; height: number }, paneRect: { x: number; y: number; width: number; height: number }) => {
  const x = Math.max(Math.ceil(paneRect.x), Math.floor(rect.x));
  const y = Math.max(Math.ceil(paneRect.y), Math.floor(rect.y));
  const right = Math.min(Math.floor(paneRect.x + paneRect.width), Math.ceil(rect.x + rect.width));
  const bottom = Math.min(Math.floor(paneRect.y + paneRect.height), Math.ceil(rect.y + rect.height));
  return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
};

const shotFor = async (page: Page, entry: GalleryEntry): Promise<PngImage> => {
  const rect = await card(page, entry.id).box();
  if (rect === null) throw new Error(`card ${entry.id} has no rect`);
  const paneRect = await pane(page).box();
  if (paneRect === null) throw new Error("no canvas pane");
  const clip = entry.kind === "region"
    ? clampClip({ x: rect.x, y: rect.y, width: Math.min(rect.width, REGION_CLIP.width), height: Math.min(rect.height, REGION_CLIP.height) }, paneRect)
    : clampClip({ x: rect.x - PAD.left, y: rect.y - PAD.top, width: rect.width + PAD.left + PAD.right, height: rect.height + PAD.top + PAD.bottom }, paneRect);
  const buffer = await page.screenshot({ clip });
  return PNG.sync.read(buffer);
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

/** Fraction of pixels whose channels differ by more than `tol`. */
const mismatch = (a: PngImage, b: PngImage, label: string, tol = 24): number => {
  // A fractional card rect can round a clip one pixel apart between the two
  // backends; compare the overlap rather than failing on the clip arithmetic.
  expect(Math.abs(a.width - b.width), `${label} clip widths`).toBeLessThanOrEqual(1);
  expect(Math.abs(a.height - b.height), `${label} clip heights`).toBeLessThanOrEqual(1);
  const width = Math.min(a.width, b.width);
  const height = Math.min(a.height, b.height);
  let bad = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * a.width + x) * 4;
      const j = (y * b.width + x) * 4;
      const d = Math.max(
        Math.abs(a.data[i]! - b.data[j]!),
        Math.abs(a.data[i + 1]! - b.data[j + 1]!),
        Math.abs(a.data[i + 2]! - b.data[j + 2]!),
      );
      if (d > tol) bad += 1;
    }
  }
  return bad / (width * height);
};

/** Capture one canvas from every theme, tier and state, keyed for the pair. */
const shoot = async (page: Page): Promise<ReadonlyMap<string, PngImage>> => {
  const shots = new Map<string, PngImage>();
  const key = (theme: string, zoom: number, state: string, entry: GalleryEntry): string =>
    `${theme}|${zoom}|${state}|${entry.kind}|${entry.id}`;

  for (const theme of THEMES) {
    await setTheme(page, theme);
    await page.waitForTimeout(SETTLE_MS);
    for (const zoom of ZOOMS) {
      await zoomTo(page, zoom);
      await park(page);
      for (const entry of GALLERY_ENTRIES) {
        shots.set(key(theme, zoom, "default", entry), await shotFor(page, entry));
      }
      if (!STATE_ZOOMS.has(zoom)) continue;

      for (const entry of CARD_ENTRIES) {
        await card(page, entry.id).click();
        await page.waitForTimeout(SETTLE_MS);
        shots.set(key(theme, zoom, "selected", entry), await shotFor(page, entry));
      }

      await park(page);
      for (const entry of CARD_ENTRIES) {
        const rect = await card(page, entry.id).box();
        if (rect === null) throw new Error(`card ${entry.id} has no rect to hover`);
        await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
        await page.waitForTimeout(SETTLE_MS);
        shots.set(key(theme, zoom, "hovered", entry), await shotFor(page, entry));
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
  const gpu = await open(true);
  let gpuShots: ReadonlyMap<string, PngImage>;
  try {
    // The GPU run must really be the engine, never a DOM fallback.
    const hooked = await gpu.page.evaluate(() => typeof window.__juntoCanvas?.ready === "function");
    test.skip(!hooked, "window.__juntoCanvas absent — the GPU canvas is not in this build yet");
    gpuShots = await shoot(gpu.page);
  } finally {
    await gpu.close();
  }
  await new Promise((resolve) => setTimeout(resolve, 2_000));

  const dom = await open(false);
  try {
    const domShots = await shoot(dom.page);
    for (const [key, gpuPng] of gpuShots) {
      const domPng = domShots.get(key);
      expect(domPng, `no DOM shot for ${key}`).toBeDefined();
      const bad = mismatch(gpuPng, domPng!, key);
      expect(bad, `${key}: ${(bad * 100).toFixed(2)}% pixels differ`).toBeLessThanOrEqual(0.02);
    }
  } finally {
    await dom.close();
  }
});
