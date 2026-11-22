/**
 * The GPU atlas binding (docs/canvas-gpu-architecture.md sections 8 and 9;
 * engine/types.ts AtlasBinding; artifact 01M81DHBBYRVN3MKJMR3MMCZ31 v5).
 *
 * A multi-page `texture_2d_array<f32>` sized from `device.limits`, with
 * height-classed shelves, reference-counted stable indices, LRU reclaim of
 * unreferenced (off-screen) cells, on-demand page growth when referenced cells
 * do not fit, UV-alias stand-ins and replacement-previous continuity, sync
 * `ensureNow()` fallback, backoff retry on failure, true-ink text coverage,
 * and zero retained ImageBitmaps.
 *
 * The engine stays DOM-free: every rasterizer is injected. The browser
 * implementations live at the bottom of this file (`browserRasterizers`).
 */

import type { ColorRef, Quad, TextRun } from "../contract";
import { gpuColorCss, themeGpu, type GpuColor, type GpuTheme, type ThemeMode } from "@shared/theme";
import { NO_ATLAS_CELL } from "./quad";
import { ATLAS_CELL_FLOATS, atlasBindBudget, type AtlasBinding, type AtlasDirtyCells, type AtlasStats } from "./types";
import { resolveColour } from "./styles";
import { drawGlyph, glyphKnown } from "./glyphs";
import {
  fontCss,
  HALO_SIGMA_PER_RADIUS,
  haloPadDevice,
  layoutRun,
  runKey,
  type MeasureContext,
} from "./text";
import { MARK_CELL, paintMarkAtlasCanvas } from "../../lib/activity-atlas";
import type { RasterWorkerRequest, RasterWorkerResponse } from "./raster-worker";

/** One-channel 8-bit coverage buffer (for r8unorm text pages, 1 byte/px). */
export type AtlasCoverage = {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
};

/**
 * Anything the GPU can upload into the atlas: an ImageBitmap, canvas, r8unorm
 * coverage buffer, or a sub-rect view into a grow-only scratch canvas.
 */
export type AtlasCanvasRegion = {
  readonly source: HTMLCanvasElement | OffscreenCanvas;
  readonly width: number;
  readonly height: number;
};
export type AtlasPixels = ImageBitmap | HTMLCanvasElement | OffscreenCanvas | AtlasCoverage | AtlasCanvasRegion;

export interface TextRasterize {
  (run: TextRun, scale: number, ink: GpuColor): Promise<AtlasPixels>;
}
export interface TextRasterizeSync {
  (run: TextRun, scale: number, ink: GpuColor): AtlasPixels;
}
export interface SpriteRasterize {
  (quad: Quad, mode: ThemeMode, scale: number): Promise<AtlasPixels>;
}
export interface SpriteRasterizeSync {
  (quad: Quad, mode: ThemeMode, scale: number): AtlasPixels | undefined;
}

export interface GpuAtlasOptions {
  /** Preferred page edge in pixels (clamped to `device.limits.maxTextureDimension2D`). */
  readonly size?: number;
  readonly rasterizeText?: TextRasterize;
  readonly rasterizeTextSync?: TextRasterizeSync;
  readonly rasterizeSprite?: SpriteRasterize;
  readonly rasterizeSpriteSync?: SpriteRasterizeSync;
  readonly mode?: ThemeMode;
  /** Fired (batched, once per task) when landed cells or pages changed the texture or UVs. */
  readonly onDirty?: () => void;
  /** Reported when a real GPU allocation or raster failure occurs. */
  readonly onFailure?: (reason: string) => void;
  /** Optional measured display frame interval (ms) for deriving queue drain yield slice. */
  readonly frameIntervalMs?: () => number;
  /**
   * When true, queued background rasters prefer async (worker-thread) rasterizers
   * so the main thread stays free; `ensureNow()` still uses sync rasterizers.
   */
  readonly preferAsyncRaster?: boolean;
}

export interface GpuAtlas {
  /** The live binding: `texture`, `sampler`, `cells`, `cellCount`, `textureGeneration`. */
  readonly binding: AtlasBinding;
  /** Attach the device the atlas uploads into; safe to call again per generation. */
  attach(device: GPUDevice): void;
  /** Theme switch: sprite and text keys carry the mode, so new asks rasterize anew. */
  setMode(mode: ThemeMode): void;
  /**
   * Acquire a stable cell index for `quad` at `scale`, taking one reference.
   * `previous` is the index this record previously held:
   * - Same key: returns `previous` (net 0 ref change).
   * - New key, `previous` has refCount 1 and same pixel box (and is placed):
   *   re-keys `previous` in place and overwrites its rect when the new raster lands.
   * - New key otherwise: keeps `previous` referenced and aliased in the new cell's
   *   UVs until the new cell lands (or is released), so nothing flashes blank.
   * Returns `NO_ATLAS_CELL` only when the quad has nothing to draw.
   */
  acquire(quad: Quad, scale: number, previous?: number): number;
  /** Release one reference to `cell`. At zero references it stays cached (LRU) until reclaimed. */
  release(cell: number): void;
  /** True when `cell` currently points at pixels (its own, a stand-in, or an aliased previous). */
  hasImage(cell: number): boolean;
  /**
   * Last-resort synchronous raster + copy before frame submit for an in-view cell
   * that still has no image. Draws a tone placeholder in place if a cold image/media
   * source is still decoding so nothing on screen is ever blank. Returns `hasImage(cell)`.
   */
  ensureNow(cell: number): boolean;
  /** Pre-decode an image/media sprite source ahead of time (e.g. in the shape build range). */
  prepareSource(quad: Quad): void;
  /** Release a pre-decoded image/media source reference when a card leaves the build range. */
  releaseSource(quad: Quad): void;
  /** Record the count of on-screen text/sprite quads drawn with no image on a presented frame. */
  recordVisibleBlank(count: number): void;
  /** Compat wrapper for callers that have not switched to `acquire`/`release` yet. */
  sourceFor(quad: Quad, scale: number): number;
  /** Bumped every time landed cells or pages change the texture or UV table. */
  revision(): number;
  /** Observable counters for diagnostics and the test hook. */
  stats(): AtlasStats;
  readonly requests: number;
  readonly pending: number;
  /** Evict unreferenced decoded sources on a real memory-pressure event. */
  notifyMemoryPressure?(): void;
  dispose(): void;
}

type PoolKind = "rgba" | "coverage";
type PageLayout = "grid" | "strip" | "full";

interface Plot {
  readonly x0: number;
  readonly y0: number;
  readonly w: number;
  readonly h: number;
  cursorX: number;
  cursorY: number;
  rowH: number;
  readonly cells: Set<number>;
  pinnedCount: number;
  floorPinnedCount: number;
  lastUsedTick: number;
}

interface Page {
  readonly pageIndex: number;
  readonly layout: PageLayout;
  readonly texture: GPUTexture;
  readonly size: number;
  readonly bytes: number;
  readonly mipCount: number;
  readonly plots: Plot[];
  dead: boolean;
}

interface Placed {
  readonly pool: PoolKind;
  readonly page: Page;
  readonly plot: Plot;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

interface PagePool {
  readonly kind: PoolKind;
  readonly format: GPUTextureFormat;
  readonly bytesPerPixel: number;
  readonly usage: number;
  pageSize: number;
  bindLimit: number;
  readonly pages: Page[];
  readonly pageTextures: GPUTexture[];
}

interface DirtyMipRect {
  readonly texture: GPUTexture;
  readonly mipCount: number;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly gutter: number;
}

type CellState = "queued" | "rasterizing" | "landed" | "failed";

interface CellDesc {
  readonly quad: Quad;
  readonly scale: number;
  readonly mode: ThemeMode;
  readonly kind: "text" | "sprite";
}

interface StandalonePlaced {
  readonly texture: GPUTexture;
  readonly w: number;
  readonly h: number;
  readonly tileW: number;
  readonly tileH: number;
  readonly tilesX: number;
  readonly tilesY: number;
  readonly bytes: number;
}

interface SlotRecord {
  readonly index: number;
  key: string;
  contentKey: string;
  scale: number;
  refCount: number;
  state: CellState;
  placed?: Placed;
  standalone?: StandalonePlaced;
  aliasOf?: number;
  inPlace?: boolean;
  isFloor?: boolean;
  attempts: number;
  retryAfter: number;
  desc?: CellDesc;
  jobToken: number;
}

const PREFERRED_PAGE_SIZE = 2048;
const PREFERRED_COVERAGE_PAGE_SIZE = 4096; // 1 byte/px -> 16 MB, same memory as one 2048 RGBA page
const PREFERRED_PLOT_SIZE = 512;
const RGBA_MAX_MIP_LEVELS = 4; // 1x, 1/2x, 1/4x, 1/8x -> needs 8px gutter
const INITIAL_CELL_CAPACITY = 256;
const TEXTURE_USAGE_ATLAS = 0x01 | 0x02 | 0x04 | 0x10; // COPY_SRC | COPY_DST | TEXTURE_BINDING | RENDER_ATTACHMENT
const TEXTURE_USAGE_COVERAGE = 0x01 | 0x02 | 0x04; // COPY_SRC | COPY_DST | TEXTURE_BINDING (writeTexture needs no RENDER_ATTACHMENT)
const BASE_RETRY_MS = 250;
const MAX_RETRY_MS = 8000;

const MIP_BLIT_SHADER = /* wgsl */ `
@group(0) @binding(0) var srcTex: texture_2d<f32>;
@group(0) @binding(1) var srcSamp: sampler;
struct MipOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
};
@vertex fn vs(@builtin(vertex_index) vi: u32) -> MipOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var u = array<vec2f, 3>(vec2f(0.0, 1.0), vec2f(2.0, 1.0), vec2f(0.0, -1.0));
  var o: MipOut;
  o.pos = vec4f(p[vi], 0.0, 1.0);
  o.uv = u[vi];
  return o;
}
@fragment fn fs(in: MipOut) -> @location(0) vec4f {
  return textureSample(srcTex, srcSamp, in.uv);
}
`;

const closePixels = (pixels: AtlasPixels): void => {
  if (typeof (pixels as { close?: unknown }).close === "function") {
    (pixels as ImageBitmap).close();
  }
};

const nowMs = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());

