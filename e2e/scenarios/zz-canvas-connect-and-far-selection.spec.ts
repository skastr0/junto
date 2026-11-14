/**
 * Two QA bugs on the GPU canvas, proved in real Electron pixels.
 *
 * 1. A connect gesture landing on a card painted nothing: the snap resolved to
 *    the target card's nearer *source* dot, so the landing read as role
 *    "source" and no target indicator followed. Now the receiving card's
 *    landing side wears the DOM's `connectingto.valid` paint (second-colour
 *    dashed dot in a lit room) and the card takes a second-colour frame.
 * 2. At far and overview a seat is a held ring, most of it above the card's
 *    own box, and the selection toolbar was placed from the box: it landed
 *    across the ring's top half. The mirror now answers the ring.
 *
 *   bun run test:e2e:fast e2e/scenarios/zz-canvas-connect-and-far-selection.spec.ts
 */
import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { launchJunto, type JuntoHandle } from "../harness/launch";
import { modelFixture, modelSeat, type ModelFixture } from "../harness/model";
import { card, canvasReady, handle, pane } from "../harness/canvas";
import { themeGpu } from "../../src/shared/theme";

const CANVAS = "factory";
const VISUAL_DIR = join(process.cwd(), "lab", "connect-and-far-selection");
const SETTLE_MS = 320;

interface PngImage {
  readonly width: number;
  readonly height: number;
  readonly data: Buffer;
}
const { PNG } = createRequire(import.meta.url)("pngjs") as {
  readonly PNG: { readonly sync: { read(buf: Buffer): PngImage; write(image: PngImage): Buffer } };
};

const fixture: ModelFixture = modelFixture([
  modelSeat({ id: "ct-a", label: "Ada", x: -220, y: 40 }),
  modelSeat({ id: "ct-b", label: "Bex", x: 220, y: 40 }),
]);

const open = async (gpu: boolean): Promise<JuntoHandle> => {
  const junto = await launchJunto({
    seedModels: { [CANVAS]: fixture },
    ...(gpu ? { seedExperimentalFeatures: ["gpuCanvas" as const] } : {}),
  });
  await canvasReady(junto.page);
  if (gpu) {
    await junto.page
      .waitForFunction(() => typeof window.__juntoCanvas?.ready === "function", undefined, { timeout: 30_000 })
      .catch(() => undefined);
    await canvasReady(junto.page);
  }
  return junto;
};

const openRetry = async (gpu: boolean): Promise<JuntoHandle> => {
  let last: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const junto = await open(gpu);
      if (gpu) {
        const hooked = await junto.page.evaluate(() => typeof window.__juntoCanvas?.ready === "function");
        if (!hooked) {
          await junto.close();
          throw new Error("the GPU canvas did not come up");
        }
      }
      return junto;
    } catch (error) {
      last = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 5_000 * attempt));
    }
  }
  throw last;
};

const atlasSettled = async (page: Page): Promise<void> => {
  await page.waitForTimeout(200);
  await expect
    .poll(() => page.evaluate(() => window.__juntoCanvas?.atlasPending?.() ?? 0), { timeout: 20_000 })
    .toBe(0);
};

const placeCamera = async (page: Page, zoom: number): Promise<void> => {
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
    .poll(
      async () =>
        page.evaluate((to) => {
          const gpu = window.__juntoCanvas;
          const at = typeof gpu?.camera === "function" ? gpu.camera() : window.__juntoDomCanvas?.camera();
          if (at === undefined) return 1e9;
          return Math.max(Math.abs(at.x - to.x), Math.abs(at.y - to.y), Math.abs(at.zoom - to.zoom));
        }, target),
      { message: `the camera lands exactly at zoom ${zoom}`, timeout: 10_000 },
    )
    .toBeLessThanOrEqual(0.01);
  await page.waitForTimeout(SETTLE_MS);
  await atlasSettled(page);
};

const park = async (page: Page): Promise<void> => {
  await pane(page).click({ position: { x: 8, y: 8 } });
  await page.waitForTimeout(SETTLE_MS);
};

const setTheme = async (page: Page, theme: "dark" | "bright"): Promise<void> => {
  await page.evaluate((t) => window.junto!.settingsPatch({ appearance: { theme: t } }), theme);
  await expect
    .poll(() => page.locator("html").getAttribute("data-theme"), { timeout: 10_000 })
    .toBe(theme === "bright" ? "bright" : null);
  await atlasSettled(page);
};

const pad = (b: { x: number; y: number; width: number; height: number }, by: number) => ({
  x: Math.floor(b.x - by),
  y: Math.floor(b.y - by),
  width: Math.ceil(b.width + 2 * by),
  height: Math.ceil(b.height + 2 * by),
});

