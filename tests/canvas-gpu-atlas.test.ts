import { describe, expect, it } from "vitest";
import {
  createGpuAtlas,
  type AtlasPixels,
  type GpuAtlasOptions,
} from "../src/window/canvas/engine/gpu-atlas";
import { ATLAS_CELL_FLOATS } from "../src/window/canvas/engine/types";
import { NO_ATLAS_CELL } from "../src/window/canvas/engine/quad";
import type { Quad, QuadStyle, SpriteRef, TextRun } from "../src/window/canvas/contract";
import { themeGpu } from "@shared/theme";
import { settle } from "./gpu-canvas-fakes";

const fakeDevice = (limits?: Partial<GPUSupportedLimits>) => {
  const copies: Array<{ readonly width: number; readonly height: number; readonly layer: number; readonly x: number; readonly y: number }> = [];
  const textureCopies: Array<{ readonly layers: number }> = [];
  let textures = 0;
  const device = {
    limits: {
      maxTextureDimension2D: 8192,
      maxTextureArrayLayers: 256,
      maxStorageBufferBindingSize: 128 * 1024 * 1024,
      ...limits,
    },
    createTexture: (desc: GPUTextureDescriptor) => {
      textures += 1;
      const size = desc.size as GPUExtent3DDict;
      return {
        width: size.width,
        height: size.height,
        depthOrArrayLayers: size.depthOrArrayLayers ?? 1,
        createView: () => ({}),
        destroy: () => undefined,
      };
    },
    createSampler: () => ({}),
    createCommandEncoder: () => ({
      copyTextureToTexture: (_src: unknown, _dst: unknown, copySize: GPUExtent3DDict) => {
        textureCopies.push({ layers: copySize.depthOrArrayLayers ?? 1 });
      },
      finish: () => ({}),
    }),
    pushErrorScope: () => undefined,
    popErrorScope: async () => null,
    queue: {
      copyExternalImageToTexture: (
        _image: unknown,
        destination: { readonly origin?: { readonly x?: number; readonly y?: number; readonly z?: number } },
        size: { readonly width: number; readonly height: number },
      ) => {
        copies.push({
          width: size.width,
          height: size.height,
          x: destination.origin?.x ?? 0,
          y: destination.origin?.y ?? 0,
          layer: destination.origin?.z ?? 0,
        });
      },
      submit: () => undefined,
      writeBuffer: () => undefined,
    },
  } as unknown as GPUDevice;
  return { device, copies, textureCopies, textures: () => textures };
};

const pixels = (width: number, height: number, onClose?: () => void): AtlasPixels =>
  ({ width, height, close: onClose ?? (() => undefined) }) as unknown as AtlasPixels;

const textRun: TextRun = {
  text: "hello",
  font: "body",
  size: 12,
  weight: 400,
  truncate: "end",
  width: 80,
};

const style: QuadStyle = { ink: { token: "ink" } };

const quad = (over: Partial<Quad>): Quad => ({
  key: "q",
  kind: "shape",
  band: "cards",
  z: 0,
  rect: { x: 0, y: 0, width: 10, height: 10 },
  tiers: 0,
  scale: { kind: "board" },
  style,
  ...over,
});

const textQuad = (run: TextRun = textRun, ink: QuadStyle["ink"] = { token: "ink" }): Quad =>
  quad({ kind: "text", text: run, style: { ink } });

const spriteQuad = (sprite: SpriteRef, width = 16, height = 16): Quad =>
  quad({ kind: "sprite", sprite, rect: { x: 0, y: 0, width, height } });

const atlasWith = (over: Partial<GpuAtlasOptions> = {}) => {
  const rasterizeText = over.rasterizeText ?? (async () => pixels(20, 10));
  const rasterizeSprite = over.rasterizeSprite ?? (async () => pixels(16, 16));
  const dirty: Array<number> = [];
  const failureMessages: Array<string> = [];
  const atlas = createGpuAtlas({
    rasterizeText,
    rasterizeSprite,
    onDirty: () => dirty.push(atlas.revision()),
    onFailure: (msg) => failureMessages.push(msg),
    ...over,
  });
  return { atlas, dirty, failureMessages };
};

