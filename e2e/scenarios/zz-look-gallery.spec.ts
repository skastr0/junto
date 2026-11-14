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
import { GALLERY_IDS, galleryFixture } from "../harness/gallery-fixture";
import { camera, card, canvasReady, pane } from "../harness/canvas";

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
export const ZOOMS = [1, 0.6, 0.35] as const;
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
  const deadline = Date.now() + 10_000;
  for (;;) {
    const cam = await camera(page);
    if (Math.abs(cam.zoom - zoom) < 0.08) return;
    const box = await pane(page).box();
    if (box === null) throw new Error("no pane to zoom over");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, cam.zoom > zoom ? 240 : -240);
    if (Date.now() >= deadline) throw new Error(`camera never reached zoom ${zoom}`);
    await page.waitForTimeout(120);
  }
};

interface Shot { readonly id: string; readonly png: PngImage; }

const cardShot = async (page: Page, id: string): Promise<Shot> => {
  const rect = await card(page, id).box();
  if (rect === null) throw new Error(`card ${id} has no rect`);
  const buffer = await page.screenshot({
    clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
  });
  return { id, png: PNG.sync.read(buffer) };
};

/** Fraction of pixels whose channels differ by more than `tol`. */
const mismatch = (a: PngImage, b: PngImage, tol = 24): number => {
  expect(a.width).toBe(b.width);
  expect(a.height).toBe(b.height);
  let bad = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const d = Math.max(
      Math.abs(a.data[i]! - b.data[i]!),
      Math.abs(a.data[i + 1]! - b.data[i + 1]!),
      Math.abs(a.data[i + 2]! - b.data[i + 2]!),
    );
    if (d > tol) bad += 1;
  }
  return bad / (a.width * a.height);
};

test("look gallery: GPU cards match the DOM cards in both themes at three zooms", async () => {
  test.setTimeout(600_000);
  const dom = await open(false);
  const gpu = await open(true);
  try {
    // The GPU run must really be the engine, never a DOM fallback.
    const hooked = await gpu.page.evaluate(() => typeof window.__juntoCanvas?.ready === "function");
    test.skip(!hooked, "window.__juntoCanvas absent — the GPU canvas is not in this build yet");

    for (const theme of THEMES) {
      for (const zoom of ZOOMS) {
        await setTheme(dom.page, theme);
        await setTheme(gpu.page, theme);
        await zoomTo(dom.page, zoom);
        await zoomTo(gpu.page, zoom);
        for (const id of IDS) {
          const a = await cardShot(dom.page, id);
          const b = await cardShot(gpu.page, id);
          const bad = mismatch(a.png, b.png);
          expect(bad, `${theme} zoom=${zoom} card=${id}: ${(bad * 100).toFixed(2)}% pixels differ`).toBeLessThanOrEqual(0.02);
        }
      }
    }
  } finally {
    await dom.close();
    await gpu.close();
  }
});
