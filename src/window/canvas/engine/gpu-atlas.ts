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
import { ATLAS_CELL_FLOATS, type AtlasBinding, type AtlasDirtyCells, type AtlasStats } from "./types";
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
  dispose(): void;
}

type PoolKind = "rgba" | "coverage";

interface Placed {
  readonly pool: PoolKind;
  readonly layer: number;
  readonly shelfIndex: number;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly spanW: number;
}

interface PagePool {
  readonly kind: PoolKind;
  readonly format: GPUTextureFormat;
  readonly bytesPerPixel: number;
  readonly usage: number;
  texture?: GPUTexture;
  layerCount: number;
  readonly pages: Page[];
}

interface FreeSpan {
  x: number;
  w: number;
}

interface Shelf {
  readonly y: number;
  readonly height: number;
  cursorX: number;
  usedCount: number;
  readonly freeSpans: FreeSpan[];
}

interface Page {
  readonly layer: number;
  nextY: number;
  readonly shelves: Shelf[];
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
  attempts: number;
  retryAfter: number;
  desc?: CellDesc;
  jobToken: number;
}

const PREFERRED_PAGE_SIZE = 4096;
const INITIAL_CELL_CAPACITY = 256;
const TEXTURE_USAGE_ATLAS = 0x01 | 0x02 | 0x04 | 0x10; // COPY_SRC | COPY_DST | TEXTURE_BINDING | RENDER_ATTACHMENT
const TEXTURE_USAGE_COVERAGE = 0x01 | 0x02 | 0x04; // COPY_SRC | COPY_DST | TEXTURE_BINDING (writeTexture needs no RENDER_ATTACHMENT)
const SHELF_CLASSES = [16, 24, 32, 48, 64, 96, 128, 192, 256, 384, 512, 768, 1024] as const;
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

const shelfClassFor = (needH: number, pageSize: number): number => {
  for (const h of SHELF_CLASSES) {
    if (h >= needH && h <= pageSize) return h;
  }
  return Math.min(pageSize, needH);
};

const closePixels = (pixels: AtlasPixels): void => {
  if (typeof (pixels as { close?: unknown }).close === "function") {
    (pixels as ImageBitmap).close();
  }
};

const nowMs = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());