export const createGpuAtlas = (options: GpuAtlasOptions = {}): GpuAtlas => {
  const explicitSize = options.size !== undefined ? Math.max(64, options.size) : undefined;
  const preferredSize = explicitSize ?? PREFERRED_PAGE_SIZE;
  let pageSize = preferredSize;
  let maxTexDim = 8192;
  let maxArrayLayers = 256;
  let maxCellsByLimit = Number.MAX_SAFE_INTEGER;
  let mode: ThemeMode = options.mode ?? "dark";

  // Measured display frame interval (ms) for deriving the queue drain yield slice
  // from the machine's actual refresh cadence (no hardcoded slice constant).
  let measuredFrameMs = 16.67;
  let lastRafAt = 0;
  let rafSampling = false;
  const sampleFrameInterval = (): void => {
    if (options.frameIntervalMs !== undefined || rafSampling || disposed || typeof requestAnimationFrame !== "function") return;
    rafSampling = true;
    requestAnimationFrame((t1) => {
      lastRafAt = t1;
      if (disposed) return;
      requestAnimationFrame((t2) => {
        rafSampling = false;
        const dt = t2 - lastRafAt;
        if (dt > 1 && dt < 100) measuredFrameMs = measuredFrameMs * 0.5 + dt * 0.5;
      });
    });
  };
  const drainYieldMs = (): number => {
    const interval = options.frameIntervalMs?.() ?? measuredFrameMs;
    return Math.max(1, interval * 0.25);
  };

  let cells = new Float32Array(INITIAL_CELL_CAPACITY * ATLAS_CELL_FLOATS);
  let cellCapacity = INITIAL_CELL_CAPACITY;
  let highWaterCells = 0;

  const slots: Array<SlotRecord | undefined> = [];
  const freeIndices: number[] = [];
  const keyToIndex = new Map<string, number>();
  /** contentKey -> set of landed slot indices (for nearest-bucket stand-in lookup). */
  const contentLanded = new Map<string, Set<number>>();
  /** Insertion-ordered LRU of unreferenced (refCount === 0) landed/placed slot indices. */
  const unreferencedLru = new Map<number, true>();
  /** Standalone full-resolution textures for cells larger than a packing page. */
  const standaloneTextures = new Map<number, GPUTexture>();
  let standaloneBytes = 0;
  /** Dirty cell slots since last renderer upload (for partial cells-buffer writes). */
  const dirtyCellSlots = new Set<number>();
  let allCellsDirty = true;
  /** Compat tracking so repeated `sourceFor` calls for the same key don't leak refs. */
  const compatHeld = new Set<string>();

  const queue: number[] = [];
  const queuedSet = new Set<number>();
  let drainScheduled = false;
  let inFlightCount = 0;

  let device: GPUDevice | undefined;
  let sampler: GPUSampler | undefined;
  let dummyRgbaTex: GPUTexture | undefined;
  let dummyCovTex: GPUTexture | undefined;
  let mipPipeline: GPURenderPipeline | undefined;
  let mipBindLayout: GPUBindGroupLayout | undefined;
  let rgbaMipCount = 1;
  let plotTick = 1;
  const dirtyMipRects: DirtyMipRect[] = [];
  const rgbaPool: PagePool = {
    kind: "rgba",
    format: "rgba8unorm",
    bytesPerPixel: 4,
    usage: TEXTURE_USAGE_ATLAS,
    pageSize: preferredSize,
    bindLimit: 8,
    pages: [],
    pageTextures: [],
  };
  const coveragePool: PagePool = {
    kind: "coverage",
    format: "r8unorm",
    bytesPerPixel: 1,
    usage: TEXTURE_USAGE_COVERAGE,
    pageSize: explicitSize ?? PREFERRED_COVERAGE_PAGE_SIZE,
    bindLimit: 8,
    pages: [],
    pageTextures: [],
  };
  const poolFor = (kind: PoolKind): PagePool => (kind === "coverage" ? coveragePool : rgbaPool);
  const poolKindOf = (cellKind: "text" | "sprite"): PoolKind => (cellKind === "text" ? "coverage" : "rgba");
  const gutterFor = (kind: PoolKind): number =>
    kind === "rgba" && rgbaMipCount > 1 ? 1 << (rgbaMipCount - 1) : 1;

  let dirty = false;
  let flushScheduled = false;
  let disposed = false;
  let revision = 0;
  let textureGeneration = 0;
  let nextJobToken = 1;

  // Counters
  let requests = 0;
  let landedCount = 0;
  let evictions = 0;
  let failures = 0;
  let compactions = 0;
  let lostPixels = 0;
  let visibleBlank = 0;
  let visibleBlankTotal = 0;

  /**
   * Never-evicted smallest-drawn-size floor cell per contentKey (enabled on real
   * multi-plot pages >= 512px). Guarantees findStandIn always has pixels for any
   * seen item even after sharper cells are evicted.
   */
  const floorEnabled = explicitSize === undefined || explicitSize >= 512;
  const floorByContent = new Map<string, number>();
  let floorBytes = 0;
  /** Every contentKey that has landed at least once (for lostPixels rule-6 telemetry). */
  const seenContentKeys = new Set<string>();

  const takeDirtyCells = (): AtlasDirtyCells => {
    if (allCellsDirty) {
      allCellsDirty = false;
      dirtyCellSlots.clear();
      return { all: true, slots: [] };
    }
    if (dirtyCellSlots.size === 0) return { all: false, slots: [] };
    const sorted = [...dirtyCellSlots].sort((a, b) => a - b);
    dirtyCellSlots.clear();
    return { all: false, slots: sorted };
  };

  const mutable = {
    texture: undefined as unknown as GPUTexture,
    coverageTexture: undefined as unknown as GPUTexture,
    rgbaPages: rgbaPool.pageTextures as ReadonlyArray<GPUTexture>,
    coveragePages: coveragePool.pageTextures as ReadonlyArray<GPUTexture>,
    sampler: undefined as unknown as GPUSampler,
    cells,
    cellCount: 0,
    textureGeneration: 0,
    standalone: standaloneTextures as ReadonlyMap<number, GPUTexture>,
    takeDirtyCells,
  };
  const binding = mutable as AtlasBinding;

  const reportFailure = (reason: string): void => {
    failures += 1;
    options.onFailure?.(reason);
  };

  /** Scissored per-cell GPU mipmap generation: updates only the landed cell's rect per mip level. */
  const generateDirtyMipmaps = (): void => {
    if (
      dirtyMipRects.length === 0 ||
      device === undefined ||
      sampler === undefined ||
      mipPipeline === undefined ||
      mipBindLayout === undefined ||
      rgbaMipCount <= 1 ||
      typeof device.createCommandEncoder !== "function"
    ) {
      dirtyMipRects.length = 0;
      return;
    }
    const encoder = device.createCommandEncoder();
    if (typeof encoder.beginRenderPass !== "function") {
      dirtyMipRects.length = 0;
      return;
    }
    // Group rects by texture so each mip level creates one render pass per texture
    const byTex = new Map<GPUTexture, DirtyMipRect[]>();
    for (const r of dirtyMipRects) {
      let list = byTex.get(r.texture);
      if (list === undefined) {
        list = [];
        byTex.set(r.texture, list);
      }
      list.push(r);
    }
    dirtyMipRects.length = 0;

    for (const [tex, rects] of byTex) {
      const mips = rects[0]!.mipCount;
      for (let level = 1; level < mips; level += 1) {
        const mipDim = Math.max(1, pageSize >> level);
        const srcView = tex.createView({
          dimension: "2d",
          baseArrayLayer: 0,
          arrayLayerCount: 1,
          baseMipLevel: level - 1,
          mipLevelCount: 1,
        });
        const dstView = tex.createView({
          dimension: "2d",
          baseArrayLayer: 0,
          arrayLayerCount: 1,
          baseMipLevel: level,
          mipLevelCount: 1,
        });
        const bg = device.createBindGroup({
          layout: mipBindLayout,
          entries: [
            { binding: 0, resource: srcView },
            { binding: 1, resource: sampler },
          ],
        });
        const pass = encoder.beginRenderPass({
          colorAttachments: [{ view: dstView, loadOp: "load", storeOp: "store" }],
        });
        pass.setPipeline(mipPipeline);
        pass.setBindGroup(0, bg);
        for (const r of rects) {
          const sx = Math.max(0, Math.min(mipDim - 1, r.x >> level));
          const sy = Math.max(0, Math.min(mipDim - 1, r.y >> level));
          const ex = Math.min(mipDim, Math.ceil((r.x + r.w + r.gutter) / (1 << level)));
          const ey = Math.min(mipDim, Math.ceil((r.y + r.h + r.gutter) / (1 << level)));
          const sw = Math.max(1, ex - sx);
          const sh = Math.max(1, ey - sy);
          if (typeof pass.setScissorRect === "function") {
            pass.setScissorRect(sx, sy, sw, sh);
          }
          pass.draw(3);
        }
        pass.end();
      }
    }
    device.queue.submit([encoder.finish()]);
    // The smaller levels change after the frame that read the last revision
    // may have drawn from them; a new revision makes the next frame draw
    // whole, or a frame that redraws only its damage keeps the stale texels.
    revision += 1;
  };

  const flushDirty = (): void => {
    flushScheduled = false;
    if (dirty && !disposed) {
      dirty = false;
      generateDirtyMipmaps();
      options.onDirty?.();
    }
  };

  const markDirty = (): void => {
    dirty = true;
    revision += 1;
    if (!flushScheduled) {
      flushScheduled = true;
      queueMicrotask(flushDirty);
    }
  };

  const ensureCellCapacity = (needed: number): boolean => {
    if (needed <= cellCapacity) return true;
    if (needed > maxCellsByLimit) {
      reportFailure(`atlas cell count ${needed} exceeds device storage buffer limit (${maxCellsByLimit})`);
      return false;
    }
    let nextCap = cellCapacity;
    while (nextCap < needed) nextCap *= 2;
    nextCap = Math.min(nextCap, maxCellsByLimit);
    const next = new Float32Array(nextCap * ATLAS_CELL_FLOATS);
    next.set(cells);
    cells = next;
    cellCapacity = nextCap;
    mutable.cells = cells;
    allCellsDirty = true;
    return true;
  };

  const writeCellUV = (index: number, x: number, y: number, w: number, h: number, pageOrLayer: number, dim: number = pageSize): void => {
    const base = index * ATLAS_CELL_FLOATS;
    cells[base] = x / dim;
    cells[base + 1] = y / dim;
    cells[base + 2] = (x + w) / dim;
    cells[base + 3] = (y + h) / dim;
    cells[base + 4] = pageOrLayer;
    cells[base + 5] = 0;
    cells[base + 6] = 0;
    cells[base + 7] = 0;
    if (!allCellsDirty) dirtyCellSlots.add(index);
  };

  const copyCellUV = (dstIndex: number, srcIndex: number): void => {
    const d = dstIndex * ATLAS_CELL_FLOATS;
    const s = srcIndex * ATLAS_CELL_FLOATS;
    for (let i = 0; i < ATLAS_CELL_FLOATS; i += 1) {
      cells[d + i] = cells[s + i]!;
    }
    if (!allCellsDirty) dirtyCellSlots.add(dstIndex);
  };

  const clearCellUV = (index: number): void => {
    const base = index * ATLAS_CELL_FLOATS;
    for (let i = 0; i < ATLAS_CELL_FLOATS; i += 1) {
      cells[base + i] = 0;
    }
    if (!allCellsDirty) dirtyCellSlots.add(index);
  };

  const hasImage = (cell: number): boolean => {
    if (cell === NO_ATLAS_CELL || cell < 0 || cell >= highWaterCells) return false;
    const base = cell * ATLAS_CELL_FLOATS;
    return cells[base + 2]! > cells[base]! || cells[base + 3]! > cells[base + 1]!;
  };

  const addContentLanded = (contentKey: string, index: number): void => {
    let set = contentLanded.get(contentKey);
    if (set === undefined) {
      set = new Set();
      contentLanded.set(contentKey, set);
    }
    set.add(index);
  };

  const removeContentLanded = (contentKey: string, index: number): void => {
    const set = contentLanded.get(contentKey);
    if (set === undefined) return;
    set.delete(index);
    if (set.size === 0) contentLanded.delete(contentKey);
  };

  const findStandIn = (contentKey: string, scale: number, excludeIndex: number): number | undefined => {
    const set = contentLanded.get(contentKey);
    if (set === undefined || set.size === 0) return undefined;
    let best: number | undefined;
    let bestDist = Infinity;
    for (const idx of set) {
      if (idx === excludeIndex) continue;
      const rec = slots[idx];
      if (rec === undefined || rec.state !== "landed" || !hasImage(idx)) continue;
      const dist = Math.abs(Math.log2(Math.max(1e-4, rec.scale) / Math.max(1e-4, scale)));
      if (dist < bestDist) {
        bestDist = dist;
        best = idx;
      }
    }
    return best;
  };

  // --- Page & height-classed shelf allocator ----------------------------------

  // --- Skia-style plot allocator + independent per-page textures (zero-copy growth) ---

  const plotSizeFor = (pool: PagePool): number => Math.min(pool.pageSize, PREFERRED_PLOT_SIZE);

  const layoutFor = (pool: PagePool, needW: number, needH: number): PageLayout => {
    const pSize = plotSizeFor(pool);
    if (needW <= pSize && needH <= pSize) return "grid";
    if (needH <= pSize) return "strip";
    return "full";
  };

  const createTexture2DArray = (
    targetDevice: GPUDevice,
    width: number,
    height: number,
    layers: number,
    format: GPUTextureFormat = "rgba8unorm",
    usage: number = TEXTURE_USAGE_ATLAS,
    mipLevelCount = 1,
    onAsyncOom?: (tex: GPUTexture) => void,
  ): GPUTexture | undefined => {
    const hasScope = typeof targetDevice.pushErrorScope === "function" && typeof targetDevice.popErrorScope === "function";
    if (hasScope) targetDevice.pushErrorScope("out-of-memory");
    let created: GPUTexture | undefined;
    try {
      created = targetDevice.createTexture({
        size: { width, height, depthOrArrayLayers: layers },
        format,
        usage,
        ...(mipLevelCount > 1 ? { mipLevelCount } : {}),
      });
    } catch (error) {
      evictUnreferencedSourcesOnPressure();
      reportFailure(`atlas texture allocation failed (${width}x${height}x${layers} ${format}): ${String(error)}`);
      if (hasScope) void targetDevice.popErrorScope().catch(() => undefined);
      return undefined;
    }
    if (hasScope && created !== undefined) {
      const texRef = created;
      void targetDevice.popErrorScope().then((err) => {
        if (err !== null) {
          evictUnreferencedSourcesOnPressure();
          reportFailure(`atlas GPU out-of-memory (${width}x${height}x${layers} ${format}): ${err.message}`);
          onAsyncOom?.(texRef);
        }
      }).catch(() => undefined);
    }
    return created;
  };

  const clearNewPageMips = (tex: GPUTexture, mipCount: number): void => {
    if (mipCount <= 1 || device === undefined || typeof device.createCommandEncoder !== "function") return;
    const encoder = device.createCommandEncoder();
    if (typeof encoder.beginRenderPass !== "function") return;
    for (let level = 1; level < mipCount; level += 1) {
      const view = tex.createView({
        dimension: "2d",
        baseArrayLayer: 0,
        arrayLayerCount: 1,
        baseMipLevel: level,
        mipLevelCount: 1,
      });
      const pass = encoder.beginRenderPass({
        colorAttachments: [{ view, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
      });
      pass.end();
    }
    device.queue.submit([encoder.finish()]);
  };

  /**
   * Add a new independent 1-layer page texture to `pool` (zero copies of existing pages).
   * Pages within `pool.bindLimit` are published in `rgbaPages` / `coveragePages` so the
   * renderer binds every page of both pools in one bind group (keeping GPU cull on).
   * Only pages past the device's sampled-texture stage limit fall back to `standalone`.
   */
  const addPage = (pool: PagePool, layout: PageLayout): Page | undefined => {
    if (device === undefined) return undefined;
    const dim = pool.pageSize;
    const mips = pool.kind === "rgba" ? rgbaMipCount : 1;
    const pageIndex = pool.pages.length;
    let pageRef: Page | undefined;
    const tex = createTexture2DArray(
      device,
      dim,
      dim,
      1,
      pool.format,
      pool.usage,
      mips,
      (deadTex) => {
        // Async OOM: drop only this dead page, never touch live pages or shift later page indices.
        if (pageRef === undefined || pageRef.dead) return;
        pageRef.dead = true;
        for (const plot of pageRef.plots) {
          for (const cellIdx of plot.cells) {
            const rec = slots[cellIdx];
            if (rec === undefined) continue;
            rec.placed = undefined;
            standaloneTextures.delete(cellIdx);
            clearCellUV(cellIdx);
            rec.state = "failed";
            rec.attempts += 1;
            rec.retryAfter = nowMs() + BASE_RETRY_MS;
          }
          plot.cells.clear();
        }
        const fallback = pool.kind === "rgba" ? dummyRgbaTex : dummyCovTex;
        if (fallback !== undefined && pageRef.pageIndex < pool.pageTextures.length) {
          pool.pageTextures[pageRef.pageIndex] = fallback;
        }
        if (pageRef.pageIndex === 0 && fallback !== undefined) {
          if (pool.kind === "rgba") mutable.texture = fallback;
          else mutable.coverageTexture = fallback;
        }
        if (pageRef.pageIndex < pool.bindLimit) {
          textureGeneration += 1;
          mutable.textureGeneration = textureGeneration;
        }
        deadTex.destroy();
        markDirty();
      },
    );
    if (tex === undefined) return undefined;
    clearNewPageMips(tex, mips);

    const pSize = plotSizeFor(pool);
    const plots: Plot[] = [];
    if (layout === "grid") {
      const cols = Math.max(1, Math.floor(dim / pSize));
      for (let py = 0; py < cols; py += 1) {
        for (let px = 0; px < cols; px += 1) {
          plots.push({
            x0: px * pSize,
            y0: py * pSize,
            w: pSize,
            h: pSize,
            cursorX: pageIndex === 0 && px === 0 && py === 0 ? 1 : 0, // reserve (0,0) on page 0 as transparent
            cursorY: 0,
            rowH: 0,
            cells: new Set(),
            pinnedCount: 0,
            floorPinnedCount: 0,
            lastUsedTick: ++plotTick,
          });
        }
      }
    } else if (layout === "strip") {
      const rows = Math.max(1, Math.floor(dim / pSize));
      for (let py = 0; py < rows; py += 1) {
        plots.push({
          x0: 0,
          y0: py * pSize,
          w: dim,
          h: pSize,
          cursorX: pageIndex === 0 && py === 0 ? 1 : 0,
          cursorY: 0,
          rowH: 0,
          cells: new Set(),
          pinnedCount: 0,
          floorPinnedCount: 0,
          lastUsedTick: ++plotTick,
        });
      }
    } else {
      plots.push({
        x0: 0,
        y0: 0,
        w: dim,
        h: dim,
        cursorX: pageIndex === 0 ? 1 : 0,
        cursorY: 0,
        rowH: 0,
        cells: new Set(),
        pinnedCount: 0,
        floorPinnedCount: 0,
        lastUsedTick: ++plotTick,
      });
    }

    const baseBytes = dim * dim * pool.bytesPerPixel;
    const bytes = mips > 1 ? Math.round(baseBytes * (4 / 3)) : baseBytes;
    const page: Page = { pageIndex, layout, texture: tex, size: dim, bytes, mipCount: mips, plots, dead: false };
    pageRef = page;
    pool.pages.push(page);
    pool.pageTextures.push(tex);

    if (pageIndex === 0) {
      if (pool.kind === "rgba") mutable.texture = tex;
      else mutable.coverageTexture = tex;
    }
    if (pageIndex < pool.bindLimit) {
      textureGeneration += 1;
      mutable.textureGeneration = textureGeneration;
      markDirty();
    }
    return page;
  };

  const tryPlaceInPlot = (pool: PagePool, page: Page, plot: Plot, w: number, h: number): Placed | undefined => {
    const gutter = gutterFor(pool.kind);
    const needW = w + gutter;
    const needH = h + gutter;
    if (needW > plot.w || needH > plot.h) return undefined;
    let cx = plot.cursorX;
    let cy = plot.cursorY;
    let rh = plot.rowH;
    if (cx + needW > plot.w) {
      cx = 0;
      cy += rh;
      rh = 0;
    }
    if (cy + needH > plot.h) return undefined;
    const x = plot.x0 + cx;
    const y = plot.y0 + cy;
    plot.cursorX = cx + needW;
    plot.cursorY = cy;
    plot.rowH = Math.max(rh, needH);
    plot.lastUsedTick = ++plotTick;
    return { pool: pool.kind, page, plot, x, y, w, h };
  };

  const tryPlaceOnPages = (
    pool: PagePool,
    w: number,
    h: number,
    preferredLayout: PageLayout,
    excludePlot?: Plot,
  ): Placed | undefined => {
    for (const page of pool.pages) {
      if (page.dead || page.layout !== preferredLayout) continue;
      for (const plot of page.plots) {
        if (plot === excludePlot) continue;
        const at = tryPlaceInPlot(pool, page, plot, w, h);
        if (at !== undefined) return at;
      }
    }
    return undefined;
  };

  const demoteFloor = (rec: SlotRecord): void => {
    if (!rec.isFloor) return;
    rec.isFloor = false;
    if (floorByContent.get(rec.contentKey) === rec.index) {
      floorByContent.delete(rec.contentKey);
    }
    if (rec.placed !== undefined) {
      const bpp = poolFor(rec.placed.pool).bytesPerPixel;
      floorBytes = Math.max(0, floorBytes - rec.placed.w * rec.placed.h * bpp);
      rec.placed.plot.floorPinnedCount = Math.max(0, rec.placed.plot.floorPinnedCount - 1);
    }
  };

  /** Evict all unreferenced cells in a single plot in one shot (zero fragmentation). */
  const evictPlot = (page: Page, plot: Plot): void => {
    for (const idx of [...plot.cells]) {
      const rec = slots[idx];
      unreferencedLru.delete(idx);
      standaloneTextures.delete(idx);
      if (rec !== undefined) {
        demoteFloor(rec);
        rec.placed = undefined;
        if (rec.state === "landed") {
          landedCount = Math.max(0, landedCount - 1);
          removeContentLanded(rec.contentKey, idx);
        }
        keyToIndex.delete(rec.key);
        compatHeld.delete(rec.key);
        clearCellUV(idx);
        slots[idx] = undefined;
        freeIndices.push(idx);
        evictions += 1;
      }
    }
    plot.cells.clear();
    plot.pinnedCount = 0;
    plot.floorPinnedCount = 0;
    plot.cursorX = page.pageIndex === 0 && plot.x0 === 0 && plot.y0 === 0 ? 1 : 0;
    plot.cursorY = 0;
    plot.rowH = 0;
  };

  const evictLruUnpinnedPlot = (
    pool: PagePool,
    needW: number,
    needH: number,
    preferredLayout: PageLayout,
  ): { readonly page: Page; readonly plot: Plot } | undefined => {
    let bestPage: Page | undefined;
    let bestPlot: Plot | undefined;
    let oldest = Infinity;
    for (const page of pool.pages) {
      if (page.dead || page.layout !== preferredLayout) continue;
      for (const plot of page.plots) {
        if (plot.pinnedCount > 0 || plot.floorPinnedCount > 0 || plot.cells.size === 0) continue;
        if (plot.w < needW || plot.h < needH) continue;
        if (plot.lastUsedTick < oldest) {
          oldest = plot.lastUsedTick;
          bestPage = page;
          bestPlot = plot;
        }
      }
    }
    if (bestPage === undefined || bestPlot === undefined) return undefined;
    evictPlot(bestPage, bestPlot);
    return { page: bestPage, plot: bestPlot };
  };

  /**
   * GPU-side plot compaction (gpucanvas rescue pattern): when no plot is completely
   * unpinned, rescue live (refCount > 0 or floor) cells out of the most fragmented plot
   * via `copyTextureToTexture` into other plots, then wipe the victim plot in one shot.
   */
  const compactFragmentedPlot = (
    pool: PagePool,
    needW: number,
    needH: number,
    preferredLayout: PageLayout,
  ): { readonly page: Page; readonly plot: Plot } | undefined => {
    if (device === undefined || typeof device.createCommandEncoder !== "function") return undefined;
    let bestPage: Page | undefined;
    let bestPlot: Plot | undefined;
    let bestLive: SlotRecord[] = [];
    let bestDeadCount = 0;
    for (const page of pool.pages) {
      if (page.dead || page.layout !== preferredLayout) continue;
      for (const plot of page.plots) {
        if (plot.w < needW || plot.h < needH || plot.cells.size === 0) continue;
        const live: SlotRecord[] = [];
        let dead = 0;
        for (const idx of plot.cells) {
          const rec = slots[idx];
          if (rec !== undefined && (rec.refCount > 0 || rec.isFloor)) live.push(rec);
          else dead += 1;
        }
        if (dead === 0 || live.length === 0) continue;
        // Prefer the plot with the most dead cells and fewest live cells to copy.
        if (dead > bestDeadCount || (dead === bestDeadCount && live.length < bestLive.length)) {
          bestDeadCount = dead;
          bestPage = page;
          bestPlot = plot;
          bestLive = live;
        }
      }
    }
    if (bestPage === undefined || bestPlot === undefined || bestDeadCount === 0) return undefined;

    const encoder = device.createCommandEncoder();
    if (typeof encoder.copyTextureToTexture !== "function") return undefined;
    const gutter = gutterFor(pool.kind);
    const moved: Array<{ readonly rec: SlotRecord; readonly from: Placed; readonly to: Placed }> = [];
    let allMoved = true;
    for (const rec of bestLive) {
      const from = rec.placed;
      if (from === undefined) continue;
      const to = tryPlaceOnPages(pool, from.w, from.h, preferredLayout, bestPlot);
      if (to === undefined) {
        allMoved = false;
        break;
      }
      moved.push({ rec, from, to });
    }
    if (!allMoved) {
      // Roll back speculative plot cursor moves by leaving dead/live untouched? Better: only commit if all fit.
      // Because tryPlaceInPlot mutated target plot cursors, free those empty reservations if unused.
      for (const m of moved) {
        if (m.to.plot.cells.size === 0) {
          m.to.plot.cursorX = m.to.page.pageIndex === 0 && m.to.plot.x0 === 0 && m.to.plot.y0 === 0 ? 1 : 0;
          m.to.plot.cursorY = 0;
          m.to.plot.rowH = 0;
        }
      }
      return undefined;
    }

    for (const { rec, from, to } of moved) {
      const cw = Math.min(from.w + gutter, from.page.size - from.x, to.page.size - to.x);
      const ch = Math.min(from.h + gutter, from.page.size - from.y, to.page.size - to.y);
      if (cw > 0 && ch > 0) {
        encoder.copyTextureToTexture(
          { texture: from.page.texture, origin: { x: from.x, y: from.y, z: 0 } },
          { texture: to.page.texture, origin: { x: to.x, y: to.y, z: 0 } },
          { width: cw, height: ch, depthOrArrayLayers: 1 },
        );
      }
      if (pool.kind === "rgba" && to.page.mipCount > 1) {
        dirtyMipRects.push({
          texture: to.page.texture,
          mipCount: to.page.mipCount,
          x: to.x,
          y: to.y,
          w: from.w,
          h: from.h,
          gutter,
        });
      }
      bestPlot.cells.delete(rec.index);
      to.plot.cells.add(rec.index);
      if (rec.refCount > 0) to.plot.pinnedCount += 1;
      if (rec.isFloor) to.plot.floorPinnedCount += 1;
      to.plot.lastUsedTick = ++plotTick;
      rec.placed = to;
      const inBindGroup = to.page.pageIndex < pool.bindLimit;
      if (inBindGroup) standaloneTextures.delete(rec.index);
      else standaloneTextures.set(rec.index, to.page.texture);
      writeCellUV(rec.index, to.x, to.y, from.w, from.h, inBindGroup ? to.page.pageIndex : 0, to.page.size);
    }
    device.queue.submit([encoder.finish()]);
    evictPlot(bestPage, bestPlot);
    compactions += 1;
    markDirty();
    return { page: bestPage, plot: bestPlot };
  };

  const freePlaced = (at: Placed, cellIndex: number): void => {
    at.plot.cells.delete(cellIndex);
    standaloneTextures.delete(cellIndex);
    if (at.plot.cells.size === 0) {
      at.plot.pinnedCount = 0;
      at.plot.floorPinnedCount = 0;
      at.plot.cursorX = at.page.pageIndex === 0 && at.plot.x0 === 0 && at.plot.y0 === 0 ? 1 : 0;
      at.plot.cursorY = 0;
      at.plot.rowH = 0;
    }
  };

  const freeStandalone = (rec: SlotRecord): void => {
    if (rec.standalone === undefined) return;
    rec.standalone.texture.destroy();
    standaloneBytes = Math.max(0, standaloneBytes - rec.standalone.bytes);
    standaloneTextures.delete(rec.index);
    rec.standalone = undefined;
  };

  const alloc = (pool: PagePool, w: number, h: number): Placed | undefined => {
    const gutter = gutterFor(pool.kind);
    const needW = w + gutter;
    const needH = h + gutter;
    const layout = layoutFor(pool, needW, needH);

    // Try existing pages of the matching layout first (lazy pool init: allocates on first use).
    let at = tryPlaceOnPages(pool, w, h, layout);
    if (at !== undefined) return at;

    // Reclaim least-recently-used unpinned non-floor plot in one shot (zero fragmentation).
    const reclaimed = evictLruUnpinnedPlot(pool, needW, needH, layout);
    if (reclaimed !== undefined) {
      at = tryPlaceInPlot(pool, reclaimed.page, reclaimed.plot, w, h);
      if (at !== undefined) return at;
    }

    // Compact a fragmented plot via GPU copyTextureToTexture before growing past bindLimit.
    const compacted = compactFragmentedPlot(pool, needW, needH, layout);
    if (compacted !== undefined) {
      at = tryPlaceInPlot(pool, compacted.page, compacted.plot, w, h);
      if (at !== undefined) return at;
    }

    // All plots hold referenced/floor cells: add a new independent page (zero copies!).
    const nextPage = addPage(pool, layout);
    if (nextPage !== undefined) {
      at = tryPlaceInPlot(pool, nextPage, nextPage.plots[0]!, w, h);
      if (at !== undefined) return at;
    }
    return undefined;
  };

  // --- Full-resolution pixel upload (paged, standalone, or tiled) -------------

  const coverageBytesOf = (pixels: AtlasPixels, w: number, h: number): Uint8Array => {
    if ("data" in pixels && pixels.data instanceof Uint8Array) return pixels.data;
    const src = "source" in pixels ? pixels.source : pixels;
    if (typeof (src as HTMLCanvasElement).getContext === "function") {
      const ctx = (src as HTMLCanvasElement).getContext("2d", { willReadFrequently: true });
      if (ctx !== null && typeof ctx.getImageData === "function") {
        const rgba = ctx.getImageData(0, 0, w, h).data;
        const alpha = new Uint8Array(w * h);
        for (let i = 0; i < alpha.length; i += 1) alpha[i] = rgba[i * 4 + 3]!;
        return alpha;
      }
    }
    // ImageBitmap fallback: draw onto a willReadFrequently scratch canvas to extract alpha
    if (typeof document !== "undefined" && typeof (src as ImageBitmap).close === "function") {
      const { ctx } = getDrawScratch(w, h);
      ctx.drawImage(src as ImageBitmap, 0, 0, w, h);
      const rgba = ctx.getImageData(0, 0, w, h).data;
      const alpha = new Uint8Array(w * h);
      for (let i = 0; i < alpha.length; i += 1) alpha[i] = rgba[i * 4 + 3]!;
      return alpha;
    }
    return new Uint8Array(w * h);
  };

  const copyPixels = (pool: PagePool, pixels: AtlasPixels, at: Placed): void => {
    const w = Math.max(1, Math.min(at.w, pixels.width));
    const h = Math.max(1, Math.min(at.h, pixels.height));
    const gutter = gutterFor(pool.kind);
    const gw = Math.min(at.page.size - at.x, w + gutter);
    const gh = Math.min(at.page.size - at.y, h + gutter);
    if (pool.kind === "coverage") {
      const data = coverageBytesOf(pixels, w, h);
      if (gw > w || gh > h) {
        const padded = new Uint8Array(gw * gh);
        for (let row = 0; row < h; row += 1) {
          padded.set(data.subarray(row * w, row * w + w), row * gw);
        }
        device!.queue.writeTexture(
          { texture: at.page.texture, origin: { x: at.x, y: at.y, z: 0 } },
          padded as Uint8Array<ArrayBuffer>,
          { bytesPerRow: gw, rowsPerImage: gh },
          { width: gw, height: gh, depthOrArrayLayers: 1 },
        );
      } else {
        device!.queue.writeTexture(
          { texture: at.page.texture, origin: { x: at.x, y: at.y, z: 0 } },
          data as Uint8Array<ArrayBuffer>,
          { bytesPerRow: w, rowsPerImage: h },
          { width: w, height: h, depthOrArrayLayers: 1 },
        );
      }
      return;
    }
    const imgSource = ("source" in pixels ? pixels.source : pixels) as unknown as ImageBitmap;
    const copyW = "source" in pixels && pixels.source.width >= gw ? gw : w;
    const copyH = "source" in pixels && pixels.source.height >= gh ? gh : h;
    device!.queue.copyExternalImageToTexture(
      { source: imgSource },
      { texture: at.page.texture, origin: { x: at.x, y: at.y, z: 0 } },
      { width: copyW, height: copyH },
    );
    if (at.page.mipCount > 1) {
      dirtyMipRects.push({ texture: at.page.texture, mipCount: at.page.mipCount, x: at.x, y: at.y, w, h, gutter });
    }
  };

  /**
   * Land an item larger than a packing page at full on-screen resolution:
   * - Text uses `r8unorm` (1 byte/px); sprites use `rgba8unorm` (4 bytes/px).
   * - Up to `maxTexDim` per side: a dedicated 1-layer standalone texture sized to `(w, h)`.
   * - Beyond `maxTexDim`: a dedicated tiled `2d-array` texture of `tilesX * tilesY` layers.
   */
  const landStandalone = (pool: PagePool, rec: SlotRecord, pixels: AtlasPixels, w: number, h: number): boolean => {
    if (rec.refCount === 0 && !rec.inPlace) return false;
    const tilesX = Math.max(1, Math.ceil(w / maxTexDim));
    const tilesY = Math.max(1, Math.ceil(h / maxTexDim));
    const layers = tilesX * tilesY;
    if (layers > maxArrayLayers) {
      rec.state = "failed";
      rec.attempts += 1;
      rec.retryAfter = nowMs() + Math.min(MAX_RETRY_MS, BASE_RETRY_MS * 2 ** Math.min(6, rec.attempts - 1));
      reportFailure(`tiled item ${w}x${h} needs ${layers} layers (limit ${maxArrayLayers})`);
      return false;
    }
    const tileW = tilesX === 1 ? w : Math.min(w, maxTexDim);
    const tileH = tilesY === 1 ? h : Math.min(h, maxTexDim);

    let tex: GPUTexture | undefined;
    if (
      rec.inPlace &&
      rec.standalone !== undefined &&
      rec.standalone.tileW === tileW &&
      rec.standalone.tileH === tileH &&
      rec.standalone.tilesX === tilesX &&
      rec.standalone.tilesY === tilesY
    ) {
      tex = rec.standalone.texture;
    } else {
      if (rec.placed !== undefined) {
        freePlaced(rec.placed, rec.index);
        rec.placed = undefined;
      }
      freeStandalone(rec);
      tex = createTexture2DArray(device!, tileW, tileH, layers, pool.format, pool.usage);
      if (tex === undefined) {
        rec.state = "failed";
        rec.attempts += 1;
        rec.retryAfter = nowMs() + Math.min(MAX_RETRY_MS, BASE_RETRY_MS * 2 ** Math.min(6, rec.attempts - 1));
        return false;
      }
      const bytes = tileW * tileH * layers * pool.bytesPerPixel;
      rec.standalone = { texture: tex, w, h, tileW, tileH, tilesX, tilesY, bytes };
      standaloneTextures.set(rec.index, tex);
      standaloneBytes += bytes;
    }

    if (pool.kind === "coverage") {
      const full = coverageBytesOf(pixels, w, h);
      for (let ty = 0; ty < tilesY; ty += 1) {
        for (let tx = 0; tx < tilesX; tx += 1) {
          const sx = tx * tileW;
          const sy = ty * tileH;
          const cw = Math.min(tileW, w - sx);
          const ch = Math.min(tileH, h - sy);
          if (cw <= 0 || ch <= 0) continue;
          device!.queue.writeTexture(
            { texture: tex, origin: { x: 0, y: 0, z: ty * tilesX + tx } },
            full as Uint8Array<ArrayBuffer>,
            { offset: sy * w + sx, bytesPerRow: w, rowsPerImage: ch },
            { width: cw, height: ch, depthOrArrayLayers: 1 },
          );
        }
      }
    } else {
      for (let ty = 0; ty < tilesY; ty += 1) {
        for (let tx = 0; tx < tilesX; tx += 1) {
          const sx = tx * tileW;
          const sy = ty * tileH;
          const cw = Math.min(tileW, w - sx);
          const ch = Math.min(tileH, h - sy);
          if (cw <= 0 || ch <= 0) continue;
          device!.queue.copyExternalImageToTexture(
            { source: ("source" in pixels ? pixels.source : pixels) as unknown as ImageBitmap, origin: { x: sx, y: sy } },
            { texture: tex, origin: { x: 0, y: 0, z: ty * tilesX + tx } },
            { width: cw, height: ch },
          );
        }
      }
    }

    const base = rec.index * ATLAS_CELL_FLOATS;
    cells[base] = 0;
    cells[base + 1] = 0;
    cells[base + 2] = w / (tilesX * tileW);
    cells[base + 3] = h / (tilesY * tileH);
    cells[base + 4] = 0;
    cells[base + 5] = layers > 1 ? tilesX : 0;
    cells[base + 6] = layers > 1 ? tilesY : 0;
    cells[base + 7] = 0;
    if (!allCellsDirty) dirtyCellSlots.add(rec.index);

    rec.inPlace = false;
    const wasLanded = rec.state === "landed";
    rec.state = "landed";
    rec.attempts = 0;
    rec.retryAfter = 0;
    if (!wasLanded) landedCount += 1;
    addContentLanded(rec.contentKey, rec.index);
    releaseAlias(rec);
    if (rec.refCount === 0) {
      rec.desc = undefined;
      unreferencedLru.set(rec.index, true);
    }
    markDirty();
    return true;
  };

  // --- Reference release & alias settlement -----------------------------------

  const releaseAlias = (rec: SlotRecord): void => {
    if (rec.aliasOf === undefined) return;
    const target = rec.aliasOf;
    rec.aliasOf = undefined;
    release(target);
  };

  const landPixels = (rec: SlotRecord, pixels: AtlasPixels): boolean => {
    const pool = poolFor(poolKindOf(rec.desc?.kind ?? "sprite"));
    if (disposed || device === undefined) return false;
    const w = Math.max(1, pixels.width);
    const h = Math.max(1, pixels.height);
    const gutter = gutterFor(pool.kind);

    // Only items larger than a page get a dedicated standalone (or tiled) texture.
    if (w + gutter > pool.pageSize || h + gutter > pool.pageSize) {
      return landStandalone(pool, rec, pixels, w, h);
    }

    freeStandalone(rec);
    // In-place overwrite if rec already holds a matching rect in the same pool
    let at: Placed | undefined;
    if (rec.inPlace && rec.placed !== undefined && !rec.placed.page.dead && rec.placed.pool === pool.kind && rec.placed.w === w && rec.placed.h === h) {
      at = rec.placed;
    } else {
      if (rec.placed !== undefined) {
        if (rec.refCount > 0) rec.placed.plot.pinnedCount = Math.max(0, rec.placed.plot.pinnedCount - 1);
        freePlaced(rec.placed, rec.index);
        rec.placed = undefined;
      }
      at = alloc(pool, w, h);
    }

    if (at === undefined) {
      rec.state = "failed";
      rec.attempts += 1;
      rec.retryAfter = nowMs() + Math.min(MAX_RETRY_MS, BASE_RETRY_MS * 2 ** Math.min(6, rec.attempts - 1));
      reportFailure(`atlas alloc failed for ${w}x${h} (key=${rec.key})`);
      return false;
    }

    copyPixels(pool, pixels, at);
    if (rec.placed !== at) {
      at.plot.cells.add(rec.index);
      if (rec.refCount > 0) at.plot.pinnedCount += 1;
      if (rec.isFloor) at.plot.floorPinnedCount += 1;
    }
    at.plot.lastUsedTick = ++plotTick;
    rec.placed = at;
    // Pin each contentKey's smallest drawn size as its never-evicted floor copy so
    // findStandIn always has pixels even after sharper scales are evicted.
    if (floorEnabled) {
      const prevFloorIdx = floorByContent.get(rec.contentKey);
      const prevFloorRec = prevFloorIdx !== undefined ? slots[prevFloorIdx] : undefined;
      if (
        prevFloorRec === undefined ||
        prevFloorRec.state !== "landed" ||
        prevFloorRec.placed === undefined ||
        rec.scale < prevFloorRec.scale
      ) {
        if (prevFloorRec !== undefined && prevFloorRec !== rec) {
          demoteFloor(prevFloorRec);
        }
        if (!rec.isFloor) {
          rec.isFloor = true;
          at.plot.floorPinnedCount += 1;
          floorBytes += w * h * pool.bytesPerPixel;
        }
        floorByContent.set(rec.contentKey, rec.index);
      }
    }
    // Pages within the bind-group budget are sampled directly by pageIndex (no standalone split);
    // only pages past the device's sampled-texture limit fall back to standalone per cell.
    const inBindGroup = at.page.pageIndex < pool.bindLimit;
    if (inBindGroup) {
      standaloneTextures.delete(rec.index);
    } else {
      standaloneTextures.set(rec.index, at.page.texture);
    }
    rec.inPlace = false;
    const wasLanded = rec.state === "landed";
    rec.state = "landed";
    rec.attempts = 0;
    rec.retryAfter = 0;
    if (!wasLanded) landedCount += 1;
    addContentLanded(rec.contentKey, rec.index);
    seenContentKeys.add(rec.contentKey);
    writeCellUV(rec.index, at.x, at.y, w, h, inBindGroup ? at.page.pageIndex : 0, at.page.size);
    releaseAlias(rec);
    if (rec.refCount === 0) {
      rec.desc = undefined;
      unreferencedLru.set(rec.index, true);
    }
    markDirty();
    return true;
  };

  // --- Queued async + sync rasterization --------------------------------------

  const enqueue = (index: number): void => {
    if (disposed || queuedSet.has(index)) return;
    queuedSet.add(index);
    queue.push(index);
    scheduleDrain();
  };

  // Reusable unclamped macrotask channel (avoids Chromium's 4ms nested setTimeout clamp).
  let drainChannel: MessageChannel | undefined;
  const scheduleMacrotask = (fn: () => void): void => {
    if (typeof MessageChannel === "function") {
      if (drainChannel === undefined) {
        drainChannel = new MessageChannel();
      }
      drainChannel.port1.onmessage = () => fn();
      drainChannel.port2.postMessage(undefined);
    } else {
      setTimeout(fn, 0);
    }
  };

  const scheduleDrain = (): void => {
    if (drainScheduled || disposed || device === undefined) return;
    drainScheduled = true;
    // In a browser/Electron, run background rasterization in an unclamped macrotask
    // AFTER the current rAF frame presents (queueMicrotask runs inside FireAnimationFrame).
    if (typeof requestAnimationFrame === "function") {
      scheduleMacrotask(drainQueue);
    } else {
      queueMicrotask(drainQueue);
    }
  };

  const rasterizeSync = (desc: CellDesc): AtlasPixels | undefined => {
    if (desc.kind === "text") {
      if (options.rasterizeTextSync === undefined) return undefined;
      const ink = resolveColour(desc.quad.style.ink, themeFor(desc.mode)) ?? { r: 1, g: 1, b: 1, a: 1 };
      return options.rasterizeTextSync(desc.quad.text!, desc.scale, ink);
    }
    if (options.rasterizeSpriteSync === undefined) return undefined;
    return options.rasterizeSpriteSync(desc.quad, desc.mode, desc.scale);
  };

  const rasterizeAsync = (desc: CellDesc): Promise<AtlasPixels> => {
    if (desc.kind === "text") {
      if (options.rasterizeText === undefined) return Promise.reject(new Error("no text rasterizer"));
      const ink = resolveColour(desc.quad.style.ink, themeFor(desc.mode)) ?? { r: 1, g: 1, b: 1, a: 1 };
      return options.rasterizeText(desc.quad.text!, desc.scale, ink);
    }
    if (options.rasterizeSprite === undefined) return Promise.reject(new Error("no sprite rasterizer"));
    return options.rasterizeSprite(desc.quad, desc.mode, desc.scale);
  };

  const runJob = (rec: SlotRecord): void => {
    if (rec.desc === undefined || device === undefined) return;
    const desc = rec.desc;
    const token = ++nextJobToken;
    rec.jobToken = token;
    rec.state = "rasterizing";

    // For sprites, always try the synchronous path first (marks, glyphs, and any
    // already-decoded SVG or media draw straight from the grow-only scratch canvas
    // with zero ImageBitmap copy). For text, prefer async OffscreenCanvas workers
    // when preferAsyncRaster is set so the main thread stays free.
    if (
      (desc.kind === "sprite" && options.rasterizeSpriteSync !== undefined) ||
      (!options.preferAsyncRaster && desc.kind === "text" && options.rasterizeTextSync !== undefined)
    ) {
      try {
        const syncPx = rasterizeSync(desc);
        if (syncPx !== undefined) {
          if (rec.jobToken === token && !disposed) {
            landPixels(rec, syncPx);
          }
          return;
        }
      } catch (error) {
        rec.state = "failed";
        rec.attempts += 1;
        rec.retryAfter = nowMs() + Math.min(MAX_RETRY_MS, BASE_RETRY_MS * 2 ** Math.min(6, rec.attempts - 1));
        reportFailure(`atlas sync raster failed (${rec.key}): ${String(error)}`);
        return;
      }
    }

    inFlightCount += 1;
    void rasterizeAsync(desc)
      .then((pixels) => {
        try {
          if (disposed || rec.jobToken !== token || slots[rec.index] !== rec) return;
          if (rec.refCount === 0 && !rec.inPlace) {
            // Released while in flight: drop without wasting page space.
            rec.state = "failed";
            keyToIndex.delete(rec.key);
            compatHeld.delete(rec.key);
            slots[rec.index] = undefined;
            freeIndices.push(rec.index);
            return;
          }
          landPixels(rec, pixels);
        } finally {
          closePixels(pixels);
        }
      })
      .catch((error) => {
        if (disposed || rec.jobToken !== token || slots[rec.index] !== rec) return;
        rec.state = "failed";
        rec.attempts += 1;
        rec.retryAfter = nowMs() + Math.min(MAX_RETRY_MS, BASE_RETRY_MS * 2 ** Math.min(6, rec.attempts - 1));
        reportFailure(`atlas raster failed (${rec.key}): ${String(error)}`);
      })
      .finally(() => {
        inFlightCount = Math.max(0, inFlightCount - 1);
      });
  };

  const drainQueue = (): void => {
    drainScheduled = false;
    if (disposed || device === undefined) return;
    sampleFrameInterval();
    const start = nowMs();
    const budget = drainYieldMs();
    while (queue.length > 0) {
      const idx = queue.shift()!;
      queuedSet.delete(idx);
      const rec = slots[idx];
      if (rec === undefined || rec.state !== "queued") continue;
      if (rec.refCount === 0) {
        // Cancelled before rasterizing
        keyToIndex.delete(rec.key);
        compatHeld.delete(rec.key);
        slots[idx] = undefined;
        freeIndices.push(idx);
        continue;
      }
      runJob(rec);
      // Yield between chunks during large bursts so input/frames never stall.
      if (queue.length > 0 && nowMs() - start >= budget) {
        drainScheduled = true;
        scheduleMacrotask(drainQueue);
        return;
      }
    }
  };

  // --- Key helpers ------------------------------------------------------------

  const inkKey = (ref: ColorRef | undefined): string => {
    if (ref === undefined) return "-";
    if ("token" in ref) return `t:${ref.token}:${ref.alpha ?? 1}`;
    if ("custom" in ref) return `c:${ref.custom}:${ref.alpha ?? 1}`;
    return `m:${inkKey(ref.mix[0])},${inkKey(ref.mix[1])},${ref.share}`;
  };

  /** Opaque ink key for text coverage: raster forces alpha 1 (shader multiplies ink.a). */
  const inkKeyOpaque = (ref: ColorRef | undefined): string => {
    if (ref === undefined) return "-";
    if ("token" in ref) return `t:${ref.token}`;
    if ("custom" in ref) return `c:${ref.custom}`;
    return `m:${inkKeyOpaque(ref.mix[0])},${inkKeyOpaque(ref.mix[1])},${ref.share}`;
  };

  const keysFor = (quad: Quad, scale: number): { readonly key: string; readonly contentKey: string; readonly kind: "text" | "sprite" } | undefined => {
    if (quad.sprite !== undefined) {
      const ref = quad.sprite;
      const box = `${Math.ceil(quad.rect.width * scale)}x${Math.ceil(quad.rect.height * scale)}`;
      if (ref.atlas === "image") {
        const contentKey = `img:${mode}:${ref.key}:${ref.size.width}x${ref.size.height}`;
        return { key: `${contentKey}:${scale}:${box}`, contentKey, kind: "sprite" };
      }
      if (ref.atlas === "mark") {
        const contentKey = `mark:${mode}:${ref.cell.col},${ref.cell.row}`;
        return { key: `${contentKey}:${scale}:${box}`, contentKey, kind: "sprite" };
      }
      if (ref.atlas === "glyph") {
        if (!glyphKnown(ref.name)) return undefined;
        const contentKey = `glyph:${mode}:${inkKey(quad.style.ink)}:${ref.name}`;
        return { key: `${contentKey}:${scale}:${box}`, contentKey, kind: "sprite" };
      }
      const contentKey = `media:${mode}:${ref.fit}:${ref.ref}`;
      return { key: `${contentKey}:${scale}:${box}`, contentKey, kind: "sprite" };
    }
    if (quad.text !== undefined && (options.rasterizeText !== undefined || options.rasterizeTextSync !== undefined)) {
      const run = quad.text;
      const ink = inkKeyOpaque(quad.style.ink);
      const contentKey = `txt:${mode}:${run.text}:${run.font}:${run.weight}:${run.upper ? 1 : 0}:${run.italic ? 1 : 0}:${run.blur ?? 0}:${run.truncate}:${run.align ?? "left"}:${ink}`;
      return { key: `txt:${mode}:${runKey(run, scale, 0)}:${ink}`, contentKey, kind: "text" };
    }
    return undefined;
  };

  const expectedBoxFor = (quad: Quad, scale: number): { readonly w: number; readonly h: number } | undefined => {
    if (quad.sprite !== undefined) {
      return {
        w: Math.max(1, Math.ceil(quad.rect.width * scale)),
        h: Math.max(1, Math.ceil(quad.rect.height * scale)),
      };
    }
    if (quad.text !== undefined) {
      const run = quad.text;
      if (run.truncate === "none" || run.truncate === "clamp2") return undefined; // multi-line height may vary
      const pad = run.blur === undefined ? 0 : haloPadDevice(scale);
      const lineHeight = run.size * scale * (run.leading ?? 1.2);
      return {
        w: Math.max(1, Math.ceil(run.width * scale) + 2 * pad),
        h: Math.max(1, Math.ceil(lineHeight) + 2 * pad),
      };
    }
    return undefined;
  };

  // --- Public acquire / release / ensureNow -----------------------------------

  const release = (cell: number): void => {
    if (cell === NO_ATLAS_CELL || cell < 0 || cell >= slots.length) return;
    const rec = slots[cell];
    if (rec === undefined || rec.refCount <= 0) return;
    rec.refCount -= 1;
    if (rec.refCount > 0) return;

    if (rec.placed !== undefined) {
      rec.placed.plot.pinnedCount = Math.max(0, rec.placed.plot.pinnedCount - 1);
    }
    releaseAlias(rec);
    if (rec.state === "landed") {
      if (rec.standalone !== undefined) {
        // Off-screen standalone textures leave immediately so they never hold GPU memory or disable GPU cull.
        freeStandalone(rec);
        landedCount = Math.max(0, landedCount - 1);
        removeContentLanded(rec.contentKey, cell);
        keyToIndex.delete(rec.key);
        compatHeld.delete(rec.key);
        unreferencedLru.delete(cell);
        clearCellUV(cell);
        slots[cell] = undefined;
        freeIndices.push(cell);
        evictions += 1;
        markDirty();
      } else {
        rec.desc = undefined;
        unreferencedLru.set(cell, true);
      }
    } else if (rec.state === "queued") {
      queuedSet.delete(cell);
      keyToIndex.delete(rec.key);
      compatHeld.delete(rec.key);
      clearCellUV(cell);
      slots[cell] = undefined;
      freeIndices.push(cell);
    } else if (rec.state === "failed") {
      keyToIndex.delete(rec.key);
      compatHeld.delete(rec.key);
      clearCellUV(cell);
      slots[cell] = undefined;
      freeIndices.push(cell);
    }
    // If state === "rasterizing", runJob's .then handler will reclaim when it finishes.
  };

  const acquire = (quad: Quad, scale: number, previous?: number): number => {
    const keys = keysFor(quad, scale);
    if (keys === undefined) {
      if (previous !== undefined && previous !== NO_ATLAS_CELL) release(previous);
      return NO_ATLAS_CELL;
    }

    const prevRec = previous !== undefined && previous !== NO_ATLAS_CELL ? slots[previous] : undefined;

    // Rule 3: Same key -> return previous with net zero ref change.
    if (prevRec !== undefined && prevRec.key === keys.key) {
      if (prevRec.state === "failed" && nowMs() >= prevRec.retryAfter) {
        prevRec.desc = { quad, scale, mode, kind: keys.kind };
        prevRec.state = "queued";
        enqueue(prevRec.index);
      }
      return prevRec.index;
    }

    // Rule 3: In-place status-line overwrite when previous has refCount === 1 and same pixel box.
    if (prevRec !== undefined && prevRec.refCount === 1 && prevRec.placed !== undefined && prevRec.state === "landed" && !keyToIndex.has(keys.key)) {
      const box = expectedBoxFor(quad, scale);
      if (box !== undefined && box.w === prevRec.placed.w && box.h === prevRec.placed.h) {
        keyToIndex.delete(prevRec.key);
        removeContentLanded(prevRec.contentKey, prevRec.index);
        prevRec.key = keys.key;
        prevRec.contentKey = keys.contentKey;
        prevRec.scale = scale;
        prevRec.desc = { quad, scale, mode, kind: keys.kind };
        prevRec.inPlace = true;
        prevRec.state = "queued";
        keyToIndex.set(keys.key, prevRec.index);
        requests += 1;
        enqueue(prevRec.index);
        return prevRec.index;
      }
    }

    // Check if the requested key already exists (pinned or cached LRU).
    const existingIdx = keyToIndex.get(keys.key);
    if (existingIdx !== undefined) {
      const rec = slots[existingIdx]!;
      const wasUnpinned = rec.refCount === 0;
      rec.refCount += 1;
      if (wasUnpinned && rec.placed !== undefined) {
        rec.placed.plot.pinnedCount += 1;
        rec.placed.plot.lastUsedTick = ++plotTick;
      }
      unreferencedLru.delete(existingIdx);
      rec.desc = { quad, scale, mode, kind: keys.kind };
      if (rec.state === "failed" && nowMs() >= rec.retryAfter) {
        rec.state = "queued";
        enqueue(existingIdx);
      }
      // If existing cell already has an image, we can release previous immediately.
      // Otherwise keep previous aliased on rec until rec lands (Ruling 6 #1).
      if (prevRec !== undefined) {
        if (hasImage(existingIdx)) {
          release(prevRec.index);
        } else if (rec.aliasOf === undefined && hasImage(prevRec.index)) {
          rec.aliasOf = prevRec.index; // transfers caller's ref on prevRec to rec.aliasOf
          copyCellUV(existingIdx, prevRec.index);
          markDirty();
        } else {
          release(prevRec.index);
        }
      }
      return existingIdx;
    }

    // Allocate a new cell index (recycle free slot or grow cells table).
    let index: number;
    if (freeIndices.length > 0) {
      index = freeIndices.pop()!;
    } else {
      index = highWaterCells;
      if (!ensureCellCapacity(index + 1)) {
        if (prevRec !== undefined) release(prevRec.index);
        return NO_ATLAS_CELL;
      }
      highWaterCells = index + 1;
      mutable.cellCount = highWaterCells;
    }

    const rec: SlotRecord = {
      index,
      key: keys.key,
      contentKey: keys.contentKey,
      scale,
      refCount: 1,
      state: "queued",
      attempts: 0,
      retryAfter: 0,
      desc: { quad, scale, mode, kind: keys.kind },
      jobToken: 0,
    };
    slots[index] = rec;
    keyToIndex.set(keys.key, index);
    clearCellUV(index);
    requests += 1;

    // Stand-in (Rule 5) or replacement previous (Ruling 6 #1): never flash blank.
    const standIn = findStandIn(keys.contentKey, scale, index);
    if (standIn !== undefined) {
      const sRec = slots[standIn]!;
      const wasUnpinned = sRec.refCount === 0;
      sRec.refCount += 1;
      if (wasUnpinned && sRec.placed !== undefined) {
        sRec.placed.plot.pinnedCount += 1;
        sRec.placed.plot.lastUsedTick = ++plotTick;
      }
      unreferencedLru.delete(standIn);
      rec.aliasOf = standIn;
      copyCellUV(index, standIn);
      markDirty();
      if (prevRec !== undefined) release(prevRec.index);
    } else if (prevRec !== undefined && hasImage(prevRec.index)) {
      // Transfer caller's reference on previous to rec.aliasOf until rec lands.
      rec.aliasOf = prevRec.index;
      copyCellUV(index, prevRec.index);
      markDirty();
    } else if (prevRec !== undefined) {
      release(prevRec.index);
    }

    enqueue(index);
    return index;
  };

  const ensureNow = (cell: number): boolean => {
    if (disposed || cell === NO_ATLAS_CELL || cell < 0 || cell >= slots.length) return false;
    if (hasImage(cell)) return true;
    if (device === undefined) return false;
    const rec = slots[cell];
    if (rec === undefined || rec.desc === undefined) return false;
    // Respect failure backoff so a broken media URL does not throw on every frame.
    if (rec.state === "failed" && nowMs() < rec.retryAfter) return false;
    // Attempt synchronous raster + copy before the frame is submitted.
    // Cold async image/media sources stay hasImage===false so the shader draws
    // the shape-exact tone placeholder until the single decode lands.
    try {
      const px = rasterizeSync(rec.desc);
      if (px !== undefined) {
        queuedSet.delete(cell);
        rec.jobToken = ++nextJobToken;
        landPixels(rec, px);
      }
    } catch (error) {
      rec.state = "failed";
      rec.attempts += 1;
      rec.retryAfter = nowMs() + Math.min(MAX_RETRY_MS, BASE_RETRY_MS * 2 ** Math.min(6, rec.attempts - 1));
      reportFailure(`atlas ensureNow failed (${rec.key}): ${String(error)}`);
    }
    const ok = hasImage(cell);
    if (!ok && seenContentKeys.has(rec.contentKey)) {
      lostPixels += 1;
    }
    return ok;
  };

  const sourceFor = (quad: Quad, scale: number): number => {
    const keys = keysFor(quad, scale);
    if (keys === undefined) return NO_ATLAS_CELL;
    if (compatHeld.has(keys.key)) {
      const idx = keyToIndex.get(keys.key);
      if (idx !== undefined) {
        const rec = slots[idx]!;
        if (rec.state === "failed" && nowMs() >= rec.retryAfter) {
          rec.desc = { quad, scale, mode, kind: keys.kind };
          rec.state = "queued";
          enqueue(idx);
        }
        return idx;
      }
      compatHeld.delete(keys.key);
    }
    const idx = acquire(quad, scale);
    if (idx !== NO_ATLAS_CELL) compatHeld.add(keys.key);
    return idx;
  };

  const stats = (): AtlasStats => {
    let activeCells = 0;
    let pinnedCells = 0;
    for (let i = 0; i < highWaterCells; i += 1) {
      const rec = slots[i];
      if (rec === undefined) continue;
      activeCells += 1;
      if (rec.refCount > 0) pinnedCells += 1;
    }
    let pageBytes = 0;
    for (const p of rgbaPool.pages) if (!p.dead) pageBytes += p.bytes;
    for (const p of coveragePool.pages) if (!p.dead) pageBytes += p.bytes;
    return {
      requests,
      pending: queuedSet.size + inFlightCount,
      landed: landedCount,
      evictions,
      failures,
      pages: rgbaPool.pages.filter((p) => !p.dead).length + coveragePool.pages.filter((p) => !p.dead).length,
      pageSize,
      bytesInUse: pageBytes + standaloneBytes,
      activeCells,
      pinnedCells,
      standaloneCount: standaloneTextures.size,
      decodedSourceBytes: decodedSvgBytes + decodedMediaBytes,
      decodedSvgCount: decodedSvgs.size,
      floorBytes,
      floorCells: floorByContent.size,
      compactions,
      lostPixels,
      visibleBlank,
      visibleBlankTotal,
    };
  };

  return {
    binding,
    attach: (next) => {
      if (disposed) return;
      const fresh = device !== next;
      device = next;
      if (sampler !== undefined && !fresh) return;

      // Read real device limits; page edge is a packing choice, never a capacity cap.
      const maxDim = next.limits?.maxTextureDimension2D;
      maxTexDim = typeof maxDim === "number" && maxDim > 0 ? maxDim : 8192;
      pageSize = Math.min(preferredSize, maxTexDim);
      rgbaPool.pageSize = Math.min(explicitSize ?? PREFERRED_PAGE_SIZE, maxTexDim);
      coveragePool.pageSize = Math.min(explicitSize ?? PREFERRED_COVERAGE_PAGE_SIZE, maxTexDim);
      const budget = atlasBindBudget(next);
      rgbaPool.bindLimit = budget.rgba;
      coveragePool.bindLimit = budget.coverage;
      const maxLayers = next.limits?.maxTextureArrayLayers;
      maxArrayLayers = typeof maxLayers === "number" && maxLayers > 0 ? maxLayers : 256;
      const maxStorage = next.limits?.maxStorageBufferBindingSize;
      maxCellsByLimit =
        typeof maxStorage === "number" && maxStorage > 0
          ? Math.max(1, Math.floor(maxStorage / (ATLAS_CELL_FLOATS * 4)))
          : Number.MAX_SAFE_INTEGER;

      for (const p of rgbaPool.pages) if (!p.dead) p.texture.destroy();
      for (const p of coveragePool.pages) if (!p.dead) p.texture.destroy();
      for (const tex of standaloneTextures.values()) {
        // Standalone page textures were already destroyed above; destroy standalone oversized textures only
        if (!rgbaPool.pages.some((p) => p.texture === tex) && !coveragePool.pages.some((p) => p.texture === tex)) {
          tex.destroy();
        }
      }
      dummyRgbaTex?.destroy();
      dummyCovTex?.destroy();
      standaloneTextures.clear();
      standaloneBytes = 0;
      rgbaPool.pages.length = 0;
      rgbaPool.pageTextures.length = 0;
      coveragePool.pages.length = 0;
      coveragePool.pageTextures.length = 0;
      dirtyMipRects.length = 0;

      // Build GPU mipmap blit pipeline when device supports render passes (real WebGPU).
      mipPipeline = undefined;
      mipBindLayout = undefined;
      rgbaMipCount = 1;
      if (
        typeof next.createShaderModule === "function" &&
        typeof next.createBindGroupLayout === "function" &&
        typeof next.createPipelineLayout === "function" &&
        typeof next.createRenderPipeline === "function" &&
        typeof next.createBindGroup === "function"
      ) {
        const mod = next.createShaderModule({ code: MIP_BLIT_SHADER });
        mipBindLayout = next.createBindGroupLayout({
          entries: [
            { binding: 0, visibility: 2, texture: { sampleType: "float" } },
            { binding: 1, visibility: 2, sampler: { type: "filtering" } },
          ],
        });
        mipPipeline = next.createRenderPipeline({
          layout: next.createPipelineLayout({ bindGroupLayouts: [mipBindLayout] }),
          vertex: { module: mod, entryPoint: "vs" },
          fragment: { module: mod, entryPoint: "fs", targets: [{ format: "rgba8unorm" }] },
          primitive: { topology: "triangle-list" },
        });
        rgbaMipCount = Math.min(RGBA_MAX_MIP_LEVELS, Math.max(1, Math.floor(Math.log2(pageSize)) + 1));
      }

      // Lazy pool init: allocate zero page textures on attach; tiny 1x1 dummies hold the bindings until first use.
      dummyRgbaTex = createTexture2DArray(next, 1, 1, 1, rgbaPool.format, rgbaPool.usage, 1);
      dummyCovTex = createTexture2DArray(next, 1, 1, 1, coveragePool.format, coveragePool.usage, 1);
      sampler = next.createSampler({
        magFilter: "linear",
        minFilter: "linear",
        mipmapFilter: "linear",
        addressModeU: "clamp-to-edge",
        addressModeV: "clamp-to-edge",
      });
      if (dummyRgbaTex !== undefined) mutable.texture = dummyRgbaTex;
      if (dummyCovTex !== undefined) mutable.coverageTexture = dummyCovTex;
      mutable.sampler = sampler;
      textureGeneration += 1;
      mutable.textureGeneration = textureGeneration;
      allCellsDirty = true;

      // Device loss / re-attach (Ruling 6 #3): drop unreferenced cells and
      // re-rasterize all referenced cells immediately (sync where possible,
      // async queued for SVG/media) before the first frame presents.
      unreferencedLru.clear();
      contentLanded.clear();
      floorByContent.clear();
      floorBytes = 0;
      landedCount = 0;
      for (let i = 0; i < highWaterCells; i += 1) {
        const rec = slots[i];
        if (rec === undefined) continue;
        rec.placed = undefined;
        rec.standalone = undefined;
        rec.isFloor = false;
        clearCellUV(i);
        if (rec.refCount === 0) {
          keyToIndex.delete(rec.key);
          compatHeld.delete(rec.key);
          slots[i] = undefined;
          freeIndices.push(i);
          continue;
        }
        rec.state = "queued";
        if (rec.desc !== undefined) {
          // Try sync raster immediately so referenced text/mark/glyph cells are ready before frame 1.
          const synced = ensureNow(i);
          if (!synced) enqueue(i);
        }
      }
      markDirty();
      scheduleDrain();
    },
    setMode: (next) => {
      mode = next;
    },
    acquire,
    release,
    hasImage,
    ensureNow,
    prepareSource: (quad: Quad) => {
      if (quad.sprite === undefined) return;
      prepareDecodedSpriteSource(quad.sprite, mode);
    },
    releaseSource: (quad: Quad) => {
      if (quad.sprite === undefined) return;
      releaseDecodedSpriteSource(quad.sprite, mode);
    },
    recordVisibleBlank: (count: number) => {
      visibleBlank = count;
      visibleBlankTotal += count;
    },
    sourceFor,
    revision: () => revision,
    stats,
    get requests() {
      return requests;
    },
    get pending() {
      return queuedSet.size + inFlightCount;
    },
    notifyMemoryPressure: () => {
      evictUnreferencedSourcesOnPressure();
    },
    dispose: () => {
      disposed = true;
      floorByContent.clear();
      floorBytes = 0;
      seenContentKeys.clear();
      drainChannel?.port1.close();
      drainChannel?.port2.close();
      drainChannel = undefined;
      for (const p of rgbaPool.pages) p.texture.destroy();
      for (const p of coveragePool.pages) p.texture.destroy();
      for (const tex of standaloneTextures.values()) {
        if (!rgbaPool.pages.some((p) => p.texture === tex) && !coveragePool.pages.some((p) => p.texture === tex)) {
          tex.destroy();
        }
      }
      dummyRgbaTex?.destroy();
      dummyCovTex?.destroy();
      dummyRgbaTex = undefined;
      dummyCovTex = undefined;
      standaloneTextures.clear();
      standaloneBytes = 0;
      rgbaPool.pages.length = 0;
      rgbaPool.pageTextures.length = 0;
      coveragePool.pages.length = 0;
      coveragePool.pageTextures.length = 0;
      dirtyMipRects.length = 0;
      mipPipeline = undefined;
      mipBindLayout = undefined;
      queue.length = 0;
      queuedSet.clear();
      unreferencedLru.clear();
      contentLanded.clear();
      keyToIndex.clear();
      compatHeld.clear();
      slots.length = 0;
      freeIndices.length = 0;
      highWaterCells = 0;
      mutable.cellCount = 0;
    },
  };
};

// --- the browser rasterizers (the shell hands these to the atlas) -------------

const canvas2d = (w: number, h: number, readFrequently = false): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } => {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(w));
  canvas.height = Math.max(1, Math.ceil(h));
  const ctx = canvas.getContext("2d", readFrequently ? { willReadFrequently: true } : undefined)!;
  return { canvas, ctx };
};

