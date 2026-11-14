/**
 * The spine halo proof: the DOM paints every spine row's words with
 * `text-shadow: 0 0 5px var(--color-ground)` twice (spine-card.css), a soft
 * ground wash behind the glyphs that keeps a word legible over the card's own
 * busy ground. The GPU canvas has to lay down the same wash. This spec shoots
 * the spine cards in both arms, both themes, at zoom 1 and 0.5, and prints the
 * pair's diff; the crops stay on disk for the eye and for a before/after pair.
 *
 *   HALO_ARM=before bun run test:e2e:fast e2e/scenarios/zz-spine-halo.spec.ts
 */
import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { launchJunto, type JuntoHandle } from "../harness/launch";
import { GALLERY_IMAGE_BYTES, galleryFixture } from "../harness/gallery-fixture";
import { modelFixture, modelLabel, modelNote, modelSeat, modelWire, type ModelFixture } from "../harness/model";
import { writeFixtureContentObject } from "../harness/sandbox";
import { card, canvasReady, pane } from "../harness/canvas";

const CANVAS = "factory";
const ARM = process.env.HALO_ARM ?? "before";
const VISUAL_DIR = join(process.cwd(), "lab", "spine-halo", ARM);
const THEMES = ["dark", "bright"] as const;
const ZOOMS = [1, 0.5] as const;
const SETTLE_MS = 260;

/** The spine cards: their rows carry the halo runs. Labels and notes ride along. */
const CARDS: ReadonlyArray<string> = ["gal-peer", "gal-stub", "gal-task", "gal-artifacts", "gal-git", "gal-note", "gal-label"];
const PAD = { top: 8, right: 8, bottom: 10, left: 8 } as const;

interface PngImage {
  readonly width: number;
  readonly height: number;
  readonly data: Buffer;
}
const { PNG } = createRequire(import.meta.url)("pngjs") as {
  readonly PNG: { readonly sync: { read(buf: Buffer): PngImage; write(image: PngImage): Buffer } };
};

interface Crop {
  readonly id: string;
  readonly theme: string;
  readonly zoom: number;
  readonly width: number;
  readonly height: number;
}