describe("gpu atlas (#911)", () => {
  it("gives a text quad a cell whose 8-float UV + layer entry lands after raster", async () => {
    const { atlas, dirty } = atlasWith();
    const { device } = fakeDevice();
    atlas.attach(device);
    const index = atlas.acquire(textQuad(), 2);
    expect(index).not.toBe(NO_ATLAS_CELL);
    // Same key with previous returns same index with net zero ref change.
    expect(atlas.acquire(textQuad(), 2, index)).toBe(index);
    // A different raster scale is a different cell.
    const other = atlas.acquire(textQuad(), 3);
    expect(other).not.toBe(index);
    await settle();
    await settle();
    const base = index * ATLAS_CELL_FLOATS;
    expect(atlas.binding.cells[base]).toBeGreaterThan(0);
    expect(atlas.binding.cells[base]).toBeLessThan(atlas.binding.cells[base + 2]!);
    expect(atlas.binding.cells[base + 1]).toBe(0);
    expect(atlas.binding.cells[base + 2]).toBeGreaterThan(0);
    expect(atlas.binding.cells[base + 3]).toBeGreaterThan(0);
    expect(atlas.binding.cells[base + 4]).toBe(0); // layer 0
    expect(atlas.hasImage(index)).toBe(true);
    expect(atlas.revision()).toBeGreaterThan(0);
    expect(dirty.length).toBeGreaterThan(0);
  });

  it("keeps unknown glyphs out of the atlas and interns known glyphs and media", () => {
    const { atlas } = atlasWith();
    expect(atlas.acquire(spriteQuad({ atlas: "glyph", name: "x" }), 2)).toBe(NO_ATLAS_CELL);
    expect(atlas.acquire(spriteQuad({ atlas: "glyph", name: "preamble" }), 2)).toBe(NO_ATLAS_CELL);
    const glyph = atlas.acquire(spriteQuad({ atlas: "glyph", name: "plus" }), 2);
    const media = atlas.acquire(
      spriteQuad({ atlas: "media", ref: "junto-content://object/abc", fit: "contain" }),
      2,
    );
    expect(glyph).not.toBe(NO_ATLAS_CELL);
    expect(media).not.toBe(NO_ATLAS_CELL);
    expect(glyph).not.toBe(media);
  });

  it("leaves one transparent texel between neighbouring cells", async () => {
    const { atlas } = atlasWith({ size: 64 });
    atlas.attach(fakeDevice().device);
    const first = atlas.acquire(textQuad(), 2);
    const second = atlas.acquire(textQuad({ ...textRun, text: "world" }), 2);
    expect(second).not.toBe(first);
    await settle();
    await settle();
    const right = atlas.binding.cells[first * ATLAS_CELL_FLOATS + 2]! * 64;
    const left = atlas.binding.cells[second * ATLAS_CELL_FLOATS]! * 64;
    expect(Math.round(left - right)).toBeGreaterThanOrEqual(1);
  });

  it("rasterizes text in its true resolved ink colour, not white", async () => {
    const seen: Array<{ readonly r: number; readonly g: number; readonly b: number }> = [];
    const { atlas } = atlasWith({
      mode: "dark",
      rasterizeText: async (_run, _scale, ink) => {
        seen.push(ink);
        return pixels(20, 10);
      },
    });
    atlas.attach(fakeDevice().device);
    atlas.acquire(textQuad(textRun, { token: "amber" }), 2);
    await settle();
    await settle();
    expect(seen.length).toBe(1);
    const expected = themeGpu("dark").colors.amber!;
    expect(seen[0]!.r).toBeCloseTo(expected.r, 3);
    expect(seen[0]!.g).toBeCloseTo(expected.g, 3);
    expect(seen[0]!.b).toBeCloseTo(expected.b, 3);
    // Must not be hardcoded white (1, 1, 1)
    expect(seen[0]!.r === 1 && seen[0]!.g === 1 && seen[0]!.b === 1).toBe(false);
  });

  it("reclaims unreferenced LRU cells before adding a page", async () => {
    const { atlas } = atlasWith({
      size: 64,
      rasterizeText: async () => pixels(40, 40),
    });
    atlas.attach(fakeDevice().device);

    const a = atlas.acquire(textQuad({ ...textRun, text: "a" }), 1);
    await settle();
    await settle();
    expect(atlas.stats().pages).toBe(1);
    expect(atlas.stats().evictions).toBe(0);

    // Release a: stays cached until space is needed
    atlas.release(a);
    expect(atlas.stats().pinnedCells).toBe(0);
    expect(atlas.stats().evictions).toBe(0);

    // Acquire b (40x40 doesn't fit beside 40x40 on a 64x64 page): reclaims a instead of adding a page!
    const b = atlas.acquire(textQuad({ ...textRun, text: "b" }), 1);
    await settle();
    await settle();
    expect(atlas.hasImage(b)).toBe(true);
    expect(atlas.stats().pages).toBe(1);
    expect(atlas.stats().evictions).toBe(1);
  });

  it("adds a page on demand only when referenced cells do not fit", async () => {
    const { atlas } = atlasWith({
      size: 64,
      rasterizeText: async () => pixels(40, 40),
    });
    const fake = fakeDevice();
    atlas.attach(fake.device);
    const genBefore = atlas.binding.textureGeneration;

    const a = atlas.acquire(textQuad({ ...textRun, text: "a" }), 1);
    const b = atlas.acquire(textQuad({ ...textRun, text: "b" }), 1);
    await settle();
    await settle();

    expect(atlas.hasImage(a)).toBe(true);
    expect(atlas.hasImage(b)).toBe(true);
    expect(atlas.stats().pages).toBe(2);
    expect(atlas.stats().evictions).toBe(0);
    expect(atlas.binding.textureGeneration).toBeGreaterThan(genBefore);
    expect(fake.textureCopies.length).toBe(1);
    // a on layer 0, b on layer 1
    expect(atlas.binding.cells[a * ATLAS_CELL_FLOATS + 4]).toBe(0);
    expect(atlas.binding.cells[b * ATLAS_CELL_FLOATS + 4]).toBe(1);
  });

  it("overwrites fixed-box status lines in place when refCount is 1", async () => {
    const fake = fakeDevice();
    const run1: TextRun = { text: "step 1", font: "mono", size: 11, weight: 400, truncate: "end", width: 80 };
    const run2: TextRun = { text: "step 2", font: "mono", size: 11, weight: 400, truncate: "end", width: 80 };
    const { atlas } = atlasWith({
      rasterizeText: async () => pixels(160, 27),
    });
    atlas.attach(fake.device);

    const first = atlas.acquire(textQuad(run1), 2);
    await settle();
    await settle();
    expect(fake.copies.length).toBe(1);
    const x1 = fake.copies[0]!.x;
    const y1 = fake.copies[0]!.y;

    const second = atlas.acquire(textQuad(run2), 2, first);
    expect(second).toBe(first); // kept stable index in place
    expect(atlas.hasImage(second)).toBe(true); // old pixels still visible before new raster lands
    await settle();
    await settle();
    expect(fake.copies.length).toBe(2);
    expect(fake.copies[1]!.x).toBe(x1);
    expect(fake.copies[1]!.y).toBe(y1);
  });

  it("keeps previous image aliased when replacement has a different box (Ruling 6 #1)", async () => {
    let releaseSecond!: () => void;
    let call = 0;
    const { atlas } = atlasWith({
      rasterizeText: async () => {
        call += 1;
        if (call === 1) return pixels(40, 14);
        await new Promise<void>((r) => { releaseSecond = r; });
        return pixels(90, 14);
      },
    });
    atlas.attach(fakeDevice().device);

    const narrow = textQuad({ ...textRun, width: 20 });
    const wide = textQuad({ ...textRun, width: 45 });
    const prev = atlas.acquire(narrow, 2);
    await settle();
    await settle();
    expect(atlas.hasImage(prev)).toBe(true);

    const next = atlas.acquire(wide, 2, prev);
    expect(next).not.toBe(prev);
    // Immediately hasImage via aliased previous while raster is pending!
    expect(atlas.hasImage(next)).toBe(true);
    expect(atlas.binding.cells[next * ATLAS_CELL_FLOATS + 2]).toBe(
      atlas.binding.cells[prev * ATLAS_CELL_FLOATS + 2],
    );

    await settle(); // let drainQueue start the second raster
    releaseSecond();
    await settle();
    await settle();
    // Once landed, UV updates to next's own wider rect and prev is released (unpinned).
    expect(atlas.stats().pinnedCells).toBe(1);
    expect(atlas.binding.cells[next * ATLAS_CELL_FLOATS + 2]).not.toBe(
      atlas.binding.cells[prev * ATLAS_CELL_FLOATS + 2],
    );
  });

  it("aliases nearest-bucket stand-in while exact scale is pending", async () => {
    let releaseZoom!: () => void;
    let call = 0;
    const { atlas } = atlasWith({
      rasterizeText: async (_run, scale) => {
        call += 1;
        if (call === 1) return pixels(Math.round(20 * scale), 14);
        await new Promise<void>((r) => { releaseZoom = r; });
        return pixels(Math.round(20 * scale), 14);
      },
    });
    atlas.attach(fakeDevice().device);

    const at1 = atlas.acquire(textQuad(), 1);
    await settle();
    await settle();
    atlas.release(at1); // cached at refCount 0

    // Acquire same text at scale 2: should alias at1 immediately!
    const at2 = atlas.acquire(textQuad(), 2);
    expect(atlas.hasImage(at2)).toBe(true);
    expect(atlas.stats().pinnedCells).toBe(2); // at2 + internal alias ref on at1

    await settle(); // let drainQueue start the zoom raster
    releaseZoom();
    await settle();
    await settle();
    expect(atlas.stats().pinnedCells).toBe(1); // at1 alias released once at2 landed
  });

  it("clamps oversized items to fit within the page", async () => {
    const scales: number[] = [];
    const { atlas } = atlasWith({
      size: 128,
      rasterizeText: async (run, scale) => {
        scales.push(scale);
        return pixels(Math.ceil(run.width * scale), Math.ceil(run.size * scale));
      },
    });
    atlas.attach(fakeDevice().device);

    const huge = textQuad({ ...textRun, width: 1000, size: 40 });
    const idx = atlas.acquire(huge, 2); // raw 2000px > 127px
    await settle();
    await settle();
    expect(atlas.hasImage(idx)).toBe(true);
    expect(scales[0]!).toBeLessThan(0.13);
    expect(atlas.stats().failures).toBe(0);
  });

  it("retries failed rasters and reports failures", async () => {
    let attempts = 0;
    const { atlas, failureMessages } = atlasWith({
      rasterizeSprite: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("transient decode failure");
        return pixels(16, 16);
      },
    });
    atlas.attach(fakeDevice().device);

    const media = spriteQuad({ atlas: "media", ref: "junto-content://object/retry", fit: "contain" });
    const idx = atlas.acquire(media, 1);
    await settle();
    await settle();
    expect(atlas.stats().failures).toBe(1);
    expect(failureMessages.length).toBe(1);
    expect(atlas.hasImage(idx)).toBe(false);

    // Wait past base retry backoff (250ms) and re-acquire
    await new Promise((r) => setTimeout(r, 270));
    expect(atlas.acquire(media, 1, idx)).toBe(idx);
    await settle();
    await settle();
    expect(atlas.hasImage(idx)).toBe(true);
    expect(atlas.stats().pending).toBe(0);
  });

  it("ensureNow rasterizes synchronously before frame submit", () => {
    const { atlas } = atlasWith({
      rasterizeTextSync: () => pixels(24, 12),
    });
    atlas.attach(fakeDevice().device);

    const idx = atlas.acquire(textQuad(), 2);
    expect(atlas.hasImage(idx)).toBe(false);
    expect(atlas.ensureNow(idx)).toBe(true);
    expect(atlas.hasImage(idx)).toBe(true);
  });

  it("closes ImageBitmaps immediately and recovers referenced cells on device loss without retained bitmaps", async () => {
    let closed = 0;
    const { atlas } = atlasWith({
      rasterizeText: async () => pixels(20, 10, () => { closed += 1; }),
    });
    const first = fakeDevice();
    atlas.attach(first.device);

    const pinned = atlas.acquire(textQuad({ ...textRun, text: "keep" }), 2);
    const unpinned = atlas.acquire(textQuad({ ...textRun, text: "drop" }), 2);
    await settle();
    await settle();
    expect(closed).toBe(2);
    atlas.release(unpinned);

    // Device loss: attach a fresh device
    const second = fakeDevice();
    atlas.attach(second.device);
    await settle();
    await settle();
    expect(second.textures()).toBe(1);
    // Only the referenced cell was re-rasterized (1 copy, not 2)
    expect(second.copies.length).toBe(1);
    expect(atlas.hasImage(pinned)).toBe(true);
    expect(closed).toBe(3);
  });

  it("tracks visibleBlank per frame and cumulatively", () => {
    const { atlas } = atlasWith();
    atlas.recordVisibleBlank(2);
    atlas.recordVisibleBlank(0);
    const s = atlas.stats();
    expect(s.visibleBlank).toBe(0);
    expect(s.visibleBlankTotal).toBe(2);
  });

  it("ignores quads with no text or sprite", () => {
    const { atlas } = atlasWith();
    expect(atlas.acquire(quad({}), 2)).toBe(NO_ATLAS_CELL);
  });
});