let measureScratch: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | undefined;
const getMeasureCtx = (): CanvasRenderingContext2D => {
  if (measureScratch === undefined) measureScratch = canvas2d(8, 8, true);
  return measureScratch.ctx;
};

/** Grow-only scratch canvas: never shrinks, clears (w+1)x(h+1) so the 1px gutter is transparent. */
let drawScratch: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | undefined;
const getDrawScratch = (w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } => {
  const cw = Math.max(1, Math.ceil(w));
  const ch = Math.max(1, Math.ceil(h));
  const needW = cw + 1;
  const needH = ch + 1;
  if (drawScratch === undefined) {
    drawScratch = canvas2d(needW, needH, true);
  } else if (needW > drawScratch.canvas.width || needH > drawScratch.canvas.height) {
    drawScratch.canvas.width = Math.max(drawScratch.canvas.width, needW);
    drawScratch.canvas.height = Math.max(drawScratch.canvas.height, needH);
  }
  drawScratch.ctx.clearRect(0, 0, needW, needH);
  return drawScratch;
};

let sharpScratch: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | undefined;
const getSharpScratch = (w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } => {
  const cw = Math.max(1, Math.ceil(w));
  const ch = Math.max(1, Math.ceil(h));
  if (sharpScratch === undefined) {
    sharpScratch = canvas2d(cw, ch, true);
  } else if (cw > sharpScratch.canvas.width || ch > sharpScratch.canvas.height) {
    sharpScratch.canvas.width = Math.max(sharpScratch.canvas.width, cw);
    sharpScratch.canvas.height = Math.max(sharpScratch.canvas.height, ch);
  }
  sharpScratch.ctx.clearRect(0, 0, cw, ch);
  return sharpScratch;
};

