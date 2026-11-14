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
import { GALLERY_ENTRIES, GALLERY_IDS, galleryFixture, type GalleryEntry } from "../harness/gallery-fixture";
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
    ...(gpu ? { seedExperimentalFeatures: ["gpuCanvas" as const] } : {}),
  });
  await canvasReady(junto.page);
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
  for (;;) {
    const cam = await camera(page);
    if (Math.abs(cam.zoom - zoom) < 0.008) break;
    const box = await pane(page).box();
    if (box === null) throw new Error("no pane to zoom over");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, cam.zoom > zoom ? 180 : -180);
    if (Date.now() >= deadline) throw new Error(`camera never reached zoom ${zoom} (at ${cam.zoom})`);
    await page.waitForTimeout(80);
  }
  await cameraSettled(page);
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
const mismatch = (a: PngImage, b: PngImage, tol = 24): number => {
  // A fractional card rect can round a clip one pixel apart between the two
  // backends; compare the overlap rather than failing on the clip arithmetic.
  expect(Math.abs(a.width - b.width), "clip widths").toBeLessThanOrEqual(1);
  expect(Math.abs(a.height - b.height), "clip heights").toBeLessThanOrEqual(1);
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

test("look gallery: GPU cards match the DOM cards in both themes, every tier, in card states", async () => {
  test.setTimeout(1_200_000);
  const dom = await open(false);
  const gpu = await open(true);
  try {
    // The GPU run must really be the engine, never a DOM fallback.
    const hooked = await gpu.page.evaluate(() => typeof window.__juntoCanvas?.ready === "function");
    test.skip(!hooked, "window.__juntoCanvas absent — the GPU canvas is not in this build yet");

    const compare = async (entry: GalleryEntry, theme: string, zoom: number, state: string): Promise<void> => {
      const a = await shotFor(dom.page, entry);
      const b = await shotFor(gpu.page, entry);
      const bad = mismatch(a, b);
      expect(
        bad,
        `${theme} zoom=${zoom} ${entry.kind} ${entry.id} ${state}: ${(bad * 100).toFixed(2)}% pixels differ`,
      ).toBeLessThanOrEqual(0.02);
    };

    for (const theme of THEMES) {
      await setTheme(dom.page, theme);
      await setTheme(gpu.page, theme);
      await dom.page.waitForTimeout(SETTLE_MS);
      await gpu.page.waitForTimeout(SETTLE_MS);
      for (const zoom of ZOOMS) {
        await zoomTo(dom.page, zoom);
        await zoomTo(gpu.page, zoom);
        await park(dom.page);
        await park(gpu.page);

        for (const entry of GALLERY_ENTRIES) {
          await compare(entry, theme, zoom, "default");
        }
        if (!STATE_ZOOMS.has(zoom)) continue;

        for (const entry of CARD_ENTRIES) {
          await card(dom.page, entry.id).click();
          await card(gpu.page, entry.id).click();
          await dom.page.waitForTimeout(SETTLE_MS);
          await gpu.page.waitForTimeout(SETTLE_MS);
          await compare(entry, theme, zoom, "selected");
        }

        await park(dom.page);
        await park(gpu.page);
        for (const entry of CARD_ENTRIES) {
          for (const page of [dom.page, gpu.page]) {
            const rect = await card(page, entry.id).box();
            if (rect === null) throw new Error(`card ${entry.id} has no rect to hover`);
            await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
          }
          await dom.page.waitForTimeout(SETTLE_MS);
          await gpu.page.waitForTimeout(SETTLE_MS);
          await compare(entry, theme, zoom, "hovered");
        }
      }
    }
  } finally {
    await dom.close();
    await gpu.close();
  }
});
