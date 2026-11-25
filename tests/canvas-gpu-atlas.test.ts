import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  const createdTextures: Array<{ readonly width: number; readonly height: number; readonly format: string }> = [];
  let textures = 0;
  let destroyedTextures = 0;
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
      createdTextures.push({ width: size.width, height: size.height ?? 1, format: desc.format });
      return {
        width: size.width,
        height: size.height,
        depthOrArrayLayers: size.depthOrArrayLayers ?? 1,
        format: desc.format,
        createView: () => ({}),
        destroy: () => {
          destroyedTextures += 1;
        },
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
      writeTexture: (
        destination: { readonly origin?: { readonly x?: number; readonly y?: number; readonly z?: number } },
        _data: unknown,
        _layout: unknown,
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
  return { device, copies, textureCopies, createdTextures, textures: () => textures, destroyedTextures: () => destroyedTextures };
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

/** The atlas's clock and its one timer become the test's: time passes only when the test says so. */
const fakeClock = (): void => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
};

/**
 * The next macrotask, by the same MessageChannel mechanism the decode queue
 * uses. A drain the queue already posted runs first, so this is the test's
 * sight of the queue having drained, with no fixed wait.
 */
const nextMacrotask = async (): Promise<void> => {
  if (typeof MessageChannel === "function") {
    await new Promise<void>((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        channel.port1.close();
        channel.port2.close();
        resolve();
      };
      channel.port2.postMessage(undefined);
    });
    return;
  }
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
};