const open = async (gpu: boolean, fixture: ModelFixture = galleryFixture): Promise<JuntoHandle> => {
  const junto = await launchJunto({
    seedModels: { [CANVAS]: fixture },
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

const openRetry = async (gpu: boolean, fixture: ModelFixture = galleryFixture): Promise<JuntoHandle> => {
  let last: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await open(gpu, fixture);
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

const setTheme = async (page: Page, theme: (typeof THEMES)[number]): Promise<void> => {
  await page.evaluate((t) => window.junto!.settingsPatch({ appearance: { theme: t } }), theme);
  await expect
    .poll(() => page.locator("html").getAttribute("data-theme"), { timeout: 10_000 })
    .toBe(theme === "bright" ? "bright" : null);
  await atlasSettled(page);
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

const clampClip = (
  rect: { x: number; y: number; width: number; height: number },
  paneRect: { x: number; y: number; width: number; height: number },
) => {
  const x = Math.max(Math.ceil(paneRect.x), Math.floor(rect.x));
  const y = Math.max(Math.ceil(paneRect.y), Math.floor(rect.y));
  const right = Math.min(Math.floor(paneRect.x + paneRect.width), Math.ceil(rect.x + rect.width));
  const bottom = Math.min(Math.floor(paneRect.y + paneRect.height), Math.ceil(rect.y + rect.height));
  return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
};

const shoot = async (page: Page, prefix: string, cards: ReadonlyArray<string>): Promise<Crop[]> => {
  const crops: Crop[] = [];
  for (const theme of THEMES) {
    await setTheme(page, theme);
    await page.waitForTimeout(SETTLE_MS);
    for (const zoom of ZOOMS) {
      await placeCamera(page, zoom);
      await park(page);
      await page.screenshot({ path: join(VISUAL_DIR, `${prefix}-${theme}-${zoom}-full.png`) });
      for (const id of cards) {
        const rect = await card(page, id).box();
        if (rect === null) throw new Error(`card ${id} has no rect`);
        const paneRect = await pane(page).box();
        if (paneRect === null) throw new Error("no canvas pane");
        const clip = clampClip(
          {
            x: rect.x - PAD.left,
            y: rect.y - PAD.top,
            width: rect.width + PAD.left + PAD.right,
            height: rect.height + PAD.top + PAD.bottom,
          },
          paneRect,
        );
        const buffer = await page.screenshot({ clip });
        await writeFile(join(VISUAL_DIR, `${prefix}-${theme}-${zoom}-${id}.png`), buffer);
        crops.push({ id, theme, zoom, width: clip.width, height: clip.height });
      }
    }
  }
  return crops;
};

const read = (prefix: string, crop: Crop): PngImage =>
  PNG.sync.read(readFileSync(join(VISUAL_DIR, `${prefix}-${crop.theme}-${crop.zoom}-${crop.id}.png`)));

const lum = (data: Buffer, i: number): number =>
  0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!;

/** The pair, aligned within a pixel, and the wash it shows: how many pixels sit
 *  between the ground and the glyphs' ink — the halo's own territory. */
const compare = (a: PngImage, b: PngImage): { mean: number; over8: number; max: number; shift: [number, number] } => {
  let best = { mean: Infinity, shift: [0, 0] as [number, number] };
  for (let dy = -2; dy <= 2; dy += 1) {
    for (let dx = -2; dx <= 2; dx += 1) {
      let sum = 0;
      let n = 0;
      for (let y = Math.max(0, -dy); y < Math.min(a.height, b.height - dy); y += 1) {
        for (let x = Math.max(0, -dx); x < Math.min(a.width, b.width - dx); x += 1) {
          const ai = (y * a.width + x) * 4;
          const bi = ((y + dy) * b.width + (x + dx)) * 4;
          sum += Math.abs(lum(a.data, ai) - lum(b.data, bi));
          n += 1;
        }
      }
      const mean = sum / Math.max(1, n);
      if (mean < best.mean) best = { mean, shift: [dx, dy] };
    }
  }
  const [dx, dy] = best.shift;
  let diffSum = 0;
  let diffMax = 0;
  let over8 = 0;
  let n = 0;
  for (let y = Math.max(0, -dy); y < Math.min(a.height, b.height - dy); y += 1) {
    for (let x = Math.max(0, -dx); x < Math.min(a.width, b.width - dx); x += 1) {
      const ai = (y * a.width + x) * 4;
      const bi = ((y + dy) * b.width + (x + dx)) * 4;
      const d = Math.max(
        Math.abs(a.data[ai]! - b.data[bi]!),
        Math.abs(a.data[ai + 1]! - b.data[bi + 1]!),
        Math.abs(a.data[ai + 2]! - b.data[bi + 2]!),
      );
      diffSum += d;
      diffMax = Math.max(diffMax, d);
      if (d > 8) over8 += 1;
      n += 1;
    }
  }
  return { mean: diffSum / Math.max(1, n), over8: over8 / Math.max(1, n), max: diffMax, shift: best.shift };
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

/** Both arms on one fixture, then the pair's numbers and a 4x sheet each. */
const pair = async (fixture: ModelFixture, cards: ReadonlyArray<string>, label: string, asset: string): Promise<void> => {
  const gpu = await openRetry(true, fixture);
  let gpuCrops: Crop[];
  try {
    const hooked = await gpu.page.evaluate(() => typeof window.__juntoCanvas?.ready === "function");
    test.skip(!hooked, "window.__juntoCanvas absent — the GPU canvas is not in this build yet");
    gpuCrops = await shoot(gpu.page, `gpu-${asset}`, cards);
  } finally {
    await gpu.close();
  }
  await new Promise((resolve) => setTimeout(resolve, 8_000));

  const dom = await openRetry(false, fixture);
  let domCrops: Crop[];
  try {
    domCrops = await shoot(dom.page, `dom-${asset}`, cards);
  } finally {
    await dom.close();
  }

  console.log(`\n${label} ${ARM}: GPU versus DOM, 1:1 crops (mean abs channel delta over the card)`);
  for (const gpuCrop of gpuCrops) {
    const domCrop = domCrops.find((c) => c.id === gpuCrop.id && c.theme === gpuCrop.theme && c.zoom === gpuCrop.zoom);
    if (domCrop === undefined) throw new Error(`no DOM crop for ${gpuCrop.theme} ${gpuCrop.zoom} ${gpuCrop.id}`);
    const a = read(`gpu-${asset}`, gpuCrop);
    const b = read(`dom-${asset}`, domCrop);
    const stats = compare(a, b);
    console.log(
      `  ${gpuCrop.theme.padEnd(6)} z${String(gpuCrop.zoom).padEnd(4)} ${gpuCrop.id.padEnd(14)}` +
        ` mean ${stats.mean.toFixed(2)}  >8 ${(stats.over8 * 100).toFixed(2)}%  max ${stats.max}` +
        `  shift ${stats.shift[0]},${stats.shift[1]}`,
    );
    await writeFile(
      join(VISUAL_DIR, `sheet-${asset}-${gpuCrop.theme}-${gpuCrop.zoom}-${gpuCrop.id}.png`),
      PNG.sync.write(sideBySide(upscale(a, 4), upscale(b, 4))),
    );
  }
  expect(gpuCrops.length).toBe(cards.length * THEMES.length * ZOOMS.length);
};

test("spine halo: 1:1 spine card crops from both canvases, both themes", async () => {
  test.setTimeout(900_000);
  await mkdir(VISUAL_DIR, { recursive: true });
  await pair(galleryFixture, CARDS, "spine halo (gallery)", "gallery");
});

/**
 * The halo's own job: a spine card's words sit on a ground the card does not
 * fill, and a wire running behind them must not read through the glyphs. Two
 * seats joined by a message wire, with a note and a label on its path, is the
 * fixture that shows the wash — and the one place a missing halo is obvious.
 */
test("spine halo: words over a wire, in both themes", async () => {
  test.setTimeout(900_000);
  await mkdir(VISUAL_DIR, { recursive: true });
  const nodes = [
    modelSeat({ id: "halo-seat-a", label: "Ada", x: -420, y: 40 }),
    modelSeat({ id: "halo-seat-b", label: "Bex", x: 420, y: 40 }),
    // The wire runs between the seats' facing edges at y ~ 88, so the note
    // sits on that line: its words are the glyphs the wash has to protect.
    modelNote("halo-note", "Four score and seven\nwords over a wire.", 0, 20),
    modelLabel("halo-label", "A label over a wire", -40, 180),
  ];
  const fixture = modelFixture(nodes, [modelWire("halo-wire", "halo-seat-a", "halo-seat-b", "messages", nodes)]);
  await pair(fixture, ["halo-note", "halo-label"], "spine halo (wire)", "wire");
});