/** How many pixels carry the second colour (cyan) at all: the landing paint. */
const secondPixels = (image: PngImage, mode: "dark" | "bright", rows?: readonly [number, number]): number => {
  const { r, g, b } = themeGpu(mode).colors["second"]!;
  const [er, eg, eb] = [r * 255, g * 255, b * 255];
  let n = 0;
  const [top, bottom] = rows ?? [0, image.height];
  for (let y = Math.max(0, top); y < Math.min(image.height, bottom); y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const i = (y * image.width + x) * 4;
      const [pr, pg, pb] = [image.data[i]!, image.data[i + 1]!, image.data[i + 2]!];
      // The frame's stroke is 55% alpha, the dot's 95%: exact-colour matching
      // would only ever find the dot. A cyan cast is what both show, and the
      // amber main colour and the neutral ground both fail it.
      const cast = pb > pr + 22 && pg > pr + 14;
      const near = Math.hypot(pr - er, pg - eg, pb - eb) < 46;
      if (cast || near) n += 1;
    }
  }
  return n;
};

/** The card's top edge in the crop's device pixels: the crop is padded 14 CSS px. */
const topEdgeOf = (image: PngImage, cardWidth: number): readonly [number, number] => {
  const dpr = Math.max(1, Math.round(image.width / (cardWidth + 28)));
  // The frame is grown 2 board units past the card, so its top line sits 12 CSS
  // px into the 14 px pad; a few rows either way hold it at any rounding.
  return [11 * dpr, 17 * dpr];
};

const upscale = (image: PngImage, factor: number): PngImage => {
  const width = image.width * factor;
  const height = image.height * factor;
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const si = (Math.floor(y / factor) * image.width + Math.floor(x / factor)) * 4;
      const di = (y * width + x) * 4;
      data[di] = image.data[si]!;
      data[di + 1] = image.data[si + 1]!;
      data[di + 2] = image.data[si + 2]!;
      data[di + 3] = 255;
    }
  }
  return { width, height, data };
};

const sideBySide = (a: PngImage, b: PngImage, gap = 8): PngImage => {
  const height = Math.max(a.height, b.height);
  const width = a.width + gap + b.width;
  const data = Buffer.alloc(width * height * 4);
  const put = (image: PngImage, ox: number): void => {
    for (let y = 0; y < image.height; y += 1) {
      for (let x = 0; x < image.width; x += 1) {
        const si = (y * image.width + x) * 4;
        const di = (y * width + ox + x) * 4;
        data[di] = image.data[si]!;
        data[di + 1] = image.data[si + 1]!;
        data[di + 2] = image.data[si + 2]!;
        data[di + 3] = 255;
      }
    }
  };
  put(a, 0);
  put(b, a.width + gap);
  return { width, height, data };
};

test("a wire landing on a seat shows the landing on that seat", async () => {
  test.setTimeout(600_000);
  await mkdir(VISUAL_DIR, { recursive: true });
  const counts: Record<string, number> = {};
  for (const gpu of [true, false]) {
    const junto = await openRetry(gpu);
    const prefix = gpu ? "gpu" : "dom";
    try {
      const { page } = junto;
      await placeCamera(page, 1);
      await park(page);
      for (const theme of ["dark", "bright"] as const) {
        await setTheme(page, theme);
        const source = await handle(page, "ct-a", "right", "source").box();
        if (source === null) throw new Error("ct-a shows no right source handle");
        const target = await card(page, "ct-b").box();
        if (target === null) throw new Error("ct-b has no rect");
        // From the source dot to a point inside the target's border: the
        // landing is found by the snap or the body, never by a hovered dot.
        await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
        await page.mouse.down();
        await page.mouse.move(target.x + 34, target.y + target.height / 2, { steps: 10 });
        await page.waitForTimeout(SETTLE_MS);
        await atlasSettled(page);
        const clip = pad(target, 14);
        const buffer = await page.screenshot({ clip });
        await writeFile(join(VISUAL_DIR, `${prefix}-connect-${theme}.png`), buffer);
        const image = PNG.sync.read(buffer);
        counts[`${prefix}-${theme}`] = secondPixels(image, theme, topEdgeOf(image, target.width));
        counts[`${prefix}-${theme}-all`] = secondPixels(image, theme);
        await page.keyboard.press("Escape");
        await page.mouse.up();
        await page.waitForTimeout(SETTLE_MS);
      }
    } finally {
      await junto.close();
    }
    await new Promise((resolve) => setTimeout(resolve, 8_000));
  }
  console.log("connect landing, second-colour pixels (card top edge / whole crop):", counts);
  for (const theme of ["dark", "bright"]) {
    // The GPU's receiving card wears the second-colour frame across its top
    // edge; the DOM lights only the handle, so it has no frame to find.
    expect(counts[`gpu-${theme}`], `GPU ${theme} frame ${String(counts[`gpu-${theme}`])}`).toBeGreaterThan(300);
    expect(counts[`dom-${theme}`], `DOM ${theme} frame ${String(counts[`dom-${theme}`])}`).toBeLessThan(40);
    expect(counts[`gpu-${theme}-all`], `GPU ${theme} ${String(counts[`gpu-${theme}-all`])}`).toBeGreaterThan(800);
    expect(counts[`dom-${theme}-all`], `DOM ${theme} ${String(counts[`dom-${theme}-all`])}`).toBeGreaterThan(20);
    const gpuShot = PNG.sync.read(readFileSync(join(VISUAL_DIR, `gpu-connect-${theme}.png`)));
    const domShot = PNG.sync.read(readFileSync(join(VISUAL_DIR, `dom-connect-${theme}.png`)));
    await writeFile(
      join(VISUAL_DIR, `sheet-connect-${theme}.png`),
      PNG.sync.write(sideBySide(upscale(gpuShot, 4), upscale(domShot, 4))),
    );
  }
});

