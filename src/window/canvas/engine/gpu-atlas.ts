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
import { ATLAS_CELL_FLOATS, type AtlasBinding, type AtlasStats } from "./types";
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

/** Anything the GPU can copy into the atlas: an ImageBitmap or canvas. */
export type AtlasPixels = ImageBitmap | HTMLCanvasElement | OffscreenCanvas;

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
   * that still has no image. Returns `hasImage(cell)` afterward.
   */
  ensureNow(cell: number): boolean;
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

interface Placed {
  readonly layer: number;
  readonly shelfIndex: number;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly spanW: number;
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

interface SlotRecord {
  readonly index: number;
  key: string;
  contentKey: string;
  scale: number;
  refCount: number;
  state: CellState;
  placed?: Placed;
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
const SHELF_CLASSES = [16, 24, 32, 48, 64, 96, 128, 192, 256, 384, 512, 768, 1024] as const;
const DRAIN_YIELD_MS = 4;
const BASE_RETRY_MS = 250;
const MAX_RETRY_MS = 8000;

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
  let maxArrayLayers = 256;
  let maxCellsByLimit = Number.MAX_SAFE_INTEGER;
  let mode: ThemeMode = options.mode ?? "dark";

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
  /** Compat tracking so repeated `sourceFor` calls for the same key don't leak refs. */
  const compatHeld = new Set<string>();

  const queue: number[] = [];
  const queuedSet = new Set<number>();
  let drainScheduled = false;
  let inFlightCount = 0;

  let device: GPUDevice | undefined;
  let texture: GPUTexture | undefined;
  let sampler: GPUSampler | undefined;
  let layerCount = 0;
  const pages: Page[] = [];

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

  const mutable = {
    texture: undefined as unknown as GPUTexture,
    sampler: undefined as unknown as GPUSampler,
    cells,
    cellCount: 0,
    textureGeneration: 0,
  };
  const binding = mutable as AtlasBinding;

  const reportFailure = (reason: string): void => {
    failures += 1;
    options.onFailure?.(reason);
  };

  const flushDirty = (): void => {
    flushScheduled = false;
    if (dirty && !disposed) {
      dirty = false;
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
  };

  const copyCellUV = (dstIndex: number, srcIndex: number): void => {
    const d = dstIndex * ATLAS_CELL_FLOATS;
    const s = srcIndex * ATLAS_CELL_FLOATS;
    for (let i = 0; i < ATLAS_CELL_FLOATS; i += 1) {
      cells[d + i] = cells[s + i]!;
    }
  };

  const clearCellUV = (index: number): void => {
    const base = index * ATLAS_CELL_FLOATS;
    for (let i = 0; i < ATLAS_CELL_FLOATS; i += 1) {
      cells[base + i] = 0;
    }
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

  const tryPlaceOnPages = (w: number, h: number): Placed | undefined => {
    const needW = w + 1; // 1px transparent gutter on right
    const needH = h + 1; // 1px transparent gutter on bottom
    if (needW > pageSize || needH > pageSize) return undefined;

    // 1. Fit into an existing shelf of compatible height class (free span first, then cursor).
    for (const page of pages) {
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
            return { layer: page.layer, shelfIndex: sIdx, x, y: shelf.y, w, h, spanW: needW };
          }
        }
        // Check tail cursor
        if (shelf.cursorX + needW <= pageSize) {
          const x = shelf.cursorX;
          shelf.cursorX += needW;
          shelf.usedCount += 1;
          return { layer: page.layer, shelfIndex: sIdx, x, y: shelf.y, w, h, spanW: needW };
        }
      }
    }