/**
 * Synchronous text-run rasterizer: draws coverage in the run's true resolved
 * ink colour into a reusable scratch canvas (copied immediately to GPU via
 * `copyExternalImageToTexture` with zero `ImageBitmap` retention).
 */
export const rasterizeTextRunSync: TextRasterizeSync = (run, scale, ink) => {
  const ctx = getMeasureCtx();
  const measure: MeasureContext = ctx;
  ctx.font = fontCss(run, scale);
  ctx.letterSpacing = run.tracking !== undefined ? `${run.tracking}em` : "0px";
  const lines = layoutRun(run, Math.max(1, run.width * scale), (t) => measure.measureText(t).width);
  const lineHeight = run.size * scale * (run.leading ?? 1.2);
  const pad = run.blur === undefined ? 0 : haloPadDevice(scale);
  const cellW = Math.max(1, Math.ceil(run.width * scale) + 2 * pad);
  const cellH = Math.max(1, Math.ceil(lineHeight * lines.length) + 2 * pad);
  const { canvas, ctx: draw } = getDrawScratch(cellW, cellH);
  draw.font = ctx.font;
  draw.letterSpacing = ctx.letterSpacing;
  const paint = gpuColorCss({ ...ink, a: 1 });
  draw.fillStyle = paint;
  draw.textBaseline = "middle";
  const textWidth = cellW - 2 * pad;
  const glyphX = (target: CanvasRenderingContext2D, line: string): number => {
    const x = run.align === "center" ? (textWidth - target.measureText(line).width) / 2 : 0;
    return x + pad;
  };
  if (run.blur === undefined) {
    lines.forEach((line, i) => {
      draw.fillText(line, glyphX(draw, line), pad + lineHeight * i + lineHeight / 2);
    });
    return { source: canvas, width: cellW, height: cellH };
  }
  const sharp = getSharpScratch(cellW, cellH);
  sharp.ctx.font = draw.font;
  sharp.ctx.letterSpacing = draw.letterSpacing;
  sharp.ctx.fillStyle = paint;
  sharp.ctx.textBaseline = "middle";
  lines.forEach((line, i) => {
    sharp.ctx.fillText(line, glyphX(sharp.ctx, line), pad + lineHeight * i + lineHeight / 2);
  });
  draw.filter = `blur(${run.blur * scale * HALO_SIGMA_PER_RADIUS}px)`;
  draw.drawImage(sharp.canvas, 0, 0, cellW, cellH, 0, 0, cellW, cellH);
  draw.drawImage(sharp.canvas, 0, 0, cellW, cellH, 0, 0, cellW, cellH);
  draw.filter = "none";
  return { source: canvas, width: cellW, height: cellH };
};