test("a far seat's selection toolbar clears the held ring", async () => {
  test.setTimeout(600_000);
  await mkdir(VISUAL_DIR, { recursive: true });
  const anchors: Record<string, { readonly top: number; readonly cardTop: number; readonly toolbarBottom: number }> = {};
  for (const gpu of [true, false]) {
    const junto = await openRetry(gpu);
    const prefix = gpu ? "gpu" : "dom";
    try {
      const { page } = junto;
      await setTheme(page, "dark");
      await placeCamera(page, 0.15);
      await park(page);
      await card(page, "ct-a").click();
      await page.waitForTimeout(SETTLE_MS + 200);
      await atlasSettled(page);
      const target = await card(page, "ct-a").box();
      if (target === null) throw new Error("ct-a has no rect");
      // The float is the GPU shell's overlay; the DOM arm keeps its toolbar in
      // React Flow and is shot for reference only.
      let box: { x: number; y: number; width: number; height: number } | null = null;
      if (gpu) {
        box = await page.locator('[data-canvas-overlay="selection-toolbar"]').boundingBox();
        if (box === null) throw new Error("no selection toolbar for a selected seat at far");
        // The seat's ring, worked out from the engine's own scale and camera,
        // never from the mirror the toolbar is placed from: the seat was
        // seeded at board y 40, its ring is 52 units centred 28 units in, and
        // the engine holds that ring at `seatScaleOf` units per unit.
        const paneBox = await pane(page).box();
        if (paneBox === null) throw new Error("no canvas pane");
        const view = await page.evaluate((id) => ({
          camera: window.__juntoCanvas?.camera?.(),
          scale: window.__juntoCanvas?.seatScaleOf?.(id),
          drawn: window.__juntoCanvas?.rectOf?.(id),
        }), "ct-a");
        const camera = view.camera;
        if (camera === undefined) throw new Error("the GPU canvas answered no camera");
        const scale = view.scale ?? 1;
        const ringTop = paneBox.y + camera.y + 68 * camera.zoom - (52 * scale * camera.zoom) / 2;
        anchors[prefix] = { top: box.y, cardTop: ringTop, toolbarBottom: box.y + box.height };
        console.log(
          `far ${prefix}: ring top ${ringTop.toFixed(2)} (scale ${scale}, drawn ${JSON.stringify(view.drawn)}),` +
            ` toolbar bottom ${(box.y + box.height).toFixed(2)}`,
        );
        // The toolbar is placed 8 above the rectangle the mirror answers, so a
        // bottom above the ring's top proves the answer was the ring.
        expect(box.y + box.height).toBeLessThanOrEqual(ringTop - 6);
      }
      const clip = {
        x: Math.floor(target.x - 90),
        y: Math.floor(Math.min(box?.y ?? target.y, target.y) - 30),
        width: 260,
        height: 200,
      };
      await writeFile(join(VISUAL_DIR, `${prefix}-far-seat.png`), await page.screenshot({ clip }));
    } finally {
      await junto.close();
    }
    await new Promise((resolve) => setTimeout(resolve, 8_000));
  }
  console.log("far seat anchors:", anchors);
  const gpu = anchors["gpu"]!;
  // Anchored to the card box the toolbar's bottom sat 8 px inside the ring's
  // top half; anchored to the ring it clears it.
  expect(gpu.toolbarBottom).toBeLessThan(gpu.cardTop - 6);
  const gpuShot = PNG.sync.read(readFileSync(join(VISUAL_DIR, "gpu-far-seat.png")));
  const domShot = PNG.sync.read(readFileSync(join(VISUAL_DIR, "dom-far-seat.png")));
  await writeFile(join(VISUAL_DIR, "sheet-far-seat.png"), PNG.sync.write(sideBySide(upscale(gpuShot, 3), upscale(domShot, 3))));
});