export const createGpuAtlas = (options: GpuAtlasOptions = {}): GpuAtlas => {
  const preferredSize = Math.max(64, options.size ?? PREFERRED_PAGE_SIZE);
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
  let mipPipeline: GPURenderPipeline | undefined;
  let mipBindLayout: GPUBindGroupLayout | undefined;
  let rgbaMipCount = 1;
  const dirtyMipLayers = new Set<number>();
  const rgbaPool: PagePool = {
    kind: "rgba",
    format: "rgba8unorm",
    bytesPerPixel: 4,
    usage: TEXTURE_USAGE_ATLAS,
    layerCount: 0,
    pages: [],
  };
  const coveragePool: PagePool = {
    kind: "coverage",
    format: "r8unorm",
    bytesPerPixel: 1,
    usage: TEXTURE_USAGE_COVERAGE,
    layerCount: 0,
    pages: [],
  };
  const poolFor = (kind: PoolKind): PagePool => (kind === "coverage" ? coveragePool : rgbaPool);
  const poolKindOf = (cellKind: "text" | "sprite"): PoolKind => (cellKind === "text" ? "coverage" : "rgba");

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
  let visibleBlank = 0;
  let visibleBlankTotal = 0;

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

  const generateDirtyMipmaps = (): void => {
    if (
      dirtyMipLayers.size === 0 ||
      device === undefined ||
      rgbaPool.texture === undefined ||
      sampler === undefined ||
      mipPipeline === undefined ||
      mipBindLayout === undefined ||
      rgbaMipCount <= 1 ||
      typeof device.createCommandEncoder !== "function"
    ) {
      dirtyMipLayers.clear();
      return;
    }
    const encoder = device.createCommandEncoder();
    if (typeof encoder.beginRenderPass !== "function") {
      dirtyMipLayers.clear();
      return;
    }
    for (const layer of dirtyMipLayers) {
      if (layer < 0 || layer >= rgbaPool.layerCount) continue;
      for (let level = 1; level < rgbaMipCount; level += 1) {
        const srcView = rgbaPool.texture.createView({
          dimension: "2d",
          baseArrayLayer: layer,
          arrayLayerCount: 1,
          baseMipLevel: level - 1,
          mipLevelCount: 1,
        });
        const dstView = rgbaPool.texture.createView({
          dimension: "2d",
          baseArrayLayer: layer,
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
          colorAttachments: [{ view: dstView, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
        });
        pass.setPipeline(mipPipeline);
        pass.setBindGroup(0, bg);
        pass.draw(3);
        pass.end();
      }
    }
    dirtyMipLayers.clear();
    device.queue.submit([encoder.finish()]);
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

  const writeCellUV = (index: number, x: number, y: number, w: number, h: number, layer: number): void => {
    const base = index * ATLAS_CELL_FLOATS;
    cells[base] = x / pageSize;
    cells[base + 1] = y / pageSize;
    cells[base + 2] = (x + w) / pageSize;
    cells[base + 3] = (y + h) / pageSize;
    cells[base + 4] = layer;
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

  const makePage = (layer: number): Page => ({
    layer,
    nextY: 0,
    shelves: [],
  });

  const tryPlaceOnPages = (pool: PagePool, w: number, h: number): Placed | undefined => {
    const needW = w + 1; // 1px transparent gutter on right
    const needH = h + 1; // 1px transparent gutter on bottom
    if (needW > pageSize || needH > pageSize) return undefined;

    // 1. Fit into an existing shelf of compatible height class (free span first, then cursor).
    for (const page of pool.pages) {
      for (let sIdx = 0; sIdx < page.shelves.length; sIdx += 1) {
        const shelf = page.shelves[sIdx]!;
        if (shelf.height < needH || shelf.height > needH * 2) continue;
        // Check free spans (first-fit)
        for (let i = 0; i < shelf.freeSpans.length; i += 1) {
          const span = shelf.freeSpans[i]!;
          if (span.w >= needW) {
            const x = span.x;
            if (span.w === needW) {
              shelf.freeSpans.splice(i, 1);
            } else {
              span.x += needW;
              span.w -= needW;
            }
            shelf.usedCount += 1;
            return { pool: pool.kind, layer: page.layer, shelfIndex: sIdx, x, y: shelf.y, w, h, spanW: needW };
          }
        }
        // Check tail cursor
        if (shelf.cursorX + needW <= pageSize) {
          const x = shelf.cursorX;
          shelf.cursorX += needW;
          shelf.usedCount += 1;
          return { pool: pool.kind, layer: page.layer, shelfIndex: sIdx, x, y: shelf.y, w, h, spanW: needW };
        }
      }
    }

    // 2. Open a new shelf on any page with vertical room.
    const shelfH = shelfClassFor(needH, pageSize);
    for (const page of pool.pages) {
      if (page.nextY + shelfH <= pageSize) {
        // Reserve texel (0,0) on layer 0 row 0 as permanently transparent.
        const startX = page.layer === 0 && page.nextY === 0 ? 1 : 0;
        if (startX + needW > pageSize) continue;
        const shelf: Shelf = {
          y: page.nextY,
          height: shelfH,
          cursorX: startX + needW,
          usedCount: 1,
          freeSpans: [],
        };
        const sIdx = page.shelves.length;
        page.shelves.push(shelf);
        page.nextY += shelfH;
        return { pool: pool.kind, layer: page.layer, shelfIndex: sIdx, x: startX, y: shelf.y, w, h, spanW: needW };
      }
    }
    return undefined;
  };

  const freePlaced = (at: Placed): void => {
    const pool = poolFor(at.pool);
    const page = pool.pages[at.layer];
    if (page === undefined) return;
    const shelf = page.shelves[at.shelfIndex];
    if (shelf === undefined) return;
    shelf.usedCount = Math.max(0, shelf.usedCount - 1);
    if (shelf.usedCount === 0) {
      shelf.freeSpans.length = 0;
      shelf.cursorX = page.layer === 0 && shelf.y === 0 ? 1 : 0;
      while (page.shelves.length > 0 && page.shelves[page.shelves.length - 1]!.usedCount === 0) {
        const popped = page.shelves.pop()!;
        page.nextY = popped.y;
      }
      return;
    }
    const spans = shelf.freeSpans;
    let insertAt = 0;
    while (insertAt < spans.length && spans[insertAt]!.x < at.x) insertAt += 1;
    spans.splice(insertAt, 0, { x: at.x, w: at.spanW });
    if (insertAt + 1 < spans.length) {
      const cur = spans[insertAt]!;
      const nxt = spans[insertAt + 1]!;
      if (cur.x + cur.w === nxt.x) {
        cur.w += nxt.w;
        spans.splice(insertAt + 1, 1);
      }
    }
    if (insertAt > 0) {
      const prev = spans[insertAt - 1]!;
      const cur = spans[insertAt]!;
      if (prev.x + prev.w === cur.x) {
        prev.w += cur.w;
        spans.splice(insertAt, 1);
      }
    }
    const last = spans[spans.length - 1];
    if (last !== undefined && last.x + last.w === shelf.cursorX) {
      shelf.cursorX = last.x;
      spans.pop();
    }
  };

  const freeStandalone = (rec: SlotRecord): void => {
    if (rec.standalone === undefined) return;
    rec.standalone.texture.destroy();
    standaloneBytes = Math.max(0, standaloneBytes - rec.standalone.bytes);
    standaloneTextures.delete(rec.index);
    rec.standalone = undefined;
  };

  const evictOneUnreferenced = (preferredPool?: PoolKind): boolean => {
    let chosen: number | undefined;
    for (const idx of unreferencedLru.keys()) {
      const rec = slots[idx];
      if (rec === undefined || rec.refCount > 0) {
        unreferencedLru.delete(idx);
        continue;
      }
      if (preferredPool === undefined || rec.placed?.pool === preferredPool) {
        chosen = idx;
        break;
      }
    }
    if (chosen === undefined) return false;
    unreferencedLru.delete(chosen);
    const rec = slots[chosen]!;
    if (rec.placed !== undefined) {
      freePlaced(rec.placed);
      rec.placed = undefined;
    }
    freeStandalone(rec);
    if (rec.state === "landed") {
      landedCount = Math.max(0, landedCount - 1);
      removeContentLanded(rec.contentKey, chosen);
    }
    keyToIndex.delete(rec.key);
    compatHeld.delete(rec.key);
    clearCellUV(chosen);
    slots[chosen] = undefined;
    freeIndices.push(chosen);
    evictions += 1;
    return true;
  };

  const createTexture2DArray = (
    targetDevice: GPUDevice,
    width: number,
    height: number,
    layers: number,
    format: GPUTextureFormat = "rgba8unorm",
    usage: number = TEXTURE_USAGE_ATLAS,
    mipLevelCount = 1,
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
      reportFailure(`atlas texture allocation failed (${width}x${height}x${layers} ${format}): ${String(error)}`);
      if (hasScope) void targetDevice.popErrorScope().catch(() => undefined);
      return undefined;
    }
    if (hasScope) {
      void targetDevice.popErrorScope().then((err) => {
        if (err !== null) {
          reportFailure(`atlas GPU out-of-memory (${width}x${height}x${layers} ${format}): ${err.message}`);
        }
      }).catch(() => undefined);
    }
    return created;
  };

  const growPages = (pool: PagePool): boolean => {
    if (device === undefined || pool.texture === undefined) return false;
    if (pool.layerCount >= maxArrayLayers) {
      reportFailure(`atlas ${pool.kind} page limit reached (${pool.layerCount}/${maxArrayLayers} layers)`);
      return false;
    }
    const nextLayers = pool.layerCount + 1;
    const mips = pool.kind === "rgba" ? rgbaMipCount : 1;
    const nextTexture = createTexture2DArray(device, pageSize, pageSize, nextLayers, pool.format, pool.usage, mips);
    if (nextTexture === undefined) return false;
    if (pool.layerCount > 0 && typeof device.createCommandEncoder === "function") {
      const encoder = device.createCommandEncoder();
      if (typeof encoder.copyTextureToTexture === "function") {
        encoder.copyTextureToTexture(
          { texture: pool.texture, origin: { x: 0, y: 0, z: 0 } },
          { texture: nextTexture, origin: { x: 0, y: 0, z: 0 } },
          { width: pageSize, height: pageSize, depthOrArrayLayers: pool.layerCount },
        );
      }
      device.queue.submit([encoder.finish()]);
      if (pool.kind === "rgba" && rgbaMipCount > 1) {
        for (let l = 0; l < pool.layerCount; l += 1) dirtyMipLayers.add(l);
      }
    }
    pool.texture.destroy();
    pool.texture = nextTexture;
    if (pool.kind === "rgba") mutable.texture = nextTexture;
    else mutable.coverageTexture = nextTexture;
    pool.pages.push(makePage(pool.layerCount));
    pool.layerCount = nextLayers;
    textureGeneration += 1;
    mutable.textureGeneration = textureGeneration;
    markDirty();
    return true;
  };

  const alloc = (pool: PagePool, w: number, h: number): Placed | undefined => {
    let at = tryPlaceOnPages(pool, w, h);
    if (at !== undefined) return at;

    while (evictOneUnreferenced(pool.kind)) {
      at = tryPlaceOnPages(pool, w, h);
      if (at !== undefined) return at;
    }

    if (growPages(pool)) {
      at = tryPlaceOnPages(pool, w, h);
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
    const gw = Math.min(pageSize - at.x, w + 1);
    const gh = Math.min(pageSize - at.y, h + 1);
    if (pool.kind === "coverage") {
      const data = coverageBytesOf(pixels, w, h);
      // Include 1px transparent gutter on right and bottom so reused space never bleeds old pixels
      if (gw > w || gh > h) {
        const padded = new Uint8Array(gw * gh);
        for (let row = 0; row < h; row += 1) {
          padded.set(data.subarray(row * w, row * w + w), row * gw);
        }
        device!.queue.writeTexture(
          { texture: pool.texture!, origin: { x: at.x, y: at.y, z: at.layer } },
          padded as Uint8Array<ArrayBuffer>,
          { bytesPerRow: gw, rowsPerImage: gh },
          { width: gw, height: gh, depthOrArrayLayers: 1 },
        );
      } else {
        device!.queue.writeTexture(
          { texture: pool.texture!, origin: { x: at.x, y: at.y, z: at.layer } },
          data as Uint8Array<ArrayBuffer>,
          { bytesPerRow: w, rowsPerImage: h },
          { width: w, height: h, depthOrArrayLayers: 1 },
        );
      }
      return;
    }
    const imgSource = ("source" in pixels ? pixels.source : pixels) as unknown as ImageBitmap;
    // Copy with cleared 1px gutter when source is a grow-only scratch canvas that has room
    const copyW = "source" in pixels && pixels.source.width >= gw ? gw : w;
    const copyH = "source" in pixels && pixels.source.height >= gh ? gh : h;
    device!.queue.copyExternalImageToTexture(
      { source: imgSource },
      { texture: pool.texture!, origin: { x: at.x, y: at.y, z: at.layer } },
      { width: copyW, height: copyH },
    );
    if (rgbaMipCount > 1) dirtyMipLayers.add(at.layer);
  };

  /**
   * Land an item larger than a packing page at full on-screen resolution:
   * - Text uses `r8unorm` (1 byte/px); sprites use `rgba8unorm` (4 bytes/px).
   * - Up to `maxTexDim` per side: a dedicated 1-layer standalone texture sized to `(w, h)`.
   * - Beyond `maxTexDim`: a dedicated tiled `2d-array` texture of `tilesX * tilesY` layers.
   */
  const landStandalone = (pool: PagePool, rec: SlotRecord, pixels: AtlasPixels, w: number, h: number): boolean => {
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
        freePlaced(rec.placed);
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
    if (disposed || device === undefined || pool.texture === undefined) return false;
    const w = Math.max(1, pixels.width);
    const h = Math.max(1, pixels.height);

    // Items larger than a packing page get a full-resolution standalone (or tiled) texture.
    if (w + 1 > pageSize || h + 1 > pageSize) {
      return landStandalone(pool, rec, pixels, w, h);
    }

    freeStandalone(rec);
    // In-place overwrite if rec already holds a matching rect in the same pool
    let at: Placed | undefined;
    if (rec.inPlace && rec.placed !== undefined && rec.placed.pool === pool.kind && rec.placed.w === w && rec.placed.h === h) {
      at = rec.placed;
    } else {
      if (rec.placed !== undefined) {
        freePlaced(rec.placed);
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
    rec.placed = at;
    rec.inPlace = false;
    const wasLanded = rec.state === "landed";
    rec.state = "landed";
    rec.attempts = 0;
    rec.retryAfter = 0;
    if (!wasLanded) landedCount += 1;
    addContentLanded(rec.contentKey, rec.index);
    writeCellUV(rec.index, at.x, at.y, w, h, at.layer);
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

  const scheduleDrain = (): void => {
    if (drainScheduled || disposed || device === undefined || rgbaPool.texture === undefined) return;
    drainScheduled = true;
    queueMicrotask(drainQueue);
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
    if (rec.desc === undefined || device === undefined || rgbaPool.texture === undefined) return;
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
    if (disposed || device === undefined || rgbaPool.texture === undefined) return;
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
        setTimeout(drainQueue, 0);
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

    releaseAlias(rec);
    if (rec.state === "landed") {
      rec.desc = undefined;
      unreferencedLru.set(cell, true);
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
      rec.refCount += 1;
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
      sRec.refCount += 1;
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
    if (device === undefined || rgbaPool.texture === undefined) return false;
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
    return hasImage(cell);
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
    return {
      requests,
      pending: queuedSet.size + inFlightCount,
      landed: landedCount,
      evictions,
      failures,
      pages: rgbaPool.layerCount + coveragePool.layerCount,
      pageSize,
      bytesInUse:
        Math.round(
          rgbaPool.layerCount *
            pageSize *
            pageSize *
            rgbaPool.bytesPerPixel *
            (rgbaMipCount > 1 ? 4 / 3 : 1),
        ) +
        coveragePool.layerCount * pageSize * pageSize * coveragePool.bytesPerPixel +
        standaloneBytes,
      activeCells,
      pinnedCells,
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
      if (rgbaPool.texture !== undefined && !fresh) return;

      // Read real device limits; page edge is a packing choice, never a capacity cap.
      const maxDim = next.limits?.maxTextureDimension2D;
      maxTexDim = typeof maxDim === "number" && maxDim > 0 ? maxDim : 8192;
      pageSize = Math.min(preferredSize, maxTexDim);
      const maxLayers = next.limits?.maxTextureArrayLayers;
      maxArrayLayers = typeof maxLayers === "number" && maxLayers > 0 ? maxLayers : 256;
      const maxStorage = next.limits?.maxStorageBufferBindingSize;
      maxCellsByLimit =
        typeof maxStorage === "number" && maxStorage > 0
          ? Math.max(1, Math.floor(maxStorage / (ATLAS_CELL_FLOATS * 4)))
          : Number.MAX_SAFE_INTEGER;

      rgbaPool.texture?.destroy();
      coveragePool.texture?.destroy();
      for (const tex of standaloneTextures.values()) tex.destroy();
      standaloneTextures.clear();
      standaloneBytes = 0;
      rgbaPool.pages.length = 0;
      rgbaPool.layerCount = 0;
      coveragePool.pages.length = 0;
      coveragePool.layerCount = 0;
      dirtyMipLayers.clear();

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
        rgbaMipCount = Math.max(1, Math.floor(Math.log2(pageSize)) + 1);
      }

      const initialRgba = createTexture2DArray(next, pageSize, pageSize, 1, rgbaPool.format, rgbaPool.usage, rgbaMipCount);
      const initialCov = createTexture2DArray(next, pageSize, pageSize, 1, coveragePool.format, coveragePool.usage, 1);
      if (initialRgba === undefined || initialCov === undefined) {
        initialRgba?.destroy();
        initialCov?.destroy();
        return;
      }
      rgbaPool.texture = initialRgba;
      rgbaPool.layerCount = 1;
      rgbaPool.pages.push(makePage(0));
      coveragePool.texture = initialCov;
      coveragePool.layerCount = 1;
      coveragePool.pages.push(makePage(0));
      sampler = next.createSampler({
        magFilter: "linear",
        minFilter: "linear",
        mipmapFilter: "linear",
        addressModeU: "clamp-to-edge",
        addressModeV: "clamp-to-edge",
      });
      mutable.texture = initialRgba;
      mutable.coverageTexture = initialCov;
      mutable.sampler = sampler;
      textureGeneration += 1;
      mutable.textureGeneration = textureGeneration;
      allCellsDirty = true;

      // Device loss / re-attach (Ruling 6 #3): drop unreferenced cells and
      // re-rasterize all referenced cells immediately (sync where possible,
      // async queued for SVG/media) before the first frame presents.
      unreferencedLru.clear();
      contentLanded.clear();
      landedCount = 0;
      for (let i = 0; i < highWaterCells; i += 1) {
        const rec = slots[i];
        if (rec === undefined) continue;
        rec.placed = undefined;
        rec.standalone = undefined;
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
    dispose: () => {
      disposed = true;
      rgbaPool.texture?.destroy();
      rgbaPool.texture = undefined;
      coveragePool.texture?.destroy();
      coveragePool.texture = undefined;
      for (const tex of standaloneTextures.values()) tex.destroy();
      standaloneTextures.clear();
      standaloneBytes = 0;
      rgbaPool.layerCount = 0;
      rgbaPool.pages.length = 0;
      coveragePool.layerCount = 0;
      coveragePool.pages.length = 0;
      dirtyMipLayers.clear();
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
  refCount: number;
}

interface DecodedMediaEntry {
  readonly bitmap: ImageBitmap;
  refCount: number;
}

const decodedSvgs = new Map<string, DecodedSvgEntry>();
const decodingSvgs = new Map<string, Promise<DecodedSvgEntry>>();
const svgPendingRefs = new Map<string, number>();
const decodedNestedImages = new Map<string, HTMLImageElement>();
const decodingNestedImages = new Map<string, Promise<HTMLImageElement | undefined>>();
const decodedMedia = new Map<string, DecodedMediaEntry>();
const decodingMedia = new Map<string, Promise<DecodedMediaEntry>>();
const mediaPendingRefs = new Map<string, number>();

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
    const nested: DecodedNestedImage[] = [];
    for (const tag of tags) {
      const href = tagAttr(tag, "href") ?? tagAttr(tag, "xlink:href");
      if (href === undefined || href === "") continue;
      const x = Number(tagAttr(tag, "x") ?? 0);
      const y = Number(tagAttr(tag, "y") ?? 0);
      const w = Number(tagAttr(tag, "width") ?? 0);
      const h = Number(tagAttr(tag, "height") ?? 0);
      if (!Number.isFinite(x + y + w + h) || w <= 0 || h <= 0) continue;
      const nestedImg = await loadNestedCached(href);
      if (nestedImg !== undefined) nested.push({ image: nestedImg, x, y, w, h });
    }
    const entry: DecodedSvgEntry = {
      image,
      nested,
      width: Math.max(1, ref.size.width),
      height: Math.max(1, ref.size.height),
      refCount: svgPendingRefs.get(key) ?? 0,
    };
    svgPendingRefs.delete(key);
    if (entry.refCount >= 0) {
      decodedSvgs.set(key, entry);
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
    const entry: DecodedMediaEntry = { bitmap, refCount: mediaPendingRefs.get(ref.ref) ?? 0 };
    mediaPendingRefs.delete(ref.ref);
    if (entry.refCount >= 0) {
      decodedMedia.set(ref.ref, entry);
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
      return;
    }
    svgPendingRefs.set(key, (svgPendingRefs.get(key) ?? 0) + 1);
    void decodeSvgSourceOnce(ref, mode).catch(() => { svgPendingRefs.delete(key); });
  } else if (ref.atlas === "media") {
    const hit = decodedMedia.get(ref.ref);
    if (hit !== undefined) {
      hit.refCount += 1;
      return;
    }
    mediaPendingRefs.set(ref.ref, (mediaPendingRefs.get(ref.ref) ?? 0) + 1);
    void decodeMediaSourceOnce(ref).catch(() => { mediaPendingRefs.delete(ref.ref); });
  }
};

const releaseDecodedSpriteSource = (ref: NonNullable<Quad["sprite"]>, mode: ThemeMode): void => {
  if (ref.atlas === "image") {
    const key = `${mode}:${ref.key}`;
    const hit = decodedSvgs.get(key);
    if (hit !== undefined) {
      if (hit.refCount > 0) hit.refCount -= 1;
      if (hit.refCount <= 0) decodedSvgs.delete(key);
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
        hit.bitmap.close();
        decodedMedia.delete(ref.ref);
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