export const rasterizeTextRun: TextRasterize = async (run, scale, ink) => {
  const region = rasterizeTextRunSync(run, scale, ink) as AtlasCanvasRegion;
  return createImageBitmap(region.source, 0, 0, region.width, region.height);
};

let markAtlasCache: { mode: ThemeMode; canvas: HTMLCanvasElement } | undefined;

const markAtlasCanvas = (mode: ThemeMode): HTMLCanvasElement | undefined => {
  if (markAtlasCache?.mode === mode) return markAtlasCache.canvas;
  const canvas = paintMarkAtlasCanvas(mode);
  if (canvas !== undefined) markAtlasCache = { mode, canvas };
  return canvas;
};

let themeCache: { mode: ThemeMode; theme: GpuTheme } | undefined;
const themeFor = (mode: ThemeMode): GpuTheme => {
  if (themeCache?.mode !== mode) themeCache = { mode, theme: themeGpu(mode) };
  return themeCache.theme;
};

const CSS_VAR = /var\(--color-([a-zA-Z0-9-]+)\)/g;
const resolveSvgVars = (svg: string, theme: GpuTheme): string =>
  svg.replace(CSS_VAR, (_match, name: string) => {
    const colour = theme.colors[name];
    return colour === undefined ? "transparent" : gpuColorCss(colour);
  });