    // 2. Open a new shelf on any page with vertical room.
    const shelfH = shelfClassFor(needH, pageSize);
    for (const page of pages) {
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
        return { layer: page.layer, shelfIndex: sIdx, x: startX, y: shelf.y, w, h, spanW: needW };
      }
    }
    return undefined;
  };

  const freePlaced = (at: Placed): void => {
    const page = pages[at.layer];
    if (page === undefined) return;
    const shelf = page.shelves[at.shelfIndex];
    if (shelf === undefined) return;
    shelf.usedCount = Math.max(0, shelf.usedCount - 1);
    if (shelf.usedCount === 0) {
      shelf.freeSpans.length = 0;
      shelf.cursorX = page.layer === 0 && shelf.y === 0 ? 1 : 0;
      // Rewind trailing empty shelves on this page so tall items can claim contiguous vertical room.
      while (page.shelves.length > 0 && page.shelves[page.shelves.length - 1]!.usedCount === 0) {
        const popped = page.shelves.pop()!;
        page.nextY = popped.y;
      }
      return;
    }
    // Insert and coalesce free span
    const spans = shelf.freeSpans;
    let insertAt = 0;
    while (insertAt < spans.length && spans[insertAt]!.x < at.x) insertAt += 1;
    spans.splice(insertAt, 0, { x: at.x, w: at.spanW });
    // Coalesce with next
    if (insertAt + 1 < spans.length) {
      const cur = spans[insertAt]!;
      const nxt = spans[insertAt + 1]!;
      if (cur.x + cur.w === nxt.x) {
        cur.w += nxt.w;
        spans.splice(insertAt + 1, 1);
      }
    }
    // Coalesce with prev
    if (insertAt > 0) {
      const prev = spans[insertAt - 1]!;
      const cur = spans[insertAt]!;
      if (prev.x + prev.w === cur.x) {
        prev.w += cur.w;
        spans.splice(insertAt, 1);
      }
    }
    // Trim tail span back into cursorX if adjacent
    const last = spans[spans.length - 1];
    if (last !== undefined && last.x + last.w === shelf.cursorX) {
      shelf.cursorX = last.x;
      spans.pop();
    }
  };

  const evictOneUnreferenced = (): boolean => {
    const first = unreferencedLru.keys().next();
    if (first.done) return false;
    const idx = first.value;
    unreferencedLru.delete(idx);
    const rec = slots[idx];
    if (rec === undefined || rec.refCount > 0) return false;
    if (rec.placed !== undefined) {
      freePlaced(rec.placed);
      rec.placed = undefined;
    }
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
    return true;
  };

  const createArrayTexture = (targetDevice: GPUDevice, layers: number): GPUTexture | undefined => {
    const hasScope = typeof targetDevice.pushErrorScope === "function" && typeof targetDevice.popErrorScope === "function";
    if (hasScope) targetDevice.pushErrorScope("out-of-memory");
    let created: GPUTexture | undefined;
    try {
      created = targetDevice.createTexture({
        size: { width: pageSize, height: pageSize, depthOrArrayLayers: layers },
        format: "rgba8unorm",
        usage: TEXTURE_USAGE_ATLAS,
      });
    } catch (error) {
      reportFailure(`atlas texture allocation failed (${pageSize}x${pageSize}x${layers}): ${String(error)}`);
      if (hasScope) void targetDevice.popErrorScope().catch(() => undefined);
      return undefined;
    }
    if (hasScope) {
      void targetDevice.popErrorScope().then((err) => {
        if (err !== null) {
          reportFailure(`atlas GPU out-of-memory (${pageSize}x${pageSize}x${layers}): ${err.message}`);
        }
      }).catch(() => undefined);
    }
    return created;
  };

  const growPages = (): boolean => {
    if (device === undefined || texture === undefined) return false;
    if (layerCount >= maxArrayLayers) {
      reportFailure(`atlas page limit reached (${layerCount}/${maxArrayLayers} layers)`);
      return false;
    }
    const nextLayers = layerCount + 1;
    const nextTexture = createArrayTexture(device, nextLayers);
    if (nextTexture === undefined) return false;
    // Copy existing layers into the new array texture on GPU.
    if (layerCount > 0 && typeof device.createCommandEncoder === "function") {
      const encoder = device.createCommandEncoder();
      if (typeof encoder.copyTextureToTexture === "function") {
        encoder.copyTextureToTexture(
          { texture, origin: { x: 0, y: 0, z: 0 } },
          { texture: nextTexture, origin: { x: 0, y: 0, z: 0 } },
          { width: pageSize, height: pageSize, depthOrArrayLayers: layerCount },
        );
      }
      device.queue.submit([encoder.finish()]);
    }
    texture.destroy();
    texture = nextTexture;
    mutable.texture = texture;
    pages.push(makePage(layerCount));
    layerCount = nextLayers;
    textureGeneration += 1;
    mutable.textureGeneration = textureGeneration;
    markDirty();
    return true;
  };

  /**
   * Allocate a rect of `(w, h)` on the paged texture:
   * 1. Try existing pages.
   * 2. Reclaim unreferenced (off-screen) cells in LRU order until it fits.
   * 3. Add a page on demand only when referenced cells do not fit.
   */
  const alloc = (w: number, h: number): Placed | undefined => {
    let at = tryPlaceOnPages(w, h);
    if (at !== undefined) return at;

    // Reclaim off-screen (unreferenced) cells first
    while (evictOneUnreferenced()) {
      at = tryPlaceOnPages(w, h);
      if (at !== undefined) return at;
    }

    // Only what is on screen (referenced) remains; add a page on demand
    if (growPages()) {
      at = tryPlaceOnPages(w, h);
      if (at !== undefined) return at;
    }
    return undefined;
  };

  // --- Scale clamping & pixel upload ------------------------------------------

  const effectiveScaleFor = (quad: Quad, scale: number): number => {
    const maxEdge = Math.max(1, pageSize - 1);
    let estW = 0;
    let estH = 0;
    if (quad.sprite !== undefined) {
      estW = Math.ceil(quad.rect.width * scale);
      estH = Math.ceil(quad.rect.height * scale);
    } else if (quad.text !== undefined) {
      const run = quad.text;
      const pad = run.blur === undefined ? 0 : haloPadDevice(scale);
      estW = Math.ceil(run.width * scale) + 2 * pad;
      estH = Math.ceil(run.size * scale * (run.leading ?? 1.2)) + 2 * pad;
    }
    if (estW <= maxEdge && estH <= maxEdge) return scale;
    const factor = Math.min(maxEdge / Math.max(1, estW), maxEdge / Math.max(1, estH));
    return Math.max(1e-3, scale * factor);
  };

  const clampPixelsToPage = (pixels: AtlasPixels): { readonly pixels: AtlasPixels; readonly owned: boolean } => {
    const maxEdge = Math.max(1, pageSize - 1);
    const w = Math.max(1, pixels.width);
    const h = Math.max(1, pixels.height);
    if (w <= maxEdge && h <= maxEdge) return { pixels, owned: false };
    const ratio = Math.min(maxEdge / w, maxEdge / h);
    const dw = Math.max(1, Math.floor(w * ratio));
    const dh = Math.max(1, Math.floor(h * ratio));
    if (typeof document === "undefined") return { pixels, owned: false };
    const { canvas, ctx } = scratchClampCanvas(dw, dh);
    ctx.clearRect(0, 0, dw, dh);
    ctx.drawImage(pixels as CanvasImageSource, 0, 0, dw, dh);
    return { pixels: canvas, owned: true };
  };

  const copyPixels = (pixels: AtlasPixels, at: Placed): void => {
    device!.queue.copyExternalImageToTexture(
      { source: pixels as unknown as ImageBitmap },
      { texture: texture!, origin: { x: at.x, y: at.y, z: at.layer } },
      { width: Math.max(1, Math.min(at.w, pixels.width)), height: Math.max(1, Math.min(at.h, pixels.height)) },
    );
  };

  // --- Reference release & alias settlement -----------------------------------

  const releaseAlias = (rec: SlotRecord): void => {
    if (rec.aliasOf === undefined) return;
    const target = rec.aliasOf;
    rec.aliasOf = undefined;
    release(target);
  };

  const landPixels = (rec: SlotRecord, rawPixels: AtlasPixels): boolean => {
    if (disposed || device === undefined || texture === undefined) return false;
    const clamped = clampPixelsToPage(rawPixels);
    const pixels = clamped.pixels;
    const w = Math.max(1, Math.min(pageSize - 1, pixels.width));
    const h = Math.max(1, Math.min(pageSize - 1, pixels.height));

    // In-place overwrite if rec already holds a matching rect
    let at: Placed | undefined;
    if (rec.inPlace && rec.placed !== undefined && rec.placed.w === w && rec.placed.h === h) {
      at = rec.placed;
    } else {
      if (rec.placed !== undefined) {
        freePlaced(rec.placed);
        rec.placed = undefined;
      }
      at = alloc(w, h);
    }

    if (at === undefined) {
      rec.state = "failed";
      rec.attempts += 1;
      rec.retryAfter = nowMs() + Math.min(MAX_RETRY_MS, BASE_RETRY_MS * 2 ** Math.min(6, rec.attempts - 1));
      reportFailure(`atlas alloc failed for ${w}x${h} (key=${rec.key})`);
      return false;
    }

    copyPixels(pixels, at);
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
    if (drainScheduled || disposed || device === undefined || texture === undefined) return;
    drainScheduled = true;
    queueMicrotask(drainQueue);
  };

  const rasterizeSync = (desc: CellDesc): AtlasPixels | undefined => {
    const effScale = effectiveScaleFor(desc.quad, desc.scale);
    if (desc.kind === "text") {
      if (options.rasterizeTextSync === undefined) return undefined;
      const ink = resolveColour(desc.quad.style.ink, themeFor(desc.mode)) ?? { r: 1, g: 1, b: 1, a: 1 };
      return options.rasterizeTextSync(desc.quad.text!, effScale, ink);
    }
    if (options.rasterizeSpriteSync === undefined) return undefined;
    return options.rasterizeSpriteSync(desc.quad, desc.mode, effScale);
  };

  const rasterizeAsync = (desc: CellDesc): Promise<AtlasPixels> => {
    const effScale = effectiveScaleFor(desc.quad, desc.scale);
    if (desc.kind === "text") {
      if (options.rasterizeText === undefined) return Promise.reject(new Error("no text rasterizer"));
      const ink = resolveColour(desc.quad.style.ink, themeFor(desc.mode)) ?? { r: 1, g: 1, b: 1, a: 1 };
      return options.rasterizeText(desc.quad.text!, effScale, ink);
    }
    if (options.rasterizeSprite === undefined) return Promise.reject(new Error("no sprite rasterizer"));
    return options.rasterizeSprite(desc.quad, desc.mode, effScale);
  };

  const runJob = (rec: SlotRecord): void => {
    if (rec.desc === undefined || device === undefined || texture === undefined) return;
    const desc = rec.desc;
    const token = ++nextJobToken;
    rec.jobToken = token;
    rec.state = "rasterizing";

    // Prefer sync raster for text/mark/glyph when available — zero ImageBitmap allocation.
    if ((desc.kind === "text" && options.rasterizeTextSync !== undefined) ||
        (desc.kind === "sprite" && options.rasterizeSpriteSync !== undefined)) {
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
    if (disposed || device === undefined || texture === undefined) return;
    const start = nowMs();
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
      if (queue.length > 0 && nowMs() - start >= DRAIN_YIELD_MS) {
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
      const ink = inkKey(quad.style.ink);
      const contentKey = `txt:${mode}:${run.text}:${run.font}:${run.weight}:${run.upper ? 1 : 0}:${run.italic ? 1 : 0}:${run.blur ?? 0}:${run.truncate}:${run.align ?? "left"}:${ink}`;
      return { key: `txt:${mode}:${runKey(run, scale, 0)}:${ink}`, contentKey, kind: "text" };
    }
    return undefined;
  };

  const expectedBoxFor = (quad: Quad, scale: number): { readonly w: number; readonly h: number } | undefined => {
    const effScale = effectiveScaleFor(quad, scale);
    if (quad.sprite !== undefined) {
      return {
        w: Math.max(1, Math.min(pageSize - 1, Math.ceil(quad.rect.width * effScale))),
        h: Math.max(1, Math.min(pageSize - 1, Math.ceil(quad.rect.height * effScale))),
      };
    }
    if (quad.text !== undefined) {
      const run = quad.text;
      if (run.truncate === "none" || run.truncate === "clamp2") return undefined; // multi-line height may vary
      const pad = run.blur === undefined ? 0 : haloPadDevice(effScale);
      const lineHeight = run.size * effScale * (run.leading ?? 1.2);
      return {
        w: Math.max(1, Math.min(pageSize - 1, Math.ceil(run.width * effScale) + 2 * pad)),
        h: Math.max(1, Math.min(pageSize - 1, Math.ceil(lineHeight) + 2 * pad)),
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
    if (device === undefined || texture === undefined) return false;
    const rec = slots[cell];
    if (rec === undefined || rec.desc === undefined) return false;
    // Attempt synchronous raster + copy before the frame is submitted.
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
      pages: layerCount,
      pageSize,
      bytesInUse: layerCount * pageSize * pageSize * 4,
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
      if (texture !== undefined && !fresh) return;

      // Read real device limits; page edge is a packing choice clamped to GPU limits.
      const maxDim = next.limits?.maxTextureDimension2D;
      pageSize = typeof maxDim === "number" && maxDim > 0 ? Math.min(preferredSize, maxDim) : preferredSize;
      const maxLayers = next.limits?.maxTextureArrayLayers;
      maxArrayLayers = typeof maxLayers === "number" && maxLayers > 0 ? maxLayers : 256;
      const maxStorage = next.limits?.maxStorageBufferBindingSize;
      maxCellsByLimit =
        typeof maxStorage === "number" && maxStorage > 0
          ? Math.max(1, Math.floor(maxStorage / (ATLAS_CELL_FLOATS * 4)))
          : Number.MAX_SAFE_INTEGER;

      texture?.destroy();
      pages.length = 0;
      layerCount = 0;
      const initialTex = createArrayTexture(next, 1);
      if (initialTex === undefined) return;
      texture = initialTex;
      layerCount = 1;
      pages.push(makePage(0));
      sampler = next.createSampler({
        magFilter: "linear",
        minFilter: "linear",
        addressModeU: "clamp-to-edge",
        addressModeV: "clamp-to-edge",
      });
      mutable.texture = texture;
      mutable.sampler = sampler;
      textureGeneration += 1;
      mutable.textureGeneration = textureGeneration;

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
      texture?.destroy();
      texture = undefined;
      layerCount = 0;
      pages.length = 0;
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

const canvas2d = (w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } => {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(w));
  canvas.height = Math.max(1, Math.ceil(h));
  const ctx = canvas.getContext("2d")!;
  return { canvas, ctx };
};

let measureScratch: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | undefined;
const getMeasureCtx = (): CanvasRenderingContext2D => {
  if (measureScratch === undefined) measureScratch = canvas2d(8, 8);
  return measureScratch.ctx;
};

let drawScratch: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | undefined;
const getDrawScratch = (w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } => {
  const cw = Math.max(1, Math.ceil(w));
  const ch = Math.max(1, Math.ceil(h));
  if (drawScratch === undefined) {
    drawScratch = canvas2d(cw, ch);
  } else if (drawScratch.canvas.width !== cw || drawScratch.canvas.height !== ch) {
    drawScratch.canvas.width = cw;
    drawScratch.canvas.height = ch;
  } else {
    drawScratch.ctx.clearRect(0, 0, cw, ch);
  }
  return drawScratch;
};

let sharpScratch: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | undefined;
const getSharpScratch = (w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } => {
  const cw = Math.max(1, Math.ceil(w));
  const ch = Math.max(1, Math.ceil(h));
  if (sharpScratch === undefined) {
    sharpScratch = canvas2d(cw, ch);
  } else if (sharpScratch.canvas.width !== cw || sharpScratch.canvas.height !== ch) {
    sharpScratch.canvas.width = cw;
    sharpScratch.canvas.height = ch;
  } else {
    sharpScratch.ctx.clearRect(0, 0, cw, ch);
  }
  return sharpScratch;
};

let clampScratch: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | undefined;
const scratchClampCanvas = (w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } => {
  const cw = Math.max(1, Math.ceil(w));
  const ch = Math.max(1, Math.ceil(h));
  if (clampScratch === undefined) {
    clampScratch = canvas2d(cw, ch);
  } else if (clampScratch.canvas.width !== cw || clampScratch.canvas.height !== ch) {
    clampScratch.canvas.width = cw;
    clampScratch.canvas.height = ch;
  }
  return clampScratch;
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
    return canvas;
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
  draw.drawImage(sharp.canvas, 0, 0);
  draw.drawImage(sharp.canvas, 0, 0);
  draw.filter = "none";
  return canvas;
};

export const rasterizeTextRun: TextRasterize = async (run, scale, ink) => {
  const canvas = rasterizeTextRunSync(run, scale, ink) as HTMLCanvasElement;
  return createImageBitmap(canvas);
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

const compositeNestedImages = async (
  ctx: CanvasRenderingContext2D,
  svg: string,
  userToPx: { readonly x: number; readonly y: number },
): Promise<void> => {
  const tags = svg.match(IMAGE_TAG) ?? [];
  for (const tag of tags) {
    const href = tagAttr(tag, "href") ?? tagAttr(tag, "xlink:href");
    if (href === undefined || href === "") continue;
    const x = Number(tagAttr(tag, "x") ?? 0);
    const y = Number(tagAttr(tag, "y") ?? 0);
    const w = Number(tagAttr(tag, "width") ?? 0);
    const h = Number(tagAttr(tag, "height") ?? 0);
    if (!Number.isFinite(x + y + w + h) || w <= 0 || h <= 0) continue;
    try {
      const image = await loadImage(href);
      ctx.drawImage(image, x * userToPx.x, y * userToPx.y, w * userToPx.x, h * userToPx.y);
    } catch {
      // A mark that will not decode leaves the badge's plate, as the DOM's broken <img> would.
    }
  }
};

const drawFitted = (
  ctx: CanvasRenderingContext2D,
  image: CanvasImageSource,
  iw: number,
  ih: number,
  fit: "contain" | "cover",
): void => {
  const { width: w, height: h } = ctx.canvas;
  const scale = fit === "cover" ? Math.max(w / iw, h / ih) : Math.min(w / iw, h / ih);
  const dw = iw * scale;
  const dh = ih * scale;
  ctx.drawImage(image, (w - dw) / 2, (h - dh) / 2, dw, dh);
};

/** Synchronous sprite rasterizer for marks and glyphs (zero ImageBitmap allocation). */
export const rasterizeSpriteSync: SpriteRasterizeSync = (quad, mode, scale) => {
  const ref = quad.sprite;
  if (ref === undefined) return undefined;
  if (ref.atlas !== "mark" && ref.atlas !== "glyph") return undefined;
  const w = Math.max(1, Math.ceil(quad.rect.width * scale));
  const h = Math.max(1, Math.ceil(quad.rect.height * scale));
  const { canvas, ctx } = getDrawScratch(w, h);
  if (ref.atlas === "mark") {
    const atlas = markAtlasCanvas(mode);
    if (atlas === undefined) throw new Error("mark atlas unavailable");
    ctx.drawImage(
      atlas,
      ref.cell.col * MARK_CELL, ref.cell.row * MARK_CELL, MARK_CELL, MARK_CELL,
      0, 0, canvas.width, canvas.height,
    );
    return canvas;
  }
  const ink = resolveColour(quad.style.ink, themeFor(mode)) ?? { r: 1, g: 1, b: 1, a: 1 };
  const side = Math.min(canvas.width, canvas.height);
  ctx.save();
  ctx.translate((canvas.width - side) / 2, (canvas.height - side) / 2);
  drawGlyph(ctx, ref.name, side, ink);
  ctx.restore();
  return canvas;
};

export const rasterizeSprite: SpriteRasterize = async (quad, mode, scale) => {
  const ref = quad.sprite;
  if (ref === undefined) throw new Error("rasterizeSprite needs a sprite quad");
  if (ref.atlas === "mark" || ref.atlas === "glyph") {
    const canvas = rasterizeSpriteSync(quad, mode, scale) as HTMLCanvasElement;
    return createImageBitmap(canvas);
  }
  const w = Math.max(1, Math.ceil(quad.rect.width * scale));
  const h = Math.max(1, Math.ceil(quad.rect.height * scale));
  const { canvas, ctx } = canvas2d(w, h);

  if (ref.atlas === "image") {
    const svg = resolveSvgVars(ref.svg, themeFor(mode));
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    try {
      const image = await loadImage(url);
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      await compositeNestedImages(ctx, svg, {
        x: canvas.width / Math.max(1, ref.size.width),
        y: canvas.height / Math.max(1, ref.size.height),
      });
    } finally {
      URL.revokeObjectURL(url);
    }
    return createImageBitmap(canvas);
  }

  // media
  const ground = resolveColour({ token: "shadow-2" }, themeFor(mode));
  if (ground !== undefined) {
    ctx.fillStyle = gpuColorCss(ground);
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  const response = await fetch(ref.ref);
  if (!response.ok) throw new Error(`media fetch ${response.status}`);
  const bitmap = await createImageBitmap(await response.blob());
  try {
    drawFitted(ctx, bitmap, bitmap.width, bitmap.height, ref.fit);
  } finally {
    bitmap.close();
  }
  return createImageBitmap(canvas);
};

export const browserRasterizers = (): Pick<
  GpuAtlasOptions,
  "rasterizeText" | "rasterizeTextSync" | "rasterizeSprite" | "rasterizeSpriteSync"
> => ({
  rasterizeText: rasterizeTextRun,
  rasterizeTextSync: rasterizeTextRunSync,
  rasterizeSprite,
  rasterizeSpriteSync,
});