// A test that took the clock gives it back, pass or fail.
afterEach(() => {
  vi.useRealTimers();
});

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
    const base = atlas.cellIndex(index) * ATLAS_CELL_FLOATS;
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
    const right = atlas.binding.cells[atlas.cellIndex(first) * ATLAS_CELL_FLOATS + 2]! * 64;
    const left = atlas.binding.cells[atlas.cellIndex(second) * ATLAS_CELL_FLOATS]! * 64;
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

  it("reclaims unreferenced LRU plots before adding a page (lazy pool init)", async () => {
    const { atlas } = atlasWith({
      size: 64,
      rasterizeText: async () => pixels(40, 40),
    });
    atlas.attach(fakeDevice().device);
    // Lazy pool init: 0 pages and 0 bytes allocated before content arrives
    expect(atlas.stats().pages).toBe(0);
    expect(atlas.stats().bytesInUse).toBe(0);

    const a = atlas.acquire(textQuad({ ...textRun, text: "a" }), 1);
    await settle();
    await settle();
    // Only the coverage pool page was created (not RGBA)
    expect(atlas.stats().pages).toBe(1);
    expect(atlas.stats().evictions).toBe(0);

    // Release a: stays cached until space is needed
    atlas.release(a);
    expect(atlas.stats().pinnedCells).toBe(0);
    expect(atlas.stats().evictions).toBe(0);

    // Acquire b (40x40 doesn't fit beside 40x40 on a 64x64 plot): reclaims the plot instead of adding a page!
    const b = atlas.acquire(textQuad({ ...textRun, text: "b" }), 1);
    await settle();
    await settle();
    expect(atlas.hasImage(b)).toBe(true);
    expect(atlas.stats().pages).toBe(1);
    expect(atlas.stats().evictions).toBe(1);
  });

  it("adds an independent page on demand with zero copies when referenced plots are full", async () => {
    const { atlas } = atlasWith({
      size: 64,
      rasterizeText: async () => pixels(40, 40),
    });
    const fake = fakeDevice();
    atlas.attach(fake.device);

    const a = atlas.acquire(textQuad({ ...textRun, text: "a" }), 1);
    const b = atlas.acquire(textQuad({ ...textRun, text: "b" }), 1);
    await settle();
    await settle();

    expect(atlas.hasImage(a)).toBe(true);
    expect(atlas.hasImage(b)).toBe(true);
    expect(atlas.stats().pages).toBe(2); // 2 independent coverage pages
    expect(atlas.stats().evictions).toBe(0);
    expect(fake.textureCopies.length).toBe(0); // zero copies on page growth!
    expect(atlas.binding.standalone?.has(atlas.cellIndex(a))).toBe(false); // page 0 uses bind group
    expect(atlas.binding.standalone?.has(atlas.cellIndex(b))).toBe(false); // page 1 uses bind group (no standalone split!)
    expect(atlas.binding.coveragePages?.length).toBe(2);
    expect(atlas.binding.cells[atlas.cellIndex(a) * ATLAS_CELL_FLOATS + 4]).toBe(0);
    expect(atlas.binding.cells[atlas.cellIndex(b) * ATLAS_CELL_FLOATS + 4]).toBe(1);
  });

  it("overwrites a fixed-box status line in place when only its own quad showed the old one", async () => {
    const fake = fakeDevice();
    const run1: TextRun = { text: "step 1", font: "mono", size: 11, weight: 400, truncate: "end", width: 80 };
    const run2: TextRun = { text: "step 2", font: "mono", size: 11, weight: 400, truncate: "end", width: 80 };
    const { atlas } = atlasWith({
      rasterizeText: async () => pixels(160, 27),
    });
    atlas.attach(fake.device);
    const rowOf = (cell: number): number[] =>
      Array.from(atlas.binding.cells.subarray(atlas.cellIndex(cell) * ATLAS_CELL_FLOATS, atlas.cellIndex(cell) * ATLAS_CELL_FLOATS + ATLAS_CELL_FLOATS));

    const first = atlas.acquire(textQuad(run1), 2);
    await settle();
    await settle();
    expect(fake.copies.length).toBe(1);
    const x1 = fake.copies[0]!.x;
    const y1 = fake.copies[0]!.y;
    const rect = rowOf(first);

    // The new text is a new cell, which shows the old pixels until its raster lands.
    const second = atlas.acquire(textQuad(run2), 2, first);
    expect(second).not.toBe(first);
    expect(atlas.hasImage(second)).toBe(true);
    expect(rowOf(second)).toEqual(rect);
    await settle();
    await settle();
    // The raster went over the old rect, and the old cell is gone.
    expect(fake.copies.length).toBe(2);
    expect(fake.copies[1]!.x).toBe(x1);
    expect(fake.copies[1]!.y).toBe(y1);
    expect(rowOf(second)).toEqual(rect);
    expect(atlas.hasImage(first)).toBe(false);
    expect(atlas.stats().overwrites).toBe(1);
    expect(atlas.stats().activeCells).toBe(1);
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
    expect(atlas.binding.cells[atlas.cellIndex(next) * ATLAS_CELL_FLOATS + 2]).toBe(
      atlas.binding.cells[atlas.cellIndex(prev) * ATLAS_CELL_FLOATS + 2],
    );

    await settle(); // let drainQueue start the second raster
    releaseSecond();
    await settle();
    await settle();
    // Once landed, UV updates to next's own wider rect and prev is released (unpinned).
    expect(atlas.stats().pinnedCells).toBe(1);
    expect(atlas.binding.cells[atlas.cellIndex(next) * ATLAS_CELL_FLOATS + 2]).not.toBe(
      atlas.binding.cells[atlas.cellIndex(prev) * ATLAS_CELL_FLOATS + 2],
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

  it("gives items larger than a page their own full-resolution standalone texture (no downscaling)", async () => {
    const scales: number[] = [];
    const { atlas } = atlasWith({
      size: 128,
      rasterizeText: async (run, scale) => {
        scales.push(scale);
        return pixels(Math.ceil(run.width * scale), Math.ceil(run.size * scale));
      },
    });
    const fake = fakeDevice({ maxTextureDimension2D: 4096 });
    atlas.attach(fake.device);

    const huge = textQuad({ ...textRun, width: 1000, size: 40 });
    const idx = atlas.acquire(huge, 2); // 2000x80 > 128 page, <= 4096 maxTextureDimension2D
    await settle();
    await settle();
    expect(atlas.hasImage(idx)).toBe(true);
    expect(scales[0]).toBe(2); // never downscaled!
    expect(atlas.binding.standalone?.has(atlas.cellIndex(idx))).toBe(true);
    expect(atlas.stats().failures).toBe(0);
    expect(atlas.stats().bytesInUse).toBeGreaterThan(128 * 128 * 4);
  });

  it("tiles items larger than maxTextureDimension2D without downscaling", async () => {
    const { atlas } = atlasWith({
      size: 128,
      rasterizeText: async () => pixels(500, 120),
    });
    const fake = fakeDevice({ maxTextureDimension2D: 256, maxTextureArrayLayers: 16 });
    atlas.attach(fake.device);

    const gigantic = textQuad({ ...textRun, width: 250, size: 60 });
    const idx = atlas.acquire(gigantic, 2); // 500x120 > 256 maxTextureDimension2D -> 2x1 tiles
    await settle();
    await settle();
    expect(atlas.hasImage(idx)).toBe(true);
    expect(atlas.binding.standalone?.has(atlas.cellIndex(idx))).toBe(true);
    const base = atlas.cellIndex(idx) * ATLAS_CELL_FLOATS;
    expect(atlas.binding.cells[base + 5]).toBe(2); // tilesX = 2
    expect(atlas.binding.cells[base + 6]).toBe(1); // tilesY = 1
    expect(fake.copies.length).toBe(2); // 2 tile copies
    expect(atlas.stats().failures).toBe(0);
  });

  it("reuses one text coverage cell when only the ink changes", async () => {
    const { atlas } = atlasWith();
    atlas.attach(fakeDevice().device);
    const run = { ...textRun, text: "same words" };
    const first = atlas.acquire(textQuad(run, { token: "ink" }), 2);
    await settle();
    await settle();
    expect(atlas.hasImage(first)).toBe(true);
    const requests = atlas.requests;

    const again = atlas.acquire(textQuad(run, { token: "amber" }), 2, first);
    expect(again).toBe(first);
    expect(atlas.requests).toBe(requests);
  });

  it("retries failed rasters and reports failures", async () => {
    fakeClock();
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

    // Past the base back-off (250 ms) the atlas has queued it again. Asking
    // again keeps the cell, and adds no raster.
    vi.advanceTimersByTime(270);
    expect(atlas.acquire(media, 1, idx)).toBe(idx);
    await settle();
    await settle();
    expect(atlas.hasImage(idx)).toBe(true);
    expect(atlas.stats().pending).toBe(0);
    expect(attempts).toBe(2);
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
    expect(second.textures()).toBe(3); // 2 1x1 dummies + 1 lazy coverage page for the pinned text cell
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

  it("tracks dirty cell slots for partial cells-buffer uploads", async () => {
    const { atlas } = atlasWith();
    atlas.attach(fakeDevice().device);
    // Initial attach marks all dirty
    expect(atlas.binding.takeDirtyCells!()).toEqual({ all: true, slots: [] });
    expect(atlas.binding.takeDirtyCells!()).toEqual({ all: false, slots: [] });

    const a = atlas.acquire(textQuad({ ...textRun, text: "first" }), 2);
    const b = atlas.acquire(textQuad({ ...textRun, text: "second" }), 2);
    await settle();
    await settle();
    const dirty = atlas.binding.takeDirtyCells!();
    expect(dirty.all).toBe(false);
    expect(dirty.slots).toEqual([atlas.cellIndex(a), atlas.cellIndex(b)].sort((x, y) => x - y));
    // Cleared after take
    expect(atlas.binding.takeDirtyCells!()).toEqual({ all: false, slots: [] });
  });

  it("uses async worker path for background queue and sync path for ensureNow when preferAsyncRaster is set", async () => {
    let asyncCalls = 0;
    let syncCalls = 0;
    const { atlas } = atlasWith({
      preferAsyncRaster: true,
      rasterizeText: async () => {
        asyncCalls += 1;
        return pixels(20, 10);
      },
      rasterizeTextSync: () => {
        syncCalls += 1;
        return pixels(20, 10);
      },
    });
    atlas.attach(fakeDevice().device);

    const bg = atlas.acquire(textQuad({ ...textRun, text: "background" }), 2);
    await settle();
    await settle();
    expect(atlas.hasImage(bg)).toBe(true);
    expect(asyncCalls).toBe(1);
    expect(syncCalls).toBe(0);

    const urgent = atlas.acquire(textQuad({ ...textRun, text: "urgent" }), 2);
    expect(atlas.ensureNow(urgent)).toBe(true);
    expect(syncCalls).toBe(1);
  });

  it("drains its whole queue where there are no frames to yield to, however slow the machine", async () => {
    // Every read of the clock is 10 ms later, so each drain is past its slice after one raster.
    let clock = 0;
    const slow = vi.spyOn(performance, "now").mockImplementation(() => (clock += 10));
    try {
      const { atlas } = atlasWith();
      atlas.attach(fakeDevice().device);
      const cells = [0, 1, 2, 3, 4].map((i) => atlas.acquire(textQuad({ ...textRun, text: `slow-${i}` }), 1));
      await settle();
      await settle();
      // 0.11.14: the drain gave the thread back after its first raster and
      // went on in a macrotask. A test that turns only microtasks never
      // reaches it, so on a loaded machine the queue stood still for the rest
      // of the run and only in-frame rasters landed.
      for (const cell of cells) expect(atlas.hasImage(cell)).toBe(true);
      expect(atlas.stats().pending).toBe(0);
    } finally {
      slow.mockRestore();
    }
  });

  it("ignores quads with no text or sprite", () => {
    const { atlas } = atlasWith();
    expect(atlas.acquire(quad({}), 2)).toBe(NO_ATLAS_CELL);
  });

  it("packs items wider than one 512px plot into strip pages with zero standalone textures", async () => {
    const fake = fakeDevice();
    const widths: Record<string, number> = { "wide-a": 729, "wide-b": 1167, "wide-c": 2000 };
    const { atlas } = atlasWith({
      size: 2048,
      rasterizeText: async (run) => pixels(widths[run.text] ?? 800, 85),
    });
    atlas.attach(fake.device);
    const cells = [
      atlas.acquire(textQuad({ ...textRun, text: "wide-a" }), 1),
      atlas.acquire(textQuad({ ...textRun, text: "wide-b" }), 1),
      atlas.acquire(textQuad({ ...textRun, text: "wide-c" }), 1),
    ];
    await settle();
    await settle();
    for (const c of cells) expect(atlas.hasImage(c)).toBe(true);
    expect(atlas.stats().standaloneCount).toBe(0);
    expect(atlas.binding.standalone?.size).toBe(0);
    expect(atlas.binding.coveragePages?.length).toBe(1);
    expect(fake.createdTextures.filter((t) => t.format === "r8unorm" && t.width === 2048).length).toBe(1);
  });

  it("binds overflow pages within device.limits in one bind group without standalone entries", async () => {
    const fake = fakeDevice();
    const { atlas } = atlasWith({
      size: 128,
      rasterizeText: async () => pixels(100, 100),
    });
    atlas.attach(fake.device);
    const c1 = atlas.acquire(textQuad({ ...textRun, text: "page-0" }), 1);
    const c2 = atlas.acquire(textQuad({ ...textRun, text: "page-1" }), 1);
    await settle();
    await settle();
    expect(atlas.hasImage(c1)).toBe(true);
    expect(atlas.hasImage(c2)).toBe(true);
    expect(atlas.binding.coveragePages?.length).toBe(2);
    expect(atlas.stats().standaloneCount).toBe(0);
    expect(atlas.binding.standalone?.size).toBe(0);
    // Page index lives in cell.page.x (offset + 4)
    expect(atlas.binding.cells[atlas.cellIndex(c1) * ATLAS_CELL_FLOATS + 4]).toBe(0);
    expect(atlas.binding.cells[atlas.cellIndex(c2) * ATLAS_CELL_FLOATS + 4]).toBe(1);
  });

  it("immediately destroys standalone textures when released off-screen", async () => {
    const fake = fakeDevice();
    const { atlas } = atlasWith({
      size: 128,
      rasterizeText: async () => pixels(200, 40),
    });
    atlas.attach(fake.device);
    const cell = atlas.acquire(textQuad({ ...textRun, text: "oversized-watermark" }), 1);
    await settle();
    await settle();
    expect(atlas.hasImage(cell)).toBe(true);
    expect(atlas.stats().standaloneCount).toBe(1);
    const standaloneTex = atlas.binding.standalone?.get(atlas.cellIndex(cell));
    expect(standaloneTex).toBeDefined();
    const destroyedBefore = fake.destroyedTextures();

    atlas.release(cell);
    expect(atlas.stats().standaloneCount).toBe(0);
    expect(atlas.binding.standalone?.size).toBe(0);
    expect(fake.destroyedTextures()).toBe(destroyedBefore + 1);
  });

  it("defers SVG source decode off-frame and retains warm decoded SVGs across tier release/re-prepare", async () => {
    const fake = fakeDevice();
    const { atlas } = atlasWith({ size: 256 });
    atlas.attach(fake.device);

    const g = globalThis as Record<string, unknown>;
    const prevDoc = g["document"];
    const prevImage = g["Image"];
    const origCreateObjectURL = URL.createObjectURL;
    const origRevokeObjectURL = URL.revokeObjectURL;
    let createUrlCalls = 0;
    let decodeCalls = 0;
    const decodes: Array<Promise<void>> = [];

    g["document"] = {};
    g["Image"] = class FakeImage {
      src = "";
      async decode(): Promise<void> {
        decodeCalls += 1;
        const done = Promise.resolve();
        decodes.push(done);
        await done;
      }
    };
    URL.createObjectURL = () => {
      createUrlCalls += 1;
      return `blob:fake-${createUrlCalls}`;
    };
    URL.revokeObjectURL = () => undefined;

    try {
      const spriteQuad = quad({
        key: "portrait-warm-test",
        kind: "sprite",
        sprite: { atlas: "image", key: "portrait-warm-lru-test-1", svg: "<svg></svg>", size: { width: 40, height: 40 } },
      });

      // Cold prepareSource must do zero synchronous Blob/URL/Image work inside the frame.
      atlas.prepareSource(spriteQuad);
      expect(createUrlCalls).toBe(0);
      expect(decodeCalls).toBe(0);

      // The decode drain's own macrotask runs the decode off-frame; then the
      // decode's own promise settles it.
      await nextMacrotask();
      expect(createUrlCalls).toBe(1);
      expect(decodeCalls).toBe(1);
      await decodes[0];
      await settle();

      // Release to refCount 0 (simulating leaving overview tier) and re-prepare (returning to overview).
      atlas.releaseSource(spriteQuad);
      atlas.prepareSource(spriteQuad);
      // Warm or not, a queued drain would run before this macrotask. Nothing
      // is queued here, so nothing decodes.
      await nextMacrotask();
      await settle();

      // Warm hit: zero re-decode, and stats report decoded cache bytes/count!
      expect(createUrlCalls).toBe(1);
      expect(decodeCalls).toBe(1);
      expect(atlas.stats().decodedSourceBytes).toBeGreaterThan(0);
      expect(atlas.stats().decodedSvgCount).toBeGreaterThanOrEqual(1);

      // Under real memory pressure, unreferenced decoded sources are evicted.
      atlas.releaseSource(spriteQuad);
      atlas.notifyMemoryPressure?.();
      expect(atlas.stats().decodedSvgCount).toBe(0);
    } finally {
      g["document"] = prevDoc;
      g["Image"] = prevImage;
      URL.createObjectURL = origCreateObjectURL;
      URL.revokeObjectURL = origRevokeObjectURL;
    }
  });

  it("shows an item asked at a new size through its nearest landed size, with zero lostPixels and no floor copy", async () => {
    const fake = fakeDevice();
    const { atlas } = atlasWith({
      size: 512,
      rasterizeText: async (_run, scale) => pixels(Math.round(60 * scale), Math.round(30 * scale)),
    });
    atlas.attach(fake.device);
    const rowOf = (cell: number): number[] =>
      Array.from(atlas.binding.cells.subarray(atlas.cellIndex(cell) * ATLAS_CELL_FLOATS, atlas.cellIndex(cell) * ATLAS_CELL_FLOATS + ATLAS_CELL_FLOATS));

    // Land a cell at overview scale (0.5).
    const small = atlas.acquire(textQuad({ ...textRun, text: "item" }), 0.5);
    await settle();
    await settle();
    expect(atlas.hasImage(small)).toBe(true);
    const smallRect = rowOf(small);

    // Off screen it stays cached while nothing needs its room. It is no floor: nothing is kept past eviction.
    atlas.release(small);
    expect(atlas.stats().floorCells).toBe(0);
    expect(atlas.stats().floorBytes).toBe(0);

    // The same item near (2.0) shows the small copy at once (hasImage === true, lostPixels === 0).
    const near = atlas.acquire(textQuad({ ...textRun, text: "item" }), 2.0);
    expect(atlas.hasImage(near)).toBe(true);
    expect(rowOf(near)).toEqual(smallRect);
    expect(atlas.stats().lostPixels).toBe(0);
    expect(atlas.stats().pinnedCells).toBe(2); // near, and the small copy it shows
    await settle();
    await settle();
    // Landed, it shows its own pixels and lets the small copy go.
    expect(rowOf(near)).not.toEqual(smallRect);
    expect(atlas.stats().pinnedCells).toBe(1);
  });

  it("pendingKeys returns bounded queued and rasterizing cell diagnostics and empties on settle", async () => {
    const fake = fakeDevice();
    const gates: Array<() => void> = [];
    const { atlas } = atlasWith({
      preferAsyncRaster: true,
      rasterizeText: async () => {
        await new Promise<void>((resolve) => gates.push(resolve));
        return pixels(40, 16);
      },
    });
    atlas.attach(fake.device);

    for (let i = 0; i < 6; i += 1) {
      atlas.acquire(textQuad({ ...textRun, text: `pending-${i}` }), 1);
    }
    const bounded = atlas.pendingKeys(3);
    expect(bounded.length).toBe(3);
    expect(bounded[0]!.kind).toBe("text");
    expect(bounded[0]!.state).toBe("queued");
    expect(bounded[0]!.scale).toBe(1);
    expect(bounded[0]!.width).toBeGreaterThan(0);
    expect(bounded[0]!.height).toBeGreaterThan(0);
    expect(bounded[0]!.sourceRef).toBeNull();

    await settle();
    while (gates.length > 0) {
      gates.shift()!();
      await settle();
    }
    expect(atlas.stats().pending).toBe(0);
    expect(atlas.pendingKeys().length).toBe(0);
  });

  it("bounds in-flight async raster dispatch and cancels released queued cells before rasterizing", async () => {
    const fake = fakeDevice();
    let active = 0;
    let maxActive = 0;
    let started = 0;
    const gates: Array<() => void> = [];
    const { atlas } = atlasWith({
      preferAsyncRaster: true,
      rasterizeText: async () => {
        started += 1;
        active += 1;
        if (active > maxActive) maxActive = active;
        await new Promise<void>((resolve) => gates.push(resolve));
        active -= 1;
        return pixels(24, 16);
      },
    });
    atlas.attach(fake.device);

    const cells: number[] = [];
    for (let i = 0; i < 40; i += 1) {
      cells.push(atlas.acquire(textQuad({ ...textRun, text: `burst-${i}` }), 1));
    }
    await settle();
    // Backpressure caps concurrent in-flight rasters well below 40.
    expect(maxActive).toBeGreaterThan(0);
    expect(maxActive).toBeLessThan(40);
    const startedBeforeRelease = started;
    // Release the tail cells while they are still queued; they must cancel without rasterizing.
    for (let i = startedBeforeRelease; i < cells.length; i += 1) {
      atlas.release(cells[i]!);
    }
    while (gates.length > 0) {
      gates.shift()!();
      await settle();
    }
    expect(started).toBe(startedBeforeRelease);
    expect(atlas.stats().pending).toBe(0);
  });
});

describe("the atlas's revision covers its mip levels (issue 915)", () => {
  it("moves the revision again when the smaller levels of a landed colour cell are drawn", async () => {
    const { device } = fakeDevice();
    const submits: number[] = [];
    // Only a submit that drew is the levels' draw; the page's first clear draws nothing.
    let drew = false;
    const pass = { setPipeline: () => undefined, setBindGroup: () => undefined, setScissorRect: () => undefined, draw: () => { drew = true; }, end: () => undefined };
    const withMips = {
      ...device,
      createShaderModule: () => ({}),
      createBindGroupLayout: () => ({}),
      createPipelineLayout: () => ({}),
      createRenderPipeline: () => ({}),
      createBindGroup: () => ({}),
      createCommandEncoder: () => ({ ...device.createCommandEncoder(), beginRenderPass: () => pass }),
      queue: {
        ...device.queue,
        submit: () => {
          if (drew) submits.push(atlas.revision());
          drew = false;
        },
      },
    } as unknown as GPUDevice;
    const { atlas } = atlasWith();
    atlas.attach(withMips);
    // A colour cell (rgba, with smaller levels); text is coverage and has none.
    atlas.acquire(spriteQuad({ atlas: "glyph", name: "plus" }), 2);
    // The raster lands and marks the atlas; its smaller levels are drawn after.
    for (let i = 0; i < 6 && submits.length === 0; i += 1) await settle();
    expect(submits.length).toBeGreaterThan(0);
    // A frame that read the revision before the levels were drawn sees a new one.
    expect(atlas.revision()).toBeGreaterThan(submits.at(-1)!);
  });
});

describe("texel (0,0) of page 0, which every empty row reads, is no cell's", () => {
  /** A text raster is exactly as large as its run says: `width` by `size`, at scale 1. */
  const boxed = (size: number) => atlasWith({ size, rasterizeText: async (run) => pixels(run.width, run.size) });
  const line = (text: string, width: number, height: number): Quad => textQuad({ ...textRun, text, width, size: height });
  /** Where a cell's rect starts, in texels of its page, and the page. */
  const placeOf = (atlas: ReturnType<typeof boxed>["atlas"], cell: number, size: number) => {
    const row = atlas.binding.cells.subarray(atlas.cellIndex(cell) * ATLAS_CELL_FLOATS, atlas.cellIndex(cell) * ATLAS_CELL_FLOATS + ATLAS_CELL_FLOATS);
    return { x: Math.round(row[0]! * size), y: Math.round(row[1]! * size), page: row[4]! };
  };
  const landed = async (): Promise<void> => {
    await settle();
    await settle();
  };

  // 1024 px pages: square plots of 512, strips of 1024 by 512, and a full page of 1024.
  // The coverage gutter is 1, so 511 and 1023 px are a whole plot's width.
  it.each([
    ["a square plot", 511, 10],
    ["a strip", 1023, 10],
    ["a whole page", 1023, 600],
  ])("the first raster of a pool, as wide as %s, lands on the row below it", async (_plot, width, height) => {
    const { atlas } = boxed(1024);
    atlas.attach(fakeDevice().device);
    const cell = atlas.acquire(line("wide", width, height), 1);
    await landed();
    expect(atlas.hasImage(cell)).toBe(true);
    expect(placeOf(atlas, cell, 1024)).toEqual({ x: 0, y: 1, page: 0 });
    expect(atlas.audit().counts).toEqual({});
  });

  it("a plot emptied for room starts over past it: the next raster as wide as the plot lands below", async () => {
    const { atlas } = boxed(64);
    atlas.attach(fakeDevice().device);
    // A small line takes page 0's one plot, beside the texel, and is let go.
    const small = atlas.acquire(line("small", 20, 10), 1);
    await landed();
    expect(placeOf(atlas, small, 64)).toEqual({ x: 1, y: 0, page: 0 });
    atlas.release(small);

    // 63 px and the gutter are the plot's 64, and 60 rows do not fit under
    // the small line, so the plot is wiped for it and starts over.
    const wide = atlas.acquire(line("wide", 63, 60), 1);
    await landed();
    expect(atlas.stats().evictions).toBe(1);
    expect(atlas.stats().pages).toBe(1);
    expect(atlas.hasImage(wide)).toBe(true);
    expect(placeOf(atlas, wide, 64)).toEqual({ x: 0, y: 1, page: 0 });
    expect(atlas.audit().counts).toEqual({});
  });

  it("a raster as large as a whole plot wipes a plot it fits in, not the plot that holds the texel", async () => {
    const { atlas } = boxed(1024);
    atlas.attach(fakeDevice().device);
    // The plot at the origin holds a small line; it is the plot used longest ago.
    const small = atlas.acquire(line("small", 20, 10), 1);
    await landed();
    atlas.release(small);
    // Three rasters of 511 by 511, a plot each with the gutter, fill the page's other plots.
    const filling = ["a", "b", "c"].map((text) => atlas.acquire(line(text, 511, 511), 1));
    await landed();
    expect(filling.map((cell) => placeOf(atlas, cell, 1024))).toEqual([
      { x: 512, y: 0, page: 0 },
      { x: 0, y: 512, page: 0 },
      { x: 512, y: 512, page: 0 },
    ]);
    for (const cell of filling) atlas.release(cell);
    expect(atlas.stats().pages).toBe(1);

    // A fourth cannot go beside the texel or below it. Wiping that plot would
    // make no room: the plot wiped is the oldest one the raster fits in.
    const fourth = atlas.acquire(line("d", 511, 511), 1);
    await landed();
    expect(atlas.hasImage(fourth)).toBe(true);
    expect(placeOf(atlas, fourth, 1024)).toEqual({ x: 512, y: 0, page: 0 });
    expect(atlas.stats().pages).toBe(1);
    expect(atlas.stats().evictions).toBe(1);
    // The small line is still there: asking it again needs no raster.
    const requests = atlas.stats().requests;
    expect(atlas.hasImage(atlas.acquire(line("small", 20, 10), 1))).toBe(true);
    expect(atlas.stats().requests).toBe(requests);
    expect(atlas.audit().counts).toEqual({});
  });

  it("a raster as large as page 0's only plot lands at once, on a second page", async () => {
    const { atlas, failureMessages } = boxed(64);
    atlas.attach(fakeDevice().device);
    // 63 by 63 and the gutter are the whole 64 px page: it fits neither beside the texel nor below it.
    const whole = atlas.acquire(line("whole", 63, 63), 1);
    await landed();
    expect(atlas.hasImage(whole)).toBe(true);
    expect(placeOf(atlas, whole, 64)).toEqual({ x: 0, y: 0, page: 1 });
    expect(failureMessages).toEqual([]);
    // Page 0 was made for it and is still the next small raster's.
    const small = atlas.acquire(line("small", 20, 10), 1);
    await landed();
    expect(placeOf(atlas, small, 64)).toEqual({ x: 1, y: 0, page: 0 });
    expect(atlas.stats().pages).toBe(2);
    expect(atlas.audit().counts).toEqual({});
  });
});

describe("a failed slot is tried again by the atlas, with nobody asking", () => {
  beforeEach(fakeClock);

  const media = (ref: string): Quad => spriteQuad({ atlas: "media", ref: `junto-content://object/${ref}`, fit: "contain" });
  /** The queue turns, a raster settles and its landing is flushed. */
  const turn = async (): Promise<void> => {
    await settle();
    await settle();
  };
  const pass = async (ms: number): Promise<void> => {
    vi.advanceTimersByTime(ms);
    await turn();
  };
  /** A sprite rasterizer that fails the first `failing` rasters of each source, and counts them all. */
  const flaky = (failing: (ref: string) => number) => {
    const made = new Map<string, number>();
    const rasterizeSprite: NonNullable<GpuAtlasOptions["rasterizeSprite"]> = async (quad) => {
      const ref = (quad.sprite as { readonly ref: string }).ref.replace("junto-content://object/", "");
      const nth = (made.get(ref) ?? 0) + 1;
      made.set(ref, nth);
      if (nth <= failing(ref)) throw new Error("no decode");
      return pixels(16, 16);
    };
    return { rasterizeSprite, rasters: (ref: string): number => made.get(ref) ?? 0 };
  };

  it("an asynchronous raster that failed is asked again when its back-off runs out, and its landing marks the atlas dirty", async () => {
    const source = flaky(() => 1);
    const { atlas, dirty, failureMessages } = atlasWith({ rasterizeSprite: source.rasterizeSprite });
    atlas.attach(fakeDevice().device);
    const cell = atlas.acquire(media("once"), 1);
    await turn();
    expect(source.rasters("once")).toBe(1);
    expect(atlas.hasImage(cell)).toBe(false);
    expect(atlas.stats()).toMatchObject({ failedCells: 1, pending: 0, failures: 1 });
    expect(failureMessages).toHaveLength(1);

    // Nobody asks again. A millisecond short of the back-off nothing has moved.
    await pass(249);
    expect(source.rasters("once")).toBe(1);
    expect(atlas.stats().failedCells).toBe(1);

    const flushes = dirty.length;
    await pass(1);
    expect(source.rasters("once")).toBe(2);
    expect(atlas.hasImage(cell)).toBe(true);
    expect(atlas.stats()).toMatchObject({ failedCells: 0, pending: 0, failures: 1 });
    expect(dirty.length).toBeGreaterThan(flushes);
    // Nothing is failed, so nothing is waited for.
    expect(vi.getTimerCount()).toBe(0);
    expect(atlas.audit().counts).toEqual({});
  });

  it("the back-off doubles while a raster keeps failing, to eight seconds, and stays there", async () => {
    const source = flaky(() => Number.POSITIVE_INFINITY);
    const { atlas } = atlasWith({ rasterizeSprite: source.rasterizeSprite });
    atlas.attach(fakeDevice().device);
    atlas.acquire(media("never"), 1);
    await turn();
    let rasters = 1;
    for (const wait of [250, 500, 1000, 2000, 4000, 8000, 8000, 8000]) {
      await pass(wait - 1);
      expect(source.rasters("never")).toBe(rasters);
      await pass(1);
      rasters += 1;
      expect(source.rasters("never")).toBe(rasters);
      expect(atlas.stats()).toMatchObject({ failedCells: 1, pending: 0 });
      expect(vi.getTimerCount()).toBe(1);
    }
    expect(atlas.audit().counts).toEqual({});
  });

  it("one timer waits for the earliest of the failed slots", async () => {
    const source = flaky(() => 1);
    const { atlas } = atlasWith({ rasterizeSprite: source.rasterizeSprite });
    atlas.attach(fakeDevice().device);
    const first = atlas.acquire(media("first"), 1);
    await turn();
    await pass(100);
    const second = atlas.acquire(media("second"), 1);
    await turn();
    // Both failed, 100 ms apart: one timer, for the first.
    expect(atlas.stats().failedCells).toBe(2);
    expect(vi.getTimerCount()).toBe(1);
    expect(atlas.audit().counts).toEqual({});

    await pass(150);
    expect([atlas.hasImage(first), atlas.hasImage(second)]).toEqual([true, false]);
    expect([source.rasters("first"), source.rasters("second")]).toEqual([2, 1]);
    // Set again, for the second.
    expect(vi.getTimerCount()).toBe(1);
    expect(atlas.audit().counts).toEqual({});

    await pass(99);
    expect(source.rasters("second")).toBe(1);
    await pass(1);
    expect(atlas.hasImage(second)).toBe(true);
    expect(atlas.stats().failedCells).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("the timer comes forward for a slot that fails with a shorter back-off than the one it waits for", async () => {
    const source = flaky((ref) => (ref === "never" ? Number.POSITIVE_INFINITY : 1));
    const { atlas } = atlasWith({ rasterizeSprite: source.rasterizeSprite });
    atlas.attach(fakeDevice().device);
    atlas.acquire(media("never"), 1);
    await turn();
    // Rasters at 0, 250 and 750 ms have failed: the next is due at 1750.
    await pass(250);
    await pass(500);
    expect(source.rasters("never")).toBe(3);
    await pass(50);

    // At 800 ms another source fails for the first time: due at 1050.
    const once = atlas.acquire(media("once"), 1);
    await turn();
    expect(atlas.stats().failedCells).toBe(2);
    expect(vi.getTimerCount()).toBe(1);
    expect(atlas.audit().counts).toEqual({});

    await pass(250);
    expect(atlas.hasImage(once)).toBe(true);
    expect(source.rasters("never")).toBe(3);
    await pass(699);
    expect(source.rasters("never")).toBe(3);
    await pass(1);
    expect(source.rasters("never")).toBe(4);
  });

  it.each([
    ["a page", 20],
    ["a texture of its own", 100],
  ])("a raster with nowhere to land, because %s could not be made, lands when the back-off runs out", async (_what, width) => {
    const fake = fakeDevice();
    // The device cannot make one texture.
    const device = fake.device as unknown as { createTexture: (desc: GPUTextureDescriptor) => unknown };
    const make = device.createTexture;
    let refuse = false;
    device.createTexture = (desc) => {
      if (refuse) {
        refuse = false;
        throw new Error("no memory");
      }
      return make(desc);
    };
    // 64 px pages: a line of 20 px goes on a page, one of 100 px takes a texture of its own.
    const { atlas } = atlasWith({ size: 64, rasterizeText: async () => pixels(width, 10) });
    atlas.attach(fake.device);
    refuse = true;
    const cell = atlas.acquire(textQuad(), 1);
    await turn();
    expect(refuse).toBe(false);
    expect(atlas.hasImage(cell)).toBe(false);
    expect(atlas.stats()).toMatchObject({ failedCells: 1, pending: 0 });

    await pass(250);
    expect(atlas.hasImage(cell)).toBe(true);
    expect(atlas.stats()).toMatchObject({ failedCells: 0, pending: 0 });
    expect(atlas.audit().counts).toEqual({});
  });

  it("a held cell whose page the device answers out of memory for is rastered again", async () => {
    const fake = fakeDevice();
    // The out-of-memory answer for each texture is the test's to give, in the order they were made.
    const answers: Array<(error: { readonly message: string } | null) => void> = [];
    (fake.device as unknown as { popErrorScope: () => Promise<{ readonly message: string } | null> }).popErrorScope = () =>
      new Promise((resolve) => {
        answers.push(resolve);
      });
    let rasters = 0;
    const { atlas } = atlasWith({
      rasterizeText: async () => {
        rasters += 1;
        return pixels(20, 10);
      },
    });
    atlas.attach(fake.device);
    const cell = atlas.acquire(textQuad(), 1);
    await turn();
    expect(atlas.hasImage(cell)).toBe(true);
    expect(rasters).toBe(1);

    // The last texture made is the page the line landed on.
    answers.at(-1)!({ message: "out of memory" });
    await turn();
    expect(atlas.hasImage(cell)).toBe(false);
    expect(atlas.stats()).toMatchObject({ failedCells: 1, pending: 0, pages: 0 });

    // The quad holds its cell and asks nothing.
    await pass(249);
    expect(rasters).toBe(1);
    await pass(1);
    expect(rasters).toBe(2);
    expect(atlas.hasImage(cell)).toBe(true);
    expect(atlas.stats()).toMatchObject({ failedCells: 0, pending: 0, pages: 1 });
    expect(atlas.audit().counts).toEqual({});
  });

  it.each([
    ["a page", 20],
    ["a texture of its own", 100],
  ])("a late out-of-memory answer for %s backs off again after every landing", async (_what, width) => {
    const fake = fakeDevice();
    // The out-of-memory answer for each texture is the test's to give, in the order they were made.
    const answers: Array<(error: { readonly message: string } | null) => void> = [];
    (fake.device as unknown as { popErrorScope: () => Promise<{ readonly message: string } | null> }).popErrorScope = () =>
      new Promise((resolve) => {
        answers.push(resolve);
      });
    let rasters = 0;
    // 64 px pages: a line of 20 px goes on a page, one of 100 px takes a texture of its own.
    const { atlas } = atlasWith({
      size: 64,
      rasterizeText: async () => {
        rasters += 1;
        return pixels(width, 10);
      },
    });
    atlas.attach(fake.device);
    const cell = atlas.acquire(textQuad(), 1);
    await turn();
    expect(atlas.hasImage(cell)).toBe(true);
    expect(rasters).toBe(1);

    // The device keeps answering out of memory after the landing. Each wait
    // doubles although a landing came between: 250, 500, 1000, and so on.
    for (const [n, wait] of [250, 500, 1000, 2000, 4000, 8000, 8000].entries()) {
      answers.at(-1)!({ message: "out of memory" });
      await turn();
      expect(atlas.hasImage(cell)).toBe(false);
      expect(atlas.stats()).toMatchObject({ failedCells: 1, pending: 0 });

      await pass(wait - 1);
      expect(rasters).toBe(n + 1);
      await pass(1);
      expect(rasters).toBe(n + 2);
      expect(atlas.hasImage(cell)).toBe(true);
    }

    // The last texture is there. Nothing is failed, and nothing is waited for.
    answers.at(-1)!(null);
    await turn();
    expect(atlas.stats()).toMatchObject({ failedCells: 0, pending: 0 });
    expect(vi.getTimerCount()).toBe(0);
    expect(atlas.audit().counts).toEqual({});
  });

  it("a failed cell that is let go is not tried again, and the timer goes with the device and with the atlas", async () => {
    const source = flaky(() => Number.POSITIVE_INFINITY);
    const { atlas } = atlasWith({ rasterizeSprite: source.rasterizeSprite });
    atlas.attach(fakeDevice().device);

    // Let go: the slot is freed, and the timer finds nothing to try.
    const gone = atlas.acquire(media("gone"), 1);
    await turn();
    expect(atlas.stats().failedCells).toBe(1);
    atlas.release(gone);
    expect(atlas.stats().failedCells).toBe(0);
    await pass(60_000);
    expect(source.rasters("gone")).toBe(1);
    expect(vi.getTimerCount()).toBe(0);

    // A new device: every held slot is rastered at once, and nothing waits on the old back-off.
    atlas.acquire(media("held"), 1);
    await turn();
    expect(vi.getTimerCount()).toBe(1);
    atlas.attach(fakeDevice().device);
    expect(vi.getTimerCount()).toBe(0);
    expect(atlas.stats().failedCells).toBe(0);
    await turn();
    expect(source.rasters("held")).toBe(2);
    // It failed on the new device too, and is waited for again. The count of
    // failures was the old device's, so the first back-off is 250 ms again.
    expect(atlas.stats().failedCells).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    await pass(249);
    expect(source.rasters("held")).toBe(2);
    await pass(1);
    expect(source.rasters("held")).toBe(3);

    atlas.dispose();
    expect(vi.getTimerCount()).toBe(0);
    await pass(60_000);
    expect(source.rasters("held")).toBe(3);
  });
});

describe("gpu atlas rerasters: keys asked again after their landed cell was freed (ladder thrash)", () => {
  const twice = async (): Promise<void> => {
    await settle();
    await settle();
  };

  it("a key evicted for room and asked again counts once, gone no later than asked", async () => {
    const { atlas } = atlasWith({ size: 64, rasterizeText: async () => pixels(40, 40) });
    atlas.attach(fakeDevice().device);
    const a = atlas.acquire(textQuad({ ...textRun, text: "a" }), 1);
    await twice();
    atlas.release(a);
    // b needs a's plot: a's cell is freed for room.
    const b = atlas.acquire(textQuad({ ...textRun, text: "b" }), 1);
    await twice();
    expect(atlas.stats().evictions).toBe(1);
    expect(atlas.stats().rerasters).toBe(0);
    atlas.release(b);
    atlas.acquire(textQuad({ ...textRun, text: "a" }), 1);
    await twice();
    expect(atlas.stats().rerasters).toBe(1);
    const log = atlas.rerasterLog();
    expect(log).toHaveLength(1);
    expect(log[0]!.evictedAt).toBeLessThanOrEqual(log[0]!.at);
    // Asked once more while it holds its cell: nothing new.
    atlas.acquire(textQuad({ ...textRun, text: "a" }), 1);
    expect(atlas.stats().rerasters).toBe(1);
    // The stats a poll reads carry the number, never the list.
    expect("rerasterLog" in atlas.stats()).toBe(false);
    // A limit of 0, below 0 or not a number asks for nothing.
    expect(atlas.rerasterLog(0)).toEqual([]);
    expect(atlas.rerasterLog(-3)).toEqual([]);
    expect(atlas.rerasterLog(Number.NaN)).toEqual([]);
    expect(atlas.rerasterLog(1)).toHaveLength(1);
  });

  it("a line written over counts nothing", async () => {
    const run1: TextRun = { text: "step 1", font: "mono", size: 11, weight: 400, truncate: "end", width: 80 };
    const run2: TextRun = { text: "step 2", font: "mono", size: 11, weight: 400, truncate: "end", width: 80 };
    const { atlas } = atlasWith({ rasterizeText: async () => pixels(160, 27) });
    atlas.attach(fakeDevice().device);
    const first = atlas.acquire(textQuad(run1), 2);
    await twice();
    const second = atlas.acquire(textQuad(run2), 2, first);
    await twice();
    expect(atlas.stats().overwrites).toBe(1);
    atlas.acquire(textQuad(run1), 2, second);
    await twice();
    expect(atlas.stats().rerasters).toBe(0);
  });

  it("a device attached anew counts nothing", async () => {
    const { atlas } = atlasWith();
    atlas.attach(fakeDevice().device);
    const keep = atlas.acquire(textQuad({ ...textRun, text: "keep" }), 2);
    const drop = atlas.acquire(textQuad({ ...textRun, text: "drop" }), 2);
    await twice();
    atlas.release(drop);
    atlas.attach(fakeDevice().device);
    await twice();
    expect(atlas.hasImage(keep)).toBe(true);
    atlas.acquire(textQuad({ ...textRun, text: "drop" }), 2);
    await twice();
    expect(atlas.stats().rerasters).toBe(0);
  });

  it("a slot let go before it landed counts nothing", async () => {
    const { atlas } = atlasWith();
    atlas.attach(fakeDevice().device);
    const early = atlas.acquire(textQuad({ ...textRun, text: "early" }), 1);
    atlas.release(early);
    await twice();
    atlas.acquire(textQuad({ ...textRun, text: "early" }), 1);
    await twice();
    expect(atlas.stats().rerasters).toBe(0);
    expect(atlas.rerasterLog()).toEqual([]);
  });
});

describe("gpu atlas ownImage: a cell shows its own landed pixels (the pop check)", () => {
  it("is false for no cell, false while a stand-in shows, true once its own land, false for a failed cell", async () => {
    let letLand!: () => void;
    const gate = new Promise<void>((resolve) => {
      letLand = resolve;
    });
    const { atlas } = atlasWith({
      rasterizeText: async (run, scale) => {
        if (run.text === "broken") throw new Error("raster failed");
        if (scale === 2) await gate;
        return pixels(20, 10);
      },
    });
    atlas.attach(fakeDevice().device);
    expect(atlas.ownImage(NO_ATLAS_CELL)).toBe(false);
    const small = atlas.acquire(textQuad(), 1);
    await settle();
    await settle();
    expect(atlas.ownImage(small)).toBe(true);
    // The same text at 2 shows the 1x pixels until its own land.
    const big = atlas.acquire(textQuad(), 2);
    expect(atlas.hasImage(big)).toBe(true);
    expect(atlas.ownImage(big)).toBe(false);
    letLand();
    await settle();
    await settle();
    expect(atlas.ownImage(big)).toBe(true);
    const broken = atlas.acquire(textQuad({ ...textRun, text: "broken" }), 1);
    await settle();
    await settle();
    expect(atlas.stats().failures).toBeGreaterThan(0);
    expect(atlas.ownImage(broken)).toBe(false);
  });
});