const loadImage = async (src: string): Promise<HTMLImageElement> => {
  const image = new Image();
  image.src = src;
  await image.decode();
  return image;
};

const IMAGE_TAG = /<image\b[^>]*>/g;
const tagAttr = (tag: string, name: string): string | undefined => {
  const m = tag.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, "i"))
    ?? tag.match(new RegExp(`${name}\\s*=\\s*'([^']*)'`, "i"));
  return m?.[1];
};

// --- Decoded image/media source cache (decode once per theme/file, draw sync at any scale) ---

interface DecodedNestedImage {
  readonly image: HTMLImageElement;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

interface DecodedSvgEntry {
  readonly image: HTMLImageElement;
  readonly nested: ReadonlyArray<DecodedNestedImage>;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  refCount: number;
}

interface DecodedMediaEntry {
  readonly bitmap: ImageBitmap;
  readonly bytes: number;
  refCount: number;
}

const DECODE_SLICE_MS = 2;

const decodedSvgs = new Map<string, DecodedSvgEntry>();
const unreferencedSvgs = new Map<string, true>();
let decodedSvgBytes = 0;
const decodingSvgs = new Map<string, Promise<DecodedSvgEntry>>();
const svgPendingRefs = new Map<string, number>();
const decodedNestedImages = new Map<string, HTMLImageElement>();
const decodingNestedImages = new Map<string, Promise<HTMLImageElement | undefined>>();
const decodedMedia = new Map<string, DecodedMediaEntry>();
const unreferencedMedia = new Map<string, true>();
let decodedMediaBytes = 0;
const decodingMedia = new Map<string, Promise<DecodedMediaEntry>>();
const mediaPendingRefs = new Map<string, number>();

type QueuedDecode =
  | { readonly kind: "svg"; readonly key: string; readonly ref: Extract<NonNullable<Quad["sprite"]>, { readonly atlas: "image" }>; readonly mode: ThemeMode }
  | { readonly kind: "media"; readonly key: string; readonly ref: Extract<NonNullable<Quad["sprite"]>, { readonly atlas: "media" }> };

const pendingDecodeQueue: QueuedDecode[] = [];
const pendingDecodeKeys = new Set<string>();
let decodeDrainScheduled = false;
let decodeChannel: MessageChannel | undefined;

const postDecodeDrain = (): void => {
  if (typeof MessageChannel === "function") {
    if (decodeChannel === undefined) {
      decodeChannel = new MessageChannel();
      decodeChannel.port1.onmessage = () => drainDecodeQueue();
    }
    decodeChannel.port2.postMessage(undefined);
  } else {
    setTimeout(drainDecodeQueue, 0);
  }
};

/**
 * Evict unreferenced decoded sources ONLY under real memory pressure (GPU OOM /
 * allocation failure or host memory-pressure event). Under normal operation, no
 * arbitrary ceiling evicts warm decoded sources (Ruling 2).
 */
const evictUnreferencedSourcesOnPressure = (): void => {
  for (const key of [...unreferencedMedia.keys()]) {
    unreferencedMedia.delete(key);
    const entry = decodedMedia.get(key);
    if (entry !== undefined && entry.refCount <= 0) {
      decodedMediaBytes = Math.max(0, decodedMediaBytes - entry.bytes);
      entry.bitmap.close();
      decodedMedia.delete(key);
    }
  }
  for (const key of [...unreferencedSvgs.keys()]) {
    unreferencedSvgs.delete(key);
    const entry = decodedSvgs.get(key);
    if (entry !== undefined && entry.refCount <= 0) {
      decodedSvgBytes = Math.max(0, decodedSvgBytes - entry.bytes);
      decodedSvgs.delete(key);
    }
  }
};

const drainDecodeQueue = (): void => {
  decodeDrainScheduled = false;
  const start = nowMs();
  while (pendingDecodeQueue.length > 0) {
    const item = pendingDecodeQueue.shift()!;
    pendingDecodeKeys.delete(item.key);
    if (item.kind === "svg") {
      if (!svgPendingRefs.has(item.key) || decodedSvgs.has(item.key) || decodingSvgs.has(item.key)) continue;
      void decodeSvgSourceOnce(item.ref, item.mode).catch(() => {
        svgPendingRefs.delete(item.key);
      });
    } else {
      if (!mediaPendingRefs.has(item.key) || decodedMedia.has(item.key) || decodingMedia.has(item.key)) continue;
      void decodeMediaSourceOnce(item.ref).catch(() => {
        mediaPendingRefs.delete(item.key);
      });
    }
    if (pendingDecodeQueue.length > 0 && nowMs() - start >= DECODE_SLICE_MS) {
      decodeDrainScheduled = true;
      postDecodeDrain();
      return;
    }
  }
};

const scheduleDecodeDrain = (): void => {
  if (decodeDrainScheduled) return;
  decodeDrainScheduled = true;
  // Unclamped MessageChannel macrotask outside rAF: never runs inside paint/holdSource
  // and never hits Chromium's 4ms nested setTimeout clamp.
  postDecodeDrain();
};

const drawFitted = (
  ctx: CanvasRenderingContext2D,
  image: CanvasImageSource,
  iw: number,
  ih: number,
  fit: "contain" | "cover",
  w: number,
  h: number,
): void => {
  const scale = fit === "cover" ? Math.max(w / iw, h / ih) : Math.min(w / iw, h / ih);
  const dw = iw * scale;
  const dh = ih * scale;
  ctx.drawImage(image, (w - dw) / 2, (h - dh) / 2, dw, dh);
};

const loadNestedCached = (href: string): Promise<HTMLImageElement | undefined> => {
  const hit = decodedNestedImages.get(href);
  if (hit !== undefined) return Promise.resolve(hit);
  const inFlight = decodingNestedImages.get(href);
  if (inFlight !== undefined) return inFlight;
  const p = loadImage(href)
    .then((img) => {
      decodedNestedImages.set(href, img);
      return img;
    })
    .catch(() => undefined)
    .finally(() => {
      decodingNestedImages.delete(href);
    });
  decodingNestedImages.set(href, p);
  return p;
};

const decodeSvgSourceOnce = (
  ref: Extract<NonNullable<Quad["sprite"]>, { readonly atlas: "image" }>,
  mode: ThemeMode,
): Promise<DecodedSvgEntry> => {
  const key = `${mode}:${ref.key}`;
  const hit = decodedSvgs.get(key);
  if (hit !== undefined) return Promise.resolve(hit);
  const inFlight = decodingSvgs.get(key);
  if (inFlight !== undefined) return inFlight;

  const p = (async (): Promise<DecodedSvgEntry> => {
    const svg = resolveSvgVars(ref.svg, themeFor(mode));
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    let image: HTMLImageElement;
    try {
      image = await loadImage(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    const tags = svg.match(IMAGE_TAG) ?? [];
    const nestedSpecs: Array<{ readonly href: string; readonly x: number; readonly y: number; readonly w: number; readonly h: number }> = [];
    for (const tag of tags) {
      const href = tagAttr(tag, "href") ?? tagAttr(tag, "xlink:href");
      if (href === undefined || href === "") continue;
      const x = Number(tagAttr(tag, "x") ?? 0);
      const y = Number(tagAttr(tag, "y") ?? 0);
      const w = Number(tagAttr(tag, "width") ?? 0);
      const h = Number(tagAttr(tag, "height") ?? 0);
      if (!Number.isFinite(x + y + w + h) || w <= 0 || h <= 0) continue;
      nestedSpecs.push({ href, x, y, w, h });
    }
    const nestedImgs = nestedSpecs.length === 0 ? [] : await Promise.all(nestedSpecs.map((s) => loadNestedCached(s.href)));
    const nested: DecodedNestedImage[] = [];
    for (let i = 0; i < nestedSpecs.length; i += 1) {
      const nestedImg = nestedImgs[i];
      if (nestedImg !== undefined) {
        const s = nestedSpecs[i]!;
        nested.push({ image: nestedImg, x: s.x, y: s.y, w: s.w, h: s.h });
      }
    }
    const bytes = svg.length * 2 + 1024;
    const entry: DecodedSvgEntry = {
      image,
      nested,
      width: Math.max(1, ref.size.width),
      height: Math.max(1, ref.size.height),
      bytes,
      refCount: svgPendingRefs.get(key) ?? 0,
    };
    svgPendingRefs.delete(key);
    const prev = decodedSvgs.get(key);
    if (prev !== undefined) decodedSvgBytes = Math.max(0, decodedSvgBytes - prev.bytes);
    decodedSvgs.set(key, entry);
    decodedSvgBytes += bytes;
    if (entry.refCount <= 0) {
      unreferencedSvgs.set(key, true);
    } else {
      unreferencedSvgs.delete(key);
    }
    return entry;
  })().finally(() => {
    decodingSvgs.delete(key);
  });
  decodingSvgs.set(key, p);
  return p;
};

const decodeMediaSourceOnce = (
  ref: Extract<NonNullable<Quad["sprite"]>, { readonly atlas: "media" }>,
): Promise<DecodedMediaEntry> => {
  const hit = decodedMedia.get(ref.ref);
  if (hit !== undefined) return Promise.resolve(hit);
  const inFlight = decodingMedia.get(ref.ref);
  if (inFlight !== undefined) return inFlight;

  const p = (async (): Promise<DecodedMediaEntry> => {
    const response = await fetch(ref.ref);
    if (!response.ok) throw new Error(`media fetch ${response.status}`);
    const bitmap = await createImageBitmap(await response.blob());
    const bytes = Math.max(1, bitmap.width * bitmap.height * 4);
    const entry: DecodedMediaEntry = { bitmap, bytes, refCount: mediaPendingRefs.get(ref.ref) ?? 0 };
    mediaPendingRefs.delete(ref.ref);
    const prev = decodedMedia.get(ref.ref);
    if (prev !== undefined) {
      decodedMediaBytes = Math.max(0, decodedMediaBytes - prev.bytes);
      prev.bitmap.close();
    }
    decodedMedia.set(ref.ref, entry);
    decodedMediaBytes += bytes;
    if (entry.refCount <= 0) {
      unreferencedMedia.set(ref.ref, true);
    } else {
      unreferencedMedia.delete(ref.ref);
    }
    return entry;
  })().finally(() => {
    decodingMedia.delete(ref.ref);
  });
  decodingMedia.set(ref.ref, p);
  return p;
};

const prepareDecodedSpriteSource = (ref: NonNullable<Quad["sprite"]>, mode: ThemeMode): void => {
  if (typeof document === "undefined") return;
  if (ref.atlas === "image") {
    const key = `${mode}:${ref.key}`;
    const hit = decodedSvgs.get(key);
    if (hit !== undefined) {
      hit.refCount += 1;
      unreferencedSvgs.delete(key);
      return;
    }
    svgPendingRefs.set(key, (svgPendingRefs.get(key) ?? 0) + 1);
    if (!decodingSvgs.has(key) && !pendingDecodeKeys.has(key)) {
      pendingDecodeKeys.add(key);
      pendingDecodeQueue.push({ kind: "svg", key, ref, mode });
      scheduleDecodeDrain();
    }
  } else if (ref.atlas === "media") {
    const hit = decodedMedia.get(ref.ref);
    if (hit !== undefined) {
      hit.refCount += 1;
      unreferencedMedia.delete(ref.ref);
      return;
    }
    mediaPendingRefs.set(ref.ref, (mediaPendingRefs.get(ref.ref) ?? 0) + 1);
    if (!decodingMedia.has(ref.ref) && !pendingDecodeKeys.has(ref.ref)) {
      pendingDecodeKeys.add(ref.ref);
      pendingDecodeQueue.push({ kind: "media", key: ref.ref, ref });
      scheduleDecodeDrain();
    }
  }
};

const releaseDecodedSpriteSource = (ref: NonNullable<Quad["sprite"]>, mode: ThemeMode): void => {
  if (ref.atlas === "image") {
    const key = `${mode}:${ref.key}`;
    const hit = decodedSvgs.get(key);
    if (hit !== undefined) {
      if (hit.refCount > 0) hit.refCount -= 1;
      if (hit.refCount <= 0) {
        unreferencedSvgs.delete(key);
        unreferencedSvgs.set(key, true);
      }
      return;
    }
    const pending = svgPendingRefs.get(key);
    if (pending !== undefined) {
      if (pending <= 1) svgPendingRefs.delete(key);
      else svgPendingRefs.set(key, pending - 1);
    }
  } else if (ref.atlas === "media") {
    const hit = decodedMedia.get(ref.ref);
    if (hit !== undefined) {
      if (hit.refCount > 0) hit.refCount -= 1;
      if (hit.refCount <= 0) {
        unreferencedMedia.delete(ref.ref);
        unreferencedMedia.set(ref.ref, true);
      }
      return;
    }
    const pending = mediaPendingRefs.get(ref.ref);
    if (pending !== undefined) {
      if (pending <= 1) mediaPendingRefs.delete(ref.ref);
      else mediaPendingRefs.set(ref.ref, pending - 1);
    }
  }
};

const drawDecodedSvg = (ctx: CanvasRenderingContext2D, entry: DecodedSvgEntry, cw: number, ch: number): void => {
  ctx.drawImage(entry.image, 0, 0, cw, ch);
  if (entry.nested.length > 0) {
    const sx = cw / entry.width;
    const sy = ch / entry.height;
    for (const item of entry.nested) {
      ctx.drawImage(item.image, item.x * sx, item.y * sy, item.w * sx, item.h * sy);
    }
  }
};

const drawDecodedMedia = (
  ctx: CanvasRenderingContext2D,
  entry: DecodedMediaEntry,
  fit: "contain" | "cover",
  mode: ThemeMode,
  cw: number,
  ch: number,
): void => {
  const ground = resolveColour({ token: "shadow-2" }, themeFor(mode));
  if (ground !== undefined) {
    ctx.fillStyle = gpuColorCss(ground);
    ctx.fillRect(0, 0, cw, ch);
  }
  drawFitted(ctx, entry.bitmap, entry.bitmap.width, entry.bitmap.height, fit, cw, ch);
};

/** Synchronous sprite rasterizer: marks, glyphs, and any already-decoded SVG or media source. */
export const rasterizeSpriteSync: SpriteRasterizeSync = (quad, mode, scale) => {
  const ref = quad.sprite;
  if (ref === undefined) return undefined;
  const w = Math.max(1, Math.ceil(quad.rect.width * scale));
  const h = Math.max(1, Math.ceil(quad.rect.height * scale));

  if (ref.atlas === "image") {
    const cached = decodedSvgs.get(`${mode}:${ref.key}`);
    if (cached === undefined) return undefined;
    const { canvas, ctx } = getDrawScratch(w, h);
    drawDecodedSvg(ctx, cached, w, h);
    return { source: canvas, width: w, height: h };
  }

  if (ref.atlas === "media") {
    const cached = decodedMedia.get(ref.ref);
    if (cached === undefined) return undefined;
    const { canvas, ctx } = getDrawScratch(w, h);
    drawDecodedMedia(ctx, cached, ref.fit, mode, w, h);
    return { source: canvas, width: w, height: h };
  }

  const { canvas, ctx } = getDrawScratch(w, h);
  if (ref.atlas === "mark") {
    const atlas = markAtlasCanvas(mode);
    if (atlas === undefined) throw new Error("mark atlas unavailable");
    ctx.drawImage(
      atlas,
      ref.cell.col * MARK_CELL, ref.cell.row * MARK_CELL, MARK_CELL, MARK_CELL,
      0, 0, w, h,
    );
    return { source: canvas, width: w, height: h };
  }
  const ink = resolveColour(quad.style.ink, themeFor(mode)) ?? { r: 1, g: 1, b: 1, a: 1 };
  const side = Math.min(w, h);
  ctx.save();
  ctx.translate((w - side) / 2, (h - side) / 2);
  drawGlyph(ctx, ref.name, side, ink);
  ctx.restore();
  return { source: canvas, width: w, height: h };
};

export const rasterizeSprite: SpriteRasterize = async (quad, mode, scale) => {
  const ref = quad.sprite;
  if (ref === undefined) throw new Error("rasterizeSprite needs a sprite quad");
  if (ref.atlas === "mark" || ref.atlas === "glyph") {
    const region = rasterizeSpriteSync(quad, mode, scale) as AtlasCanvasRegion;
    return createImageBitmap(region.source, 0, 0, region.width, region.height);
  }
  const w = Math.max(1, Math.ceil(quad.rect.width * scale));
  const h = Math.max(1, Math.ceil(quad.rect.height * scale));

  if (ref.atlas === "image") {
    const entry = await decodeSvgSourceOnce(ref, mode);
    const { canvas, ctx } = getDrawScratch(w, h);
    drawDecodedSvg(ctx, entry, w, h);
    return { source: canvas, width: w, height: h };
  }

  // media: decode once per file, draw fitted at any scale
  const entry = await decodeMediaSourceOnce(ref);
  const { canvas, ctx } = getDrawScratch(w, h);
  drawDecodedMedia(ctx, entry, ref.fit, mode, w, h);
  return { source: canvas, width: w, height: h };
};

// --- OffscreenCanvas worker pool for off-main-thread rasterization -----------

interface WorkerPool {
  readonly rasterText: TextRasterize;
  readonly rasterGlyph: (name: string, width: number, height: number, ink: GpuColor) => Promise<ImageBitmap>;
}

let workerPool: WorkerPool | null | undefined;

const getWorkerPool = (): WorkerPool | undefined => {
  if (workerPool !== undefined) return workerPool ?? undefined;
  if (typeof Worker !== "function" || typeof OffscreenCanvas !== "function") {
    workerPool = null;
    return undefined;
  }
  try {
    const cores = typeof navigator !== "undefined" && typeof navigator.hardwareConcurrency === "number"
      ? navigator.hardwareConcurrency
      : 4;
    const count = Math.max(1, Math.floor(cores / 2));
    const workers: Worker[] = [];
    const pending = new Map<number, { resolve: (px: AtlasPixels) => void; reject: (err: Error) => void }>();
    let nextId = 1;
    let rr = 0;

    for (let i = 0; i < count; i += 1) {
      const worker = new Worker(new URL("./raster-worker.ts", import.meta.url), { type: "module" });
      worker.onmessage = (event: MessageEvent<RasterWorkerResponse>) => {
        const msg = event.data;
        const entry = pending.get(msg.id);
        if (entry === undefined) {
          if (msg.ok && "bitmap" in msg) msg.bitmap.close();
          return;
        }
        pending.delete(msg.id);
        if (!msg.ok) {
          entry.reject(new Error(msg.error));
        } else if ("coverage" in msg) {
          entry.resolve({ width: msg.width, height: msg.height, data: msg.coverage });
        } else {
          entry.resolve(msg.bitmap);
        }
      };
      worker.onerror = (err) => {
        console.error("atlas raster worker error:", err.message);
      };
      workers.push(worker);
    }

    const dispatch = (req: RasterWorkerRequest, id: number): Promise<AtlasPixels> =>
      new Promise<AtlasPixels>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        const target = workers[rr % workers.length]!;
        rr = (rr + 1) % workers.length;
        target.postMessage(req);
      });

    workerPool = {
      rasterText: (run, scale, ink) => {
        const id = nextId++;
        return dispatch({ kind: "text", id, run, scale, ink }, id);
      },
      rasterGlyph: (name, width, height, ink) => {
        const id = nextId++;
        return dispatch({ kind: "glyph", id, name, width, height, ink }, id) as Promise<ImageBitmap>;
      },
    };
    return workerPool;
  } catch {
    workerPool = null;
    return undefined;
  }
};

export const browserRasterizers = (): Pick<
  GpuAtlasOptions,
  "rasterizeText" | "rasterizeTextSync" | "rasterizeSprite" | "rasterizeSpriteSync" | "preferAsyncRaster"
> => {
  const pool = getWorkerPool();
  if (pool === undefined) {
    return {
      rasterizeText: rasterizeTextRun,
      rasterizeTextSync: rasterizeTextRunSync,
      rasterizeSprite,
      rasterizeSpriteSync,
      preferAsyncRaster: false,
    };
  }
  return {
    rasterizeText: (run, scale, ink) =>
      pool.rasterText(run, scale, ink).catch(() => rasterizeTextRun(run, scale, ink)),
    rasterizeTextSync: rasterizeTextRunSync,
    rasterizeSprite: (quad, mode, scale) => {
      const ref = quad.sprite;
      if (ref?.atlas === "glyph") {
        const w = Math.max(1, Math.ceil(quad.rect.width * scale));
        const h = Math.max(1, Math.ceil(quad.rect.height * scale));
        const ink = resolveColour(quad.style.ink, themeFor(mode)) ?? { r: 1, g: 1, b: 1, a: 1 };
        return pool.rasterGlyph(ref.name, w, h, ink).catch(() => rasterizeSprite(quad, mode, scale));
      }
      return rasterizeSprite(quad, mode, scale);
    },
    rasterizeSpriteSync,
    preferAsyncRaster: true,
  };
};
