/**
 * The GPU atlas binding (docs/canvas-gpu-architecture.md sections 8 and 9;
 * engine/types.ts AtlasBinding; artifact 01M81DHBBYRVN3MKJMR3MMCZ31 v5).
 *
 * Pixels live in independent page textures, one pool for sprites (rgba) and
 * one for text coverage (r8), sized from `device.limits`. A page is split
 * into plots that fill left to right and are wiped whole; an item larger
 * than a page gets a texture of its own. Quads read through a table of rows,
 * one per slot, at a stable index.
 *
 * How it holds together:
 *
 * - A rect has one owner, its slot's `placed` (or `standalone`), from the
 *   moment the pixels land until the slot is freed. A plot lists the slots
 *   placed in it and nothing else says where a cell is: no count, no mark,
 *   no second table.
 * - A placed cell never moves, and a slot never changes key: its pixels are
 *   the same for as long as anything holds it. New content is a new slot.
 * - Until its own pixels land a slot shows another cell's: the same content
 *   at the nearest landed size, or what its quad showed before. It holds one
 *   reference on that cell, which is always a landed cell of its own pool
 *   and never a slot that is itself showing another.
 * - A rect is written a second time in one case. When a slot's pixels land
 *   with the size of the cell it showed, and nothing else holds that cell,
 *   they are written over it and the rect changes owner: a status line that
 *   changes takes no new rect. Key and pixels change together, at the
 *   landing, and a cell anyone else holds is never written.
 * - A row is written by one function from the placement of the cell the slot
 *   shows, texture included. Nothing copies a row.
 * - A slot that has not landed exists only while a quad holds it.
 * - Room is made by wiping the plot used longest ago that holds no
 *   referenced cell; when there is none, a page is added.
 *
 * - A slot whose raster, placement or texture failed is queued again by the
 *   atlas itself when its back-off runs out, on one timer set for the
 *   earliest. A quad asks once and then holds its cell, so nothing else
 *   would try it again. The back-off doubles with each of the slot's
 *   failures and a landing does not start it over: a device says a texture
 *   is not there after the pixels have landed on it, not before.
 *
 * `ensureNow()` rasters synchronously before a frame submits, text is
 * true-ink coverage, and no ImageBitmap is retained.
 *
 * The engine stays DOM-free: every rasterizer is injected. The browser
 * implementations live at the bottom of this file (`browserRasterizers`).
 */

import type { ColorRef, Quad, TextRun } from "../contract";
import { gpuColorCss, themeGpu, type GpuColor, type GpuTheme, type ThemeMode } from "@shared/theme";
import { NO_ATLAS_CELL } from "./quad";
import { ATLAS_CELL_FLOATS, atlasBindBudget, type AtlasBinding, type AtlasDirtyCells, type AtlasAudit, type AtlasAuditViolation, type AtlasTexelAudit, type AtlasTexelMismatch, type AtlasPendingEntry, type AtlasRerasterEntry, type AtlasStats } from "./types";
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
   * `previous` is the index this record held, and its reference is given up:
   * - Same key: returns `previous` (net 0 ref change).
   * - New key: returns another index. Until that cell's own pixels land it
   *   shows the same content at the nearest landed size, or else what
   *   `previous` showed, so nothing flashes blank. A cell's pixels never
   *   change under the quads that hold it.
   * Returns `NO_ATLAS_CELL` only when the quad has nothing to draw.
   */
  acquire(quad: Quad, scale: number, previous?: number): number;
  /**
   * Release one reference to `cell`. At zero references a landed cell stays
   * cached until its plot is wiped for room; a slot whose own pixels have not
   * landed, and a texture of its own, are freed at once.
   */
  release(cell: number): void;
  /** True when `cell` currently points at pixels: its own, or those of the cell it shows until its own land. */
  hasImage(cell: number): boolean;
  /** True when `cell` shows its own landed pixels, not a stand-in's (read-only, for the pop check). */
  ownImage(cell: number): boolean;
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
  /** Bounded diagnostic snapshot of pending (queued/rasterizing) cells. */
  pendingKeys(limit?: number): ReadonlyArray<AtlasPendingEntry>;
  /** The last keys asked for again after their landed cell was freed, oldest first (at most 256). */
  rerasterLog(limit?: number): ReadonlyArray<AtlasRerasterEntry>;
  /**
   * Read-only invariant check over the cell table (the zoom-corruption gate).
   * `held` counts the references draw records hold per cell. Never mutates.
   */
  audit(held?: ReadonlyMap<number, number>): AtlasAudit;
  /**
   * Read back the texels of up to `limit` referenced, landed rgba cells and
   * compare each with a fresh synchronous raster of its own quad at its own
   * scale (the zoom-corruption gate). Read-only; resolves after the GPU copy.
   */
  auditTexels(limit?: number): Promise<AtlasTexelAudit>;
  readonly requests: number;
  readonly pending: number;
  /** Evict unreferenced decoded sources on a real memory-pressure event. */
  notifyMemoryPressure?(): void;
  dispose(): void;
}

type PoolKind = "rgba" | "coverage";
type PageLayout = "grid" | "strip" | "full";

/**
 * Where a plot's next cell goes: at (x, y) in the plot, on a row `rowH` high
 * so far. Cells fill a row from the left and rows fill the plot from the top,
 * so a cursor never goes back over what it passed.
 */
interface Cursor {
  readonly x: number;
  readonly y: number;
  readonly rowH: number;
}

const PLOT_START: Cursor = { x: 0, y: 0, rowH: 0 };
const PAST_RESERVED_TEXEL: Cursor = { x: 1, y: 0, rowH: 1 };

/**
 * The cursor of an empty plot at (x0, y0) of a pool's page `pageIndex`.
 *
 * A row of zeros is still drawn, and reads texel (0,0) of page 0 of its
 * pool, so that texel is reserved: it is no cell's, and stays clear. The
 * plot that holds it starts as it would stand after a 1 by 1 cell with no
 * gutter had been placed there: one texel in, on a row one texel high. This
 * is the only thing that knows the texel. Placement has no case for it: a
 * rect that does not fit beside the texel starts the row below it, as it
 * would below any cell.
 */
const emptyPlotCursor = (pageIndex: number, x0: number, y0: number): Cursor =>
  pageIndex === 0 && x0 === 0 && y0 === 0 ? PAST_RESERVED_TEXEL : PLOT_START;

interface Plot {
  readonly x0: number;
  readonly y0: number;
  readonly w: number;
  readonly h: number;
  cursor: Cursor;
  /** The slots placed here. `place` and `unplace` are its only writers. */
  readonly cells: Set<SlotRecord>;
  lastUsedTick: number;
  /** A cell was placed here since the plot's texels were last cleared. */
  written: boolean;
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
  /** When no quad or waiting slot holds any cell of this page, on `nowMs()`'s clock. */
  unheldSince?: number;
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

type CellState = "queued" | "rasterizing" | "waiting" | "landed" | "failed";

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
  readonly key: string;
  readonly contentKey: string;
  readonly scale: number;
  /** The pool its quads read: text reads coverage pages, a sprite reads rgba pages. */
  readonly pool: PoolKind;
  refCount: number;
  state: CellState;
  /** Its rect on a page, from the landing until the slot is freed. */
  placed?: Placed;
  /** Its own texture, for an item larger than a page. */
  standalone?: StandalonePlaced;
  /** The landed cell whose pixels it shows until its own land. One of that cell's references is this slot's. */
  standIn?: SlotRecord;
  /** The name quads that show `standIn` find it by while it waits (`byShown`). */
  waitName?: string;
  /**
   * Its failures on this device: rasters and placements that failed, and
   * textures found out of memory after it landed on them. A landing does not
   * clear it, because the device answers for a texture only after the
   * landing, and a slot whose pixels stay never fails again. A new device
   * clears it.
   */
  attempts: number;
  /** While failed: when its back-off runs out, on `nowMs()`'s clock. */
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
/** A plot is cleared in bands of rows no larger than this, from one reused buffer of zeros. */
const WIPE_BAND_BYTES = 1 << 20;
const BASE_RETRY_MS = 250;
const MAX_RETRY_MS = 8000;
/** How long a page may hold only unreferenced cache cells before its texture is given back. */
const PAGE_RECLAIM_IDLE_MS = 10_000;

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
  /** key -> the slot every quad that asks the key shares. */
  const byKey = new Map<string, SlotRecord>();
  /**
   * (shown cell, key) -> the slot that waits for `key` while it shows that
   * cell's pixels. What a quad showed before is right only for the quads
   * that show it, so such a slot is shared among them, and by key only once
   * its own pixels land.
   */
  const byShown = new Map<string, SlotRecord>();
  /** key -> every unlanded slot waiting for it, whether it goes by the key or by the pixels one quad showed. */
  const waitingByKey = new Map<string, Set<SlotRecord>>();
  /** contentKey -> its landed slots (the nearest size stands in for a new one). */
  const contentLanded = new Map<string, Set<SlotRecord>>();
  /**
   * The texture a cell is drawn from when its row cannot name it: a page past
   * the bind budget, or a texture of its own. Written with the row, by `storeRow`.
   */
  const standaloneTextures = new Map<number, GPUTexture>();
  let standaloneBytes = 0;
  /** Dirty cell slots since last renderer upload (for partial cells-buffer writes). */
  const dirtyCellSlots = new Set<number>();
  let allCellsDirty = true;
  /** Compat tracking so repeated `sourceFor` calls for the same key don't leak refs. */
  const compatHeld = new Set<string>();

  const queue: number[] = [];
  let queueHead = 0;
  const queuedSet = new Set<number>();
  let drainScheduled = false;
  let inFlightCount = 0;
  const maxInFlight = (() => {
    const cores =
      typeof navigator !== "undefined" && typeof navigator.hardwareConcurrency === "number"
        ? navigator.hardwareConcurrency
        : 4;
    return Math.max(4, Math.max(1, Math.floor(cores / 2)) * 4);
  })();

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

  let wipeZeros: Uint8Array<ArrayBuffer> = new Uint8Array(0);
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
  // Read-only diagnostics: when each evicted key went, and its requests after.
  const evictedAt = new Map<string, number>();
  let rerasters = 0;
  const rerasterLog: AtlasRerasterEntry[] = [];
  const noteEvicted = (key: string, at: number): void => {
    evictedAt.delete(key);
    evictedAt.set(key, at);
    if (evictedAt.size > 8192) evictedAt.delete(evictedAt.keys().next().value!);
  };
  let overwrites = 0;
  let failures = 0;
  let lostPixels = 0;
  let visibleBlank = 0;
  let visibleBlankTotal = 0;

  /** Every contentKey that has landed at least once (for lostPixels rule-6 telemetry). */
  const seenContentKeys = new Set<string>();

  const takeDirtyCells = (): AtlasDirtyCells => {
    // The renderer takes the table inside the frame, before it submits. A
    // cell landed in this frame has only its level 0 so far: its smaller
    // levels are made here, or the frame draws it from whatever the last
    // occupant left in them. The frame is drawn whole for the landing
    // already, so this needs no revision of its own.
    generateDirtyMipmaps();
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

  /**
   * Scissored per-cell GPU mipmap generation: updates only the landed cell's
   * rect per mip level. True when it drew any.
   */
  const generateDirtyMipmaps = (): boolean => {
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
      return false;
    }
    const encoder = device.createCommandEncoder();
    if (typeof encoder.beginRenderPass !== "function") {
      dirtyMipRects.length = 0;
      return false;
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
    return true;
  };

  const flushDirty = (): void => {
    flushScheduled = false;
    if (dirty && !disposed) {
      dirty = false;
      // Levels drawn here change after the frame that read the last revision
      // may have drawn from them; a new revision makes the next frame draw
      // whole, or a frame that redraws only its damage keeps the stale texels.
      if (generateDirtyMipmaps()) revision += 1;
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

  const rowScratch = new Float32Array(ATLAS_CELL_FLOATS);

  /**
   * Store `rowScratch` as the row of `index`, drawn from `texture` when the
   * row cannot name its page. This is the one writer of the cell table and of
   * the side map. The renderer uploads the table only when the revision has
   * moved, so a change marks the row and moves it: a row that changed
   * without that stayed on the GPU as it was, and an index handed to a new
   * key was drawn with the last key's rect. It asks for no frame: a caller
   * outside a frame does that with `markDirty`.
   */
  const storeRow = (index: number, texture: GPUTexture | undefined): void => {
    const base = index * ATLAS_CELL_FLOATS;
    let changed = false;
    for (let i = 0; i < ATLAS_CELL_FLOATS; i += 1) {
      if (cells[base + i] === rowScratch[i]) continue;
      cells[base + i] = rowScratch[i]!;
      changed = true;
    }
    if (texture === undefined) {
      if (standaloneTextures.delete(index)) changed = true;
    } else if (standaloneTextures.get(index) !== texture) {
      standaloneTextures.set(index, texture);
      changed = true;
    }
    if (!changed) return;
    if (!allCellsDirty) dirtyCellSlots.add(index);
    revision += 1;
  };

  /**
   * Fill `rowScratch` with where `owner`'s pixels are, and return the texture
   * to draw them from when the row cannot say. A page past the bind budget is
   * drawn as page 0 with the page's texture bound for that cell, and so is a
   * texture of its own. No owner is a row of zeros, which reads the
   * transparent texel at (0,0) of page 0.
   */
  const locate = (owner: SlotRecord | undefined): GPUTexture | undefined => {
    rowScratch.fill(0);
    const at = owner?.placed;
    if (at !== undefined) {
      const bound = at.page.pageIndex < poolFor(at.pool).bindLimit;
      const dim = at.page.size;
      rowScratch[0] = at.x / dim;
      rowScratch[1] = at.y / dim;
      rowScratch[2] = (at.x + at.w) / dim;
      rowScratch[3] = (at.y + at.h) / dim;
      rowScratch[4] = bound ? at.page.pageIndex : 0;
      return bound ? undefined : at.page.texture;
    }
    const own = owner?.standalone;
    if (own === undefined) return undefined;
    const tiled = own.tilesX * own.tilesY > 1;
    rowScratch[2] = own.w / (own.tilesX * own.tileW);
    rowScratch[3] = own.h / (own.tilesY * own.tileH);
    rowScratch[5] = tiled ? own.tilesX : 0;
    rowScratch[6] = tiled ? own.tilesY : 0;
    return own.texture;
  };

  /** The cell whose pixels `rec`'s quads see: itself once landed, the cell it shows before. */
  const shownBy = (rec: SlotRecord): SlotRecord | undefined => (rec.state === "landed" ? rec : rec.standIn);

  /**
   * Write `rec`'s row from the placement of the cell it shows. A row is never
   * copied from another row: it is derived here, texture included, after
   * every change of what the slot shows.
   */
  const writeRow = (rec: SlotRecord): void => {
    storeRow(rec.index, locate(shownBy(rec)));
  };

  const hasImage = (cell: number): boolean => {
    if (cell === NO_ATLAS_CELL || cell < 0 || cell >= highWaterCells) return false;
    const base = cell * ATLAS_CELL_FLOATS;
    return cells[base + 2]! > cells[base]! || cells[base + 3]! > cells[base + 1]!;
  };

  const ownImage = (cell: number): boolean => {
    if (cell === NO_ATLAS_CELL || cell < 0 || cell >= highWaterCells) return false;
    return slots[cell]?.state === "landed" && hasImage(cell);
  };

  const addContentLanded = (rec: SlotRecord): void => {
    let set = contentLanded.get(rec.contentKey);
    if (set === undefined) {
      set = new Set();
      contentLanded.set(rec.contentKey, set);
    }
    set.add(rec);
  };

  const removeContentLanded = (rec: SlotRecord): void => {
    const set = contentLanded.get(rec.contentKey);
    if (set === undefined) return;
    set.delete(rec);
    if (set.size === 0) contentLanded.delete(rec.contentKey);
  };

  /** The landed cell of `contentKey` nearest `scale`, in the pool the asking quad reads. */
  const findStandIn = (contentKey: string, scale: number, pool: PoolKind): SlotRecord | undefined => {
    const set = contentLanded.get(contentKey);
    if (set === undefined) return undefined;
    let best: SlotRecord | undefined;
    let bestDist = Infinity;
    for (const rec of set) {
      // A quad reads its own pool's pages: the other pool's rect would show
      // whatever sits at that place on this one.
      if (rec.pool !== pool) continue;
      const dist = Math.abs(Math.log2(Math.max(1e-4, rec.scale) / Math.max(1e-4, scale)));
      if (dist < bestDist) {
        bestDist = dist;
        best = rec;
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
    // A dead page's index is free again: only the live pages bind, and the
    // lowest free index keeps every live page inside the bind budget it can fit in.
    const deadIndex = pool.pages.findIndex((page) => page.dead);
    const pageIndex = deadIndex >= 0 ? deadIndex : pool.pages.length;
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
        // Async OOM: this page never came to be. Live pages and later page
        // indices are untouched.
        if (pageRef === undefined || pageRef.dead) return;
        pageRef.dead = true;
        const lost: SlotRecord[] = [];
        for (const plot of pageRef.plots) lost.push(...plot.cells);
        pixelsLost(lost);
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
        dropMipRectsFor(deadTex);
        deadTex.destroy();
        markDirty();
      },
    );
    if (tex === undefined) return undefined;
    clearNewPageMips(tex, mips);

    // A grid page is cut into square plots, a strip page into bands as wide
    // as the page, and a full page is one plot.
    const pSize = plotSizeFor(pool);
    const plotW = layout === "grid" ? pSize : dim;
    const plotH = layout === "full" ? dim : pSize;
    const plots: Plot[] = [];
    for (let y0 = 0; y0 + plotH <= dim; y0 += plotH) {
      for (let x0 = 0; x0 + plotW <= dim; x0 += plotW) {
        plots.push({
          x0,
          y0,
          w: plotW,
          h: plotH,
          cursor: emptyPlotCursor(pageIndex, x0, y0),
          cells: new Set(),
          lastUsedTick: ++plotTick,
          written: false,
        });
      }
    }

    const baseBytes = dim * dim * pool.bytesPerPixel;
    const bytes = mips > 1 ? Math.round(baseBytes * (4 / 3)) : baseBytes;
    const page: Page = { pageIndex, layout, texture: tex, size: dim, bytes, mipCount: mips, plots, dead: false };
    pageRef = page;
    if (deadIndex >= 0) {
      pool.pages[pageIndex] = page;
      pool.pageTextures[pageIndex] = tex;
    } else {
      pool.pages.push(page);
      pool.pageTextures.push(tex);
    }

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

  /**
   * Where a rect of `needW` by `needH`, gutter included, goes from a cursor
   * of `plot`, and the cursor after it: beside what the row holds, or at the
   * start of a row below it. Undefined when the plot has no room from there.
   */
  const roomAt = (
    plot: Plot,
    from: Cursor,
    needW: number,
    needH: number,
  ): { readonly x: number; readonly y: number; readonly next: Cursor } | undefined => {
    if (needW > plot.w || needH > plot.h) return undefined;
    const below = from.x + needW > plot.w;
    const x = below ? 0 : from.x;
    const y = below ? from.y + from.rowH : from.y;
    if (y + needH > plot.h) return undefined;
    return { x, y, next: { x: x + needW, y, rowH: below ? needH : Math.max(from.rowH, needH) } };
  };

  /** The plot would take the rect if it were empty: wiping it makes room. */
  const fitsEmptied = (page: Page, plot: Plot, needW: number, needH: number): boolean =>
    roomAt(plot, emptyPlotCursor(page.pageIndex, plot.x0, plot.y0), needW, needH) !== undefined;

  const tryPlaceInPlot = (pool: PagePool, page: Page, plot: Plot, w: number, h: number): Placed | undefined => {
    const gutter = gutterFor(pool.kind);
    const room = roomAt(plot, plot.cursor, w + gutter, h + gutter);
    if (room === undefined) return undefined;
    plot.cursor = room.next;
    plot.lastUsedTick = ++plotTick;
    plot.written = true;
    return { pool: pool.kind, page, plot, x: plot.x0 + room.x, y: plot.y0 + room.y, w, h };
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

  /**
   * Clear a plot's texels at every level.
   *
   * A cell's own gutter is on its right and below. What is on its left and
   * above is a neighbour's gutter, or space no cell was given, and a linear
   * tap at the cell's edge or one of its smaller levels reads it. A landing
   * writes exactly its own pixels, so whatever a plot's last tenants left
   * would sit in the new tenants' gutters. The plot is cleared once, when it
   * is emptied, and every cell placed in it after that lands on transparent
   * texels.
   */
  const wipePlot = (pool: PagePool, page: Page, plot: Plot): void => {
    if (!plot.written) return;
    plot.written = false;
    if (device === undefined || page.dead) return;
    for (let level = 0; level < page.mipCount; level += 1) {
      const x = plot.x0 >> level;
      const y = plot.y0 >> level;
      const w = Math.max(1, plot.w >> level);
      const h = Math.max(1, plot.h >> level);
      const bytesPerRow = w * pool.bytesPerPixel;
      const bandRows = Math.max(1, Math.min(h, Math.floor(WIPE_BAND_BYTES / bytesPerRow)));
      if (wipeZeros.length < bytesPerRow * bandRows) wipeZeros = new Uint8Array(bytesPerRow * bandRows);
      for (let row = 0; row < h; row += bandRows) {
        const rows = Math.min(bandRows, h - row);
        device.queue.writeTexture(
          { texture: page.texture, origin: { x, y: y + row, z: 0 }, mipLevel: level },
          wipeZeros,
          { bytesPerRow, rowsPerImage: rows },
          { width: w, height: rows, depthOrArrayLayers: 1 },
        );
      }
    }
  };

  /** An emptied plot starts over: its cursor where an empty plot's is, its texels clear. */
  const resetPlot = (pool: PagePool, page: Page, plot: Plot): void => {
    plot.cursor = emptyPlotCursor(page.pageIndex, plot.x0, plot.y0);
    wipePlot(pool, page, plot);
  };

  /**
   * `rec` owns `at` from here until `unplace` or `handOver`. The plot lists
   * the slot, and that with `rec.placed` is the whole record of the rect.
   */
  const place = (rec: SlotRecord, at: Placed): void => {
    rec.placed = at;
    at.plot.cells.add(rec);
    at.plot.lastUsedTick = ++plotTick;
    at.page.unheldSince = undefined;
  };

  /** `rec` gives its rect up. A plot it leaves empty starts over. */
  const unplace = (rec: SlotRecord): void => {
    const at = rec.placed;
    if (at === undefined) return;
    rec.placed = undefined;
    at.plot.cells.delete(rec);
    if (at.plot.cells.size === 0) resetPlot(poolFor(at.pool), at.page, at.plot);
    notePageIdle(at.page);
  };

  /** `to` takes `from`'s rect as it stands. The plot is not emptied on the way, so nothing is wiped. */
  const handOver = (from: SlotRecord, to: SlotRecord): void => {
    const at = from.placed;
    if (at === undefined) return;
    from.placed = undefined;
    at.plot.cells.delete(from);
    place(to, at);
  };

  /**
   * Evict every cell of a plot in one shot (zero fragmentation). The caller
   * has checked that no quad holds one of them. The last cell out resets the
   * plot.
   */
  const evictPlot = (plot: Plot): void => {
    const at = nowMs();
    for (const rec of [...plot.cells]) {
      noteEvicted(rec.key, at);
      freeSlot(rec);
      evictions += 1;
    }
  };

  /**
   * True when a quad, or a slot showing it, holds a cell of this plot. Read
   * from the slots themselves at the moment of eviction: a running count
   * that ran low would wipe a cell on screen.
   */
  const plotIsHeld = (plot: Plot): boolean => {
    for (const rec of plot.cells) {
      if (rec.refCount > 0) return true;
    }
    return false;
  };

  /**
   * Eviction by last use (Skia's plot atlas, WebRender's texture cache): the
   * plot touched longest ago that nothing on screen holds is wiped whole.
   * No cell is kept past that as a floor: content that is off screen leaves
   * when room is needed, and comes back by a raster when it is asked again.
   * Only a plot the rect fits in once it is empty is wiped: the plot that
   * holds the reserved texel has no room for a rect as large as itself.
   */
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
        if (plot.cells.size === 0 || !fitsEmptied(page, plot, needW, needH)) continue;
        if (plot.lastUsedTick >= oldest || plotIsHeld(plot)) continue;
        oldest = plot.lastUsedTick;
        bestPage = page;
        bestPlot = plot;
      }
    }
    if (bestPage === undefined || bestPlot === undefined) return undefined;
    evictPlot(bestPlot);
    return { page: bestPage, plot: bestPlot };
  };

  const freeStandalone = (rec: SlotRecord): void => {
    if (rec.standalone === undefined) return;
    rec.standalone.texture.destroy();
    standaloneBytes = Math.max(0, standaloneBytes - rec.standalone.bytes);
    rec.standalone = undefined;
  };

  /** A landed slot's pixels are gone or going: no new slot may show it. */
  const unland = (rec: SlotRecord): void => {
    if (rec.state !== "landed") return;
    rec.state = "failed";
    landedCount = Math.max(0, landedCount - 1);
    removeContentLanded(rec);
  };

  const trackWaiting = (rec: SlotRecord): void => {
    let set = waitingByKey.get(rec.key);
    if (set === undefined) {
      set = new Set();
      waitingByKey.set(rec.key, set);
    }
    set.add(rec);
  };

  const untrackWaiting = (rec: SlotRecord): void => {
    const set = waitingByKey.get(rec.key);
    if (set === undefined) return;
    set.delete(rec);
    if (set.size === 0) waitingByKey.delete(rec.key);
  };

  /**
   * The one way a slot's index goes back on the free list. Everything that
   * names the slot goes with it: its rect, its own texture, its names, its
   * row and the reference it holds on the cell it showed. A table that kept
   * the index would apply what it says to the next key the index is given
   * to: a plot that still listed it freed that key's slot while a quad held
   * it.
   */
  const freeSlot = (rec: SlotRecord): void => {
    const index = rec.index;
    if (slots[index] !== rec) return;
    slots[index] = undefined;
    untrackWaiting(rec);
    unland(rec);
    unplace(rec);
    freeStandalone(rec);
    queuedSet.delete(index);
    if (byKey.get(rec.key) === rec) {
      byKey.delete(rec.key);
      compatHeld.delete(rec.key);
    }
    if (rec.waitName !== undefined && byShown.get(rec.waitName) === rec) byShown.delete(rec.waitName);
    rec.waitName = undefined;
    const shown = rec.standIn;
    rec.standIn = undefined;
    rec.refCount = 0;
    rec.desc = undefined;
    rowScratch.fill(0);
    storeRow(index, undefined);
    freeIndices.push(index);
    if (shown !== undefined) release(shown.index);
  };

  const alloc = (pool: PagePool, w: number, h: number): Placed | undefined => {
    const gutter = gutterFor(pool.kind);
    const needW = w + gutter;
    const needH = h + gutter;
    const layout = layoutFor(pool, needW, needH);

    // Try existing pages of the matching layout first (lazy pool init: allocates on first use).
    let at = tryPlaceOnPages(pool, w, h, layout);
    if (at !== undefined) return at;

    // Reclaim the least-recently-used plot that nothing on screen holds, in one shot.
    const reclaimed = evictLruUnpinnedPlot(pool, needW, needH, layout);
    if (reclaimed !== undefined) {
      at = tryPlaceInPlot(pool, reclaimed.page, reclaimed.plot, w, h);
      if (at !== undefined) return at;
    }

    // Every plot the rect fits in holds a cell that is on screen: add a new
    // independent page. A cell is never moved once it is placed. Moving one
    // took a GPU copy inside one texture, which WebGPU rejects whatever the
    // rects are, and the rejected encoder dropped every copy in it while the
    // rows were already pointed at the new rects.
    //
    // The new page's first plot takes the rect, unless it is the plot of the
    // reserved texel and the rect is as large as a plot. Then the next plot
    // does, or, when page 0 is a single plot, the page after it.
    for (let added = 0; added < 2; added += 1) {
      const nextPage = addPage(pool, layout);
      if (nextPage === undefined) return undefined;
      for (const plot of nextPage.plots) {
        at = tryPlaceInPlot(pool, nextPage, plot, w, h);
        if (at !== undefined) return at;
      }
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
    // Exactly the raster's own pixels. The gutter is the plot's cleared
    // texels; past its cell, a scratch canvas holds whatever a larger raster
    // left there, and copying that margin put it in the gutter for the
    // smaller levels to average into the cell's edge.
    device!.queue.copyExternalImageToTexture(
      { source: imgSource },
      { texture: at.page.texture, origin: { x: at.x, y: at.y, z: 0 } },
      { width: w, height: h },
    );
    if (at.page.mipCount > 1) {
      dirtyMipRects.push({ texture: at.page.texture, mipCount: at.page.mipCount, x: at.x, y: at.y, w, h, gutter });
    }
  };

  /**
   * Give `rec` a texture of its own, for an item larger than a packing page,
   * at full on-screen resolution:
   * - Text uses `r8unorm` (1 byte/px); sprites use `rgba8unorm` (4 bytes/px).
   * - Up to `maxTexDim` per side: one layer sized to `(w, h)`.
   * - Beyond `maxTexDim`: a tiled `2d-array` texture of `tilesX * tilesY` layers.
   */
  const landOwnTexture = (pool: PagePool, rec: SlotRecord, pixels: AtlasPixels, w: number, h: number): boolean => {
    const tilesX = Math.max(1, Math.ceil(w / maxTexDim));
    const tilesY = Math.max(1, Math.ceil(h / maxTexDim));
    const layers = tilesX * tilesY;
    if (layers > maxArrayLayers) {
      reportFailure(`tiled item ${w}x${h} needs ${layers} layers (limit ${maxArrayLayers})`);
      return false;
    }
    const tileW = tilesX === 1 ? w : Math.min(w, maxTexDim);
    const tileH = tilesY === 1 ? h : Math.min(h, maxTexDim);
    const tex = createTexture2DArray(device!, tileW, tileH, layers, pool.format, pool.usage, 1, (deadTex) => {
      // Async OOM: the texture never came to be. A slot that has let it go
      // already destroyed it.
      if (slots[rec.index] === rec && rec.standalone?.texture === deadTex) pixelsLost([rec]);
    });
    if (tex === undefined) return false;

    try {
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
    } catch (error) {
      // The slot owns nothing until the upload is whole.
      tex.destroy();
      throw error;
    }

    const bytes = tileW * tileH * layers * pool.bytesPerPixel;
    rec.standalone = { texture: tex, w, h, tileW, tileH, tilesX, tilesY, bytes };
    standaloneBytes += bytes;
    return true;
  };

  // --- References and stand-ins -------------------------------------------------

  /** One more holder of `rec`: a quad, or a slot that shows it. Its plot counts as used. */
  const hold = (rec: SlotRecord): void => {
    rec.refCount += 1;
    if (rec.placed !== undefined) {
      rec.placed.plot.lastUsedTick = ++plotTick;
      rec.placed.page.unheldSince = undefined;
    }
  };

  /**
   * `rec` shows `target`'s pixels until its own land, and holds a reference
   * on it for as long. `target` is a landed cell of `rec`'s own pool. A slot
   * that itself shows another cell is never shown through: it lets that cell
   * go when it lands, and the rect is then free to be wiped under whoever
   * still read it.
   */
  const showThrough = (rec: SlotRecord, target: SlotRecord): void => {
    hold(target);
    rec.standIn = target;
    writeRow(rec);
    markDirty();
  };

  /** The name the slot waiting for `key` goes by among the quads that show `shown`. */
  const shownName = (shown: SlotRecord, key: string): string => `${shown.index}\u0000${key}`;

  /** A slot no longer waits on what a quad showed: it goes by its key, if no slot has it. */
  const goByKey = (rec: SlotRecord): void => {
    if (rec.waitName !== undefined) {
      if (byShown.get(rec.waitName) === rec) byShown.delete(rec.waitName);
      rec.waitName = undefined;
    }
    if (!byKey.has(rec.key)) byKey.set(rec.key, rec);
  };

  // --- Failure and retry --------------------------------------------------------

  /**
   * The atlas's one timer, set for the earliest back-off to run out. It is
   * the only way from failed back to the queue: a quad asks once and then
   * holds its cell, so a slot that fails while held is tried again by nobody
   * else, and its quad would draw the last scale's pixels, or nothing, until
   * the next repaint or zoom step.
   */
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  /** When `retryTimer` fires, on `nowMs()`'s clock. Infinity while it is not set. */
  let retryAt = Number.POSITIVE_INFINITY;

  const stopRetryTimer = (): void => {
    if (retryTimer !== undefined) clearTimeout(retryTimer);
    retryTimer = undefined;
    retryAt = Number.POSITIVE_INFINITY;
  };

  /** The timer fires no later than `at`. */
  const retryBy = (at: number): void => {
    if (disposed || at >= retryAt) return;
    stopRetryTimer();
    retryAt = at;
    retryTimer = setTimeout(retryDue, Math.max(0, Math.ceil(at - nowMs())));
  };

  /** The one timer for giving idle page memory back. */
  let pageReclaimTimer: ReturnType<typeof setTimeout> | undefined;
  let pageReclaimAt = Number.POSITIVE_INFINITY;

  const stopPageReclaimTimer = (): void => {
    if (pageReclaimTimer !== undefined) clearTimeout(pageReclaimTimer);
    pageReclaimTimer = undefined;
    pageReclaimAt = Number.POSITIVE_INFINITY;
  };

  const pageReclaimBy = (at: number): void => {
    if (disposed || at >= pageReclaimAt) return;
    stopPageReclaimTimer();
    pageReclaimAt = at;
    pageReclaimTimer = setTimeout(reclaimPagesDue, Math.max(0, Math.ceil(at - nowMs())));
  };

  /** True when nothing on screen, and nothing waiting to land for it, holds any cell of `page`. */
  const pageIsUnheld = (page: Page): boolean => {
    for (const plot of page.plots) {
      for (const rec of plot.cells) {
        if (rec.refCount > 0) return false;
      }
    }
    return true;
  };

  /** Start `page`'s idle clock when its last holder has gone; a new cell or holder clears it. */
  const notePageIdle = (page: Page): void => {
    if (page.dead || page.unheldSince !== undefined || !pageIsUnheld(page)) return;
    page.unheldSince = nowMs();
    pageReclaimBy(page.unheldSince + PAGE_RECLAIM_IDLE_MS);
  };

  /** A page nobody has used for the idle span is cache, not working memory: its cells go and its texture is destroyed. Its index stays for P3 to reuse. */
  const reclaimPage = (pool: PagePool, page: Page): void => {
    if (page.dead || !pageIsUnheld(page)) {
      page.unheldSince = undefined;
      return;
    }
    // Mark it dead first: the plots reset without wiping a texture that is going away.
    page.dead = true;
    page.unheldSince = undefined;
    for (const plot of page.plots) {
      for (const rec of [...plot.cells]) freeSlot(rec);
    }
    dropMipRectsFor(page.texture);
    page.texture.destroy();
    const fallback = pool.kind === "rgba" ? dummyRgbaTex : dummyCovTex;
    if (fallback !== undefined && page.pageIndex < pool.pageTextures.length) pool.pageTextures[page.pageIndex] = fallback;
    if (page.pageIndex === 0 && fallback !== undefined) {
      if (pool.kind === "rgba") mutable.texture = fallback;
      else mutable.coverageTexture = fallback;
    }
    if (page.pageIndex < pool.bindLimit) {
      textureGeneration += 1;
      mutable.textureGeneration = textureGeneration;
    }
    markDirty();
  };

  const reclaimPagesDue = (): void => {
    pageReclaimTimer = undefined;
    pageReclaimAt = Number.POSITIVE_INFINITY;
    if (disposed) return;
    const now = nowMs();
    let next = Number.POSITIVE_INFINITY;
    for (const pool of [rgbaPool, coveragePool]) {
      for (const page of pool.pages) {
        if (page.dead) continue;
        if (!pageIsUnheld(page)) {
          page.unheldSince = undefined;
          continue;
        }
        if (page.unheldSince === undefined) {
          page.unheldSince = now;
          next = Math.min(next, now + PAGE_RECLAIM_IDLE_MS);
        } else if (page.unheldSince + PAGE_RECLAIM_IDLE_MS <= now) {
          reclaimPage(pool, page);
        } else {
          next = Math.min(next, page.unheldSince + PAGE_RECLAIM_IDLE_MS);
        }
      }
    }
    pageReclaimBy(next);
  };

  /**
   * Every failed slot whose back-off has run out goes back in the queue, and
   * the timer is set for the earliest of the rest. A landing from here is a
   * landing like any other: it writes its row and marks the atlas dirty.
   */
  const retryDue = (): void => {
    retryTimer = undefined;
    retryAt = Number.POSITIVE_INFINITY;
    if (disposed) return;
    const now = nowMs();
    let next = Number.POSITIVE_INFINITY;
    for (let i = 0; i < highWaterCells; i += 1) {
      const rec = slots[i];
      if (rec === undefined || rec.state !== "failed") continue;
      if (rec.retryAfter > now) {
        next = Math.min(next, rec.retryAfter);
      } else {
        rec.state = "queued";
        enqueue(rec.index);
      }
    }
    retryBy(next);
  };

  /**
   * `rec` has no pixels of its own and no raster on the way: its raster or
   * its placement failed, or the texture it landed on never came to be. It
   * is failed, and the timer queues it again after a wait that doubles with
   * each of its failures, from BASE_RETRY_MS to MAX_RETRY_MS. The one way a
   * slot that stays is left failed. A landed slot has nothing to retry.
   */
  const backOff = (rec: SlotRecord): void => {
    if (rec.state === "landed") return;
    rec.state = "failed";
    rec.retryAfter = nowMs() + Math.min(MAX_RETRY_MS, BASE_RETRY_MS * 2 ** Math.min(6, rec.attempts));
    rec.attempts += 1;
    retryBy(rec.retryAfter);
  };

  /** A page texture that is gone takes its pending mip passes with it: no pass may begin on it after destroy. */
  const dropMipRectsFor = (texture: GPUTexture): void => {
    for (let i = dirtyMipRects.length - 1; i >= 0; i -= 1) {
      if (dirtyMipRects[i]!.texture === texture) dirtyMipRects.splice(i, 1);
    }
  };

  /**
   * The texture under these cells never came to be: an allocation found out
   * of memory after the cells had landed on it. They have no pixels, and
   * neither have the slots that showed them. Each is rastered again when its
   * back-off runs out if a quad still holds it, and is freed if not.
   */
  const pixelsLost = (lost: ReadonlyArray<SlotRecord>): void => {
    for (const rec of lost) {
      unplace(rec);
      freeStandalone(rec);
      unland(rec);
    }
    // Every slot that showed one of them shows nothing from here, and lets it go.
    for (let i = 0; i < highWaterCells; i += 1) {
      const rec = slots[i];
      const shown = rec?.standIn;
      if (rec === undefined || shown === undefined || shown.state === "landed") continue;
      rec.standIn = undefined;
      shown.refCount = Math.max(0, shown.refCount - 1);
      goByKey(rec);
      writeRow(rec);
      if (rec.state === "waiting") backOff(rec);
    }
    for (const rec of lost) {
      if (rec.refCount > 0) {
        // Soon the first time: the memory may be back. Later each time it is
        // not, since the landing that came between left the count alone.
        backOff(rec);
        writeRow(rec);
      } else {
        freeSlot(rec);
      }
    }
    markDirty();
  };

  /**
   * The cell `rec` shows, when `rec`'s pixels may be written over it: a rect
   * of exactly their size that nothing holds but `rec`. Its quads asked for
   * the new pixels and nobody else is looking, so the rect is `rec`'s to
   * take. A cell that a quad or another waiting slot holds is never written.
   */
  const rectToWriteOver = (rec: SlotRecord, w: number, h: number): SlotRecord | undefined => {
    const shown = rec.standIn;
    const at = shown?.placed;
    if (shown === undefined || at === undefined || shown.refCount !== 1) return undefined;
    return at.w === w && at.h === h && !at.page.dead ? shown : undefined;
  };

  /**
   * `winner` has the key's pixels. Every other slot still waiting for the
   * same key stops its own raster and shows them. The slots stay, because
   * their indices are already in the quads' hands; the duplicate rasters and
   * cells do not.
   */
  const dedupeWaiting = (winner: SlotRecord): void => {
    const waiting = waitingByKey.get(winner.key);
    if (waiting === undefined) return;
    for (const rec of [...waiting]) {
      if (rec === winner || slots[rec.index] !== rec || rec.state === "landed") continue;
      queuedSet.delete(rec.index);
      // A raster already in flight answers to a token that is no longer this slot's.
      rec.jobToken = ++nextJobToken;
      const old = rec.standIn;
      if (old !== winner) {
        rec.standIn = undefined;
        if (old !== undefined) release(old.index);
      }
      rec.state = "waiting";
      if (old === winner) {
        writeRow(rec);
        markDirty();
      } else {
        showThrough(rec, winner);
      }
    }
  };

  /**
   * `rec`'s own pixels arrive. They go over the cell it showed when that
   * rect is its to take, else to a rect no cell has, or to a texture of its
   * own. From here the slot shows them: it lets go of the cell it showed, and
   * any quad that asks its key may share it.
   */
  const landPixels = (rec: SlotRecord, pixels: AtlasPixels): boolean => {
    if (disposed || device === undefined || slots[rec.index] !== rec || rec.state === "landed") return false;
    const pool = poolFor(rec.pool);
    const w = Math.max(1, pixels.width);
    const h = Math.max(1, pixels.height);
    const gutter = gutterFor(pool.kind);

    let written: SlotRecord | undefined;
    if (w + gutter > pool.pageSize || h + gutter > pool.pageSize) {
      // Only items larger than a page get a texture of their own.
      if (!landOwnTexture(pool, rec, pixels, w, h)) {
        backOff(rec);
        return false;
      }
    } else {
      written = rectToWriteOver(rec, w, h);
      if (written !== undefined) {
        // The copy first: if it throws, the old cell still has its rect and its pixels.
        copyPixels(pool, pixels, written.placed!);
        handOver(written, rec);
        overwrites += 1;
      } else {
        const at = alloc(pool, w, h);
        if (at === undefined) {
          reportFailure(`atlas alloc failed for ${w}x${h} (key=${rec.key})`);
          backOff(rec);
          return false;
        }
        place(rec, at);
        try {
          copyPixels(pool, pixels, at);
        } catch (error) {
          unplace(rec);
          throw error;
        }
      }
    }

    rec.state = "landed";
    // `attempts` stays: the device has not answered for a new texture yet,
    // and if the answer is out of memory the pixels are taken back.
    rec.retryAfter = 0;
    landedCount += 1;
    addContentLanded(rec);
    seenContentKeys.add(rec.contentKey);
    const shown = rec.standIn;
    rec.standIn = undefined;
    goByKey(rec);
    untrackWaiting(rec);
    writeRow(rec);
    dedupeWaiting(rec);
    // The cell it showed: gone with its rect when that was written over, else let go.
    if (written !== undefined) freeSlot(written);
    else if (shown !== undefined) release(shown.index);
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

  /** There are frames to stay out of the way of: a browser or Electron, not a bare test. */
  const hasFrames = (): boolean => typeof requestAnimationFrame === "function";

  const scheduleDrain = (): void => {
    if (drainScheduled || disposed || device === undefined) return;
    drainScheduled = true;
    // In a browser/Electron, run background rasterization in an unclamped macrotask
    // AFTER the current rAF frame presents (queueMicrotask runs inside FireAnimationFrame).
    if (hasFrames()) {
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
        backOff(rec);
        reportFailure(`atlas sync raster failed (${rec.key}): ${String(error)}`);
        return;
      }
    }

    inFlightCount += 1;
    void rasterizeAsync(desc)
      .then((pixels) => {
        try {
          // A slot let go while its raster was in flight is freed already,
          // and its index may be another key's by now: the raster is dropped.
          if (disposed || rec.jobToken !== token || slots[rec.index] !== rec) return;
          landPixels(rec, pixels);
        } finally {
          closePixels(pixels);
        }
      })
      .catch((error) => {
        if (disposed || rec.jobToken !== token || slots[rec.index] !== rec) return;
        reportFailure(`atlas raster failed (${rec.key}): ${String(error)}`);
        backOff(rec);
      })
      .finally(() => {
        inFlightCount = Math.max(0, inFlightCount - 1);
        if (queueHead < queue.length && !disposed) scheduleDrain();
      });
  };

  const drainQueue = (): void => {
    drainScheduled = false;
    if (disposed || device === undefined) return;
    sampleFrameInterval();
    const start = nowMs();
    const budget = drainYieldMs();
    while (queueHead < queue.length) {
      if (options.preferAsyncRaster && inFlightCount >= maxInFlight) {
        // Workers are saturated: wait for a completion to pump the next batch
        // so released items stay cheaply cancellable in `queue`.
        return;
      }
      const idx = queue[queueHead++]!;
      if (queueHead >= 1024 && queueHead * 2 >= queue.length) {
        queue.splice(0, queueHead);
        queueHead = 0;
      }
      queuedSet.delete(idx);
      const rec = slots[idx];
      // A slot let go while it waited is freed already: the index is empty,
      // or another key's.
      if (rec === undefined || rec.state !== "queued") continue;
      runJob(rec);
      // Yield between chunks during large bursts so input/frames never stall.
      // Where there are no frames there is nothing to yield to, and the
      // queue drains whole: the macrotask it would go on in is one a test
      // that turns microtasks never reaches, so a single slow drain on a
      // loaded machine stopped the queue for the rest of the run.
      if (hasFrames() && queueHead < queue.length && nowMs() - start >= budget) {
        drainScheduled = true;
        scheduleMacrotask(drainQueue);
        return;
      }
    }
    if (queueHead > 0) {
      queue.length = 0;
      queueHead = 0;
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
    // A landed cell that a quad can ask for by key stays, unreferenced, until
    // its plot is wiped for room. Everything else goes now: a slot that has
    // not landed has nobody left to land for, a texture of its own is too
    // large to keep off screen, and a landed cell no key finds is no cache.
    if (rec.state === "landed" && rec.standalone === undefined && byKey.get(rec.key) === rec) {
      rec.desc = undefined;
      if (rec.placed !== undefined) notePageIdle(rec.placed.page);
      return;
    }
    const hadOwnTexture = rec.standalone !== undefined;
    if (rec.state === "landed") {
      evictions += 1;
      // Only the slot its key finds: the others are a burst's unnamed landings, and the key's cell may still be cached.
      if (byKey.get(rec.key) === rec) noteEvicted(rec.key, nowMs());
    }
    freeSlot(rec);
    if (hadOwnTexture) markDirty();
  };

  /** A free row index: a recycled one, or the next of the table. */
  const takeIndex = (): number | undefined => {
    const recycled = freeIndices.pop();
    if (recycled !== undefined) return recycled;
    const index = highWaterCells;
    if (!ensureCellCapacity(index + 1)) return undefined;
    highWaterCells = index + 1;
    mutable.cellCount = highWaterCells;
    return index;
  };

  const acquire = (quad: Quad, scale: number, previous?: number): number => {
    const held = previous !== undefined && previous !== NO_ATLAS_CELL ? slots[previous] : undefined;
    const prev = held !== undefined && held.refCount > 0 ? held : undefined;
    const keys = keysFor(quad, scale);
    if (keys === undefined) {
      if (prev !== undefined) release(prev.index);
      return NO_ATLAS_CELL;
    }
    const desc: CellDesc = { quad, scale, mode, kind: keys.kind };

    // Same key: the caller keeps its slot, with net zero ref change. A failed
    // slot is not queued for being asked again: the retry timer does that.
    if (prev !== undefined && prev.key === keys.key) return prev.index;

    // The pixels the caller's quad shows now, if a quad of this kind can go
    // on showing them. A cell of the other pool cannot: the quad reads its
    // own kind's pages, and that rect holds something else there.
    const pool = poolKindOf(keys.kind);
    const shown = prev === undefined ? undefined : shownBy(prev);
    const keep = shown !== undefined && shown.pool === pool ? shown : undefined;

    // The key's slot is every asker's when what it shows is right for every
    // asker: the key's own pixels, or the same content at another size. One
    // that shows nothing yet is right only for a caller with nothing to go on
    // showing. A caller with pixels to keep shares the slot that waits for
    // this key behind those very pixels.
    const open = byKey.get(keys.key);
    const shared =
      open !== undefined && (open.state === "landed" || open.standIn !== undefined || keep === undefined)
        ? open
        : keep !== undefined
          ? byShown.get(shownName(keep, keys.key))
          : undefined;
    if (shared !== undefined) {
      hold(shared);
      shared.desc = desc;
      if (prev !== undefined) release(prev.index);
      return shared.index;
    }

    const index = takeIndex();
    if (index === undefined) {
      if (prev !== undefined) release(prev.index);
      return NO_ATLAS_CELL;
    }
    const rec: SlotRecord = {
      index,
      key: keys.key,
      contentKey: keys.contentKey,
      scale,
      pool,
      refCount: 1,
      state: "queued",
      attempts: 0,
      retryAfter: 0,
      desc,
      jobToken: 0,
    };
    slots[index] = rec;
    trackWaiting(rec);
    requests += 1;
    const wentAt = evictedAt.get(keys.key);
    if (wentAt !== undefined) {
      evictedAt.delete(keys.key);
      rerasters += 1;
      rerasterLog.push({ key: keys.key, evictedAt: wentAt, at: nowMs() });
      if (rerasterLog.length > 256) rerasterLog.shift();
    }

    // Never flash blank. The same content at the nearest landed size is what
    // any asker of the key may see, so that slot goes by its key. What this
    // caller's quad shows now is some other content: only the quads showing
    // it may see it under this key, so that slot goes by those pixels' name
    // until its own land. A slot's pixels never change, so the caller's last
    // cell is shown through, not written over.
    const sameContent = open === undefined ? findStandIn(keys.contentKey, scale, pool) : undefined;
    if (open === undefined && (sameContent !== undefined || keep === undefined)) {
      byKey.set(keys.key, rec);
      if (sameContent !== undefined) showThrough(rec, sameContent);
    } else if (keep !== undefined) {
      rec.waitName = shownName(keep, keys.key);
      byShown.set(rec.waitName, rec);
      showThrough(rec, keep);
    }
    // After the new slot took its own reference on what `previous` showed.
    if (prev !== undefined) release(prev.index);

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
      backOff(rec);
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
      const rec = byKey.get(keys.key);
      if (rec !== undefined) return rec.index;
      compatHeld.delete(keys.key);
    }
    const idx = acquire(quad, scale);
    if (idx !== NO_ATLAS_CELL) compatHeld.add(keys.key);
    return idx;
  };

  const stats = (): AtlasStats => {
    let activeCells = 0;
    let pinnedCells = 0;
    let failedCells = 0;
    for (let i = 0; i < highWaterCells; i += 1) {
      const rec = slots[i];
      if (rec === undefined) continue;
      activeCells += 1;
      if (rec.refCount > 0) pinnedCells += 1;
      if (rec.state === "failed") failedCells += 1;
    }
    let pageBytes = 0;
    for (const p of rgbaPool.pages) if (!p.dead) pageBytes += p.bytes;
    for (const p of coveragePool.pages) if (!p.dead) pageBytes += p.bytes;
    return {
      requests,
      pending: queuedSet.size + inFlightCount,
      landed: landedCount,
      evictions,
      rerasters,
      overwrites,
      failures,
      failedCells,
      pages: rgbaPool.pages.filter((p) => !p.dead).length + coveragePool.pages.filter((p) => !p.dead).length,
      pageSize,
      bytesInUse: pageBytes + standaloneBytes,
      activeCells,
      pinnedCells,
      standaloneCount: standaloneTextures.size,
      decodedSourceBytes: decodedSvgBytes + decodedMediaBytes,
      decodedSvgCount: decodedSvgs.size,
      // No cell is kept past eviction as a floor; the fields stay so proof files keep their shape.
      floorBytes: 0,
      floorCells: 0,
      // A cell is never moved once placed; the field stays so proof files keep their shape.
      compactions: 0,
      lostPixels,
      visibleBlank,
      visibleBlankTotal,
    };
  };

  /**
   * The structure, checked. Every row is the placement of the cell its slot
   * shows, texture included. A slot is landed exactly when it owns pixels,
   * and exists unlanded only while held. What a slot shows meanwhile is a
   * referenced, landed cell of its own pool. A plot lists exactly the slots
   * placed in it, no two rects share texels or a gutter, no rect is on the
   * reserved texel an empty row reads, every name finds its slot, and the
   * retry timer is set to fire by the back-off of every failed slot. `held`
   * counts the references draw records hold per cell.
   */
  const audit = (held?: ReadonlyMap<number, number>): AtlasAudit => {
    const counts: Record<string, number> = {};
    const samples: AtlasAuditViolation[] = [];
    const flag = (kind: string, cell: number, detail: string): void => {
      counts[kind] = (counts[kind] ?? 0) + 1;
      if (samples.length < 40) samples.push({ kind, cell, key: slots[cell]?.key ?? null, detail });
    };
    const rowOf = (i: number): number[] => Array.from(cells.subarray(i * ATLAS_CELL_FLOATS, i * ATLAS_CELL_FLOATS + ATLAS_CELL_FLOATS));
    const fmt = (a: ArrayLike<number> | undefined): string =>
      a === undefined ? "none" : Array.from(a).slice(0, 7).map((v) => Number(v.toFixed(5))).join(",");
    const showers = new Map<SlotRecord, number>();
    let checked = 0;
    for (let i = 0; i < highWaterCells; i += 1) {
      const rec = slots[i];
      const row = rowOf(i);
      if (rec === undefined) {
        if (row.some((v) => v !== 0) || standaloneTextures.has(i)) flag("free-slot-has-row", i, `row ${fmt(row)}`);
        continue;
      }
      checked += 1;
      const landed = rec.state === "landed";
      const owns = rec.placed !== undefined || rec.standalone !== undefined;
      if (landed !== owns) flag("landed-and-pixels-disagree", i, `state ${rec.state}, ${owns ? "owns pixels" : "owns none"}`);
      if (!landed && rec.refCount <= 0) flag("unlanded-slot-unheld", i, `state ${rec.state}, refCount ${rec.refCount}`);
      if (rec.state === "failed" && !(retryAt <= rec.retryAfter)) {
        flag("failed-slot-not-retried", i, `failed ${rec.attempts} times and ${retryTimer === undefined ? "no retry timer is set" : "the retry timer fires after its back-off"}`);
      }
      if (rec.placed !== undefined) {
        const at = rec.placed;
        if (at.page.dead) flag("placed-on-dead-page", i, `page ${at.page.pageIndex}`);
        if (!at.plot.cells.has(rec)) flag("plot-missing-cell", i, `plot ${at.plot.x0},${at.plot.y0} page ${at.page.pageIndex}`);
        if (at.pool !== rec.pool) flag("placed-in-other-pool", i, `a ${rec.pool} slot on a ${at.pool} page`);
      }
      const target = rec.standIn;
      if (target !== undefined) {
        showers.set(target, (showers.get(target) ?? 0) + 1);
        if (landed) flag("landed-slot-stands-in", i, `on ${target.index}`);
        if (slots[target.index] !== target) {
          flag("alias-target-freed", i, `stands in on ${target.index}, a freed slot; row ${fmt(row)}`);
          continue;
        }
        if (target.refCount <= 0) flag("alias-target-unreferenced", i, `stands in on ${target.index}, refCount ${target.refCount}`);
        if (target.state !== "landed" || target.standIn !== undefined) {
          flag("alias-of-alias", i, `stands in on ${target.index}, which has no pixels of its own (state ${target.state})`);
        }
        if (target.pool !== rec.pool) flag("alias-other-pool", i, `a ${rec.pool} slot stands in on ${target.index}, a ${target.pool} cell`);
      }
      if (rec.waitName !== undefined && (target === undefined || byShown.get(rec.waitName) !== rec)) {
        flag("wait-name-stale", i, `waits as ${JSON.stringify(rec.waitName)}${target === undefined ? " and shows no cell" : ""}`);
      }
      const texture = locate(shownBy(rec));
      const of = landed ? "own" : target !== undefined ? "alias" : "none";
      if (!row.every((v, k) => v === rowScratch[k])) {
        const kind = of === "own" ? "row-not-own" : of === "alias" ? "alias-row-stale" : "row-without-pixels";
        flag(kind, i, `row ${fmt(row)} for ${fmt(rowScratch)} state ${rec.state}${target !== undefined ? ` showing ${target.index} (${target.key})` : ""}`);
      }
      if (standaloneTextures.get(i) !== texture) {
        const kind = of === "own" ? "texture-not-own" : of === "alias" ? "alias-texture-stale" : "texture-without-pixels";
        flag(kind, i, `drawn from another texture than the cell it shows, state ${rec.state}`);
      }
    }
    for (const [key, rec] of byKey) {
      if (slots[rec.index] !== rec || rec.key !== key) flag("key-finds-wrong-slot", rec.index, `key ${key}`);
    }
    for (const [name, rec] of byShown) {
      if (slots[rec.index] !== rec || rec.waitName !== name) flag("wait-name-finds-wrong-slot", rec.index, `name ${JSON.stringify(name)}`);
    }
    // Overlap and plot bookkeeping, per pool page. A rect's gutter, on its
    // right and below, is its own too.
    for (const pool of [rgbaPool, coveragePool]) {
      const gutter = gutterFor(pool.kind);
      for (const page of pool.pages) {
        if (page.dead) continue;
        const rects: Array<{ i: number; x: number; y: number; w: number; h: number }> = [];
        for (const plot of page.plots) {
          for (const rec of plot.cells) {
            if (slots[rec.index] !== rec) {
              flag("plot-holds-free-slot", rec.index, `plot ${plot.x0},${plot.y0} page ${page.pageIndex} ${pool.kind}`);
              continue;
            }
            if (rec.placed === undefined || rec.placed.plot !== plot) {
              flag("plot-cell-placed-elsewhere", rec.index, `plot ${plot.x0},${plot.y0} page ${page.pageIndex}`);
              continue;
            }
            rects.push({ i: rec.index, x: rec.placed.x, y: rec.placed.y, w: rec.placed.w, h: rec.placed.h });
            if (page.pageIndex === 0 && rec.placed.x === 0 && rec.placed.y === 0) {
              flag("cell-on-reserved-texel", rec.index, `${pool.kind} page 0: cell ${rec.index} ${rec.placed.w}x${rec.placed.h} is placed on texel 0,0, which every empty row reads`);
            }
          }
        }
        rects.sort((a, b) => a.x - b.x);
        for (let a = 0; a < rects.length; a += 1) {
          const ra = rects[a]!;
          for (let b = a + 1; b < rects.length && rects[b]!.x < ra.x + ra.w + gutter; b += 1) {
            const rb = rects[b]!;
            if (rb.y < ra.y + ra.h + gutter && ra.y < rb.y + rb.h + gutter) {
              flag("rects-overlap", ra.i, `${pool.kind} page ${page.pageIndex}: cell ${ra.i} ${ra.x},${ra.y} ${ra.w}x${ra.h} and cell ${rb.i} ${rb.x},${rb.y} ${rb.w}x${rb.h} are closer than the ${gutter} px gutter`);
            }
          }
        }
      }
    }
    // References the draw records hold.
    let heldCells = 0;
    if (held !== undefined) {
      for (const [cell, n] of held) {
        heldCells += 1;
        const rec = slots[cell];
        if (rec === undefined) {
          flag("held-cell-freed", cell, `${n} quad(s) hold a free slot; row ${fmt(cell < highWaterCells ? rowOf(cell) : undefined)}`);
          continue;
        }
        const fromSlots = showers.get(rec) ?? 0;
        if (rec.refCount - fromSlots < n) flag("held-cell-underreferenced", cell, `${n} quad(s) hold it, refCount ${rec.refCount} (${fromSlots} from slots showing it)`);
      }
    }
    return { checked, heldCells, counts, samples };
  };

  const auditTexels = async (limit = 400): Promise<AtlasTexelAudit> => {
    const result: {
      checked: number;
      truncated: boolean;
      skipped: Record<string, number>;
      undrawn: Record<string, number>;
      mismatches: AtlasTexelMismatch[];
      worst: number;
    } = { checked: 0, truncated: false, skipped: {}, undrawn: {}, mismatches: [], worst: 0 };
    const count = (bag: Record<string, number>, why: string): void => {
      bag[why] = (bag[why] ?? 0) + 1;
    };
    const skip = (why: string): void => count(result.skipped, why);
    const undrawn = (why: string): void => count(result.undrawn, why);

    type Piece = {
      readonly cell: number;
      readonly key: string;
      readonly kind: "texels" | "gutter" | "reserved-texel";
      readonly page: number;
      readonly textureX: number;
      readonly textureY: number;
      readonly x: number;
      readonly y: number;
      readonly w: number;
      readonly h: number;
      readonly sourceX: number;
      readonly sourceY: number;
      readonly layer: number;
      readonly bpp: number;
      readonly want?: Uint8Array | Uint8ClampedArray;
      readonly wantWidth: number;
      readonly detail: string;
      buffer: GPUBuffer;
      stride: number;
    };

    const pieces: Piece[] = [];
    let acceptedCells = 0;
    let encoder: GPUCommandEncoder | undefined;

    const copyRect = (piece: Omit<Piece, "buffer" | "stride">, texture: GPUTexture): void => {
      if (encoder === undefined || device === undefined) return;
      const stride = Math.ceil((piece.w * piece.bpp) / 256) * 256;
      const buffer = device.createBuffer({ size: Math.max(256, stride * piece.h), usage: 0x0001 | 0x0008 }); // MAP_READ | COPY_DST
      encoder.copyTextureToBuffer(
        { texture, mipLevel: 0, origin: { x: piece.textureX, y: piece.textureY, z: piece.layer } },
        { buffer, bytesPerRow: stride, rowsPerImage: piece.h },
        { width: piece.w, height: piece.h, depthOrArrayLayers: 1 },
      );
      pieces.push({ ...piece, buffer, stride });
    };

    const zeroRect = (
      texture: GPUTexture,
      textureX: number,
      textureY: number,
      w: number,
      h: number,
      bpp: number,
      cell: number,
      key: string,
      kind: "gutter" | "reserved-texel",
      page: number,
      detail: string,
    ): void => {
      if (w <= 0 || h <= 0) return;
      copyRect(
        { cell, key, kind, page, textureX, textureY, x: textureX, y: textureY, w, h, sourceX: 0, sourceY: 0, layer: 0, bpp, wantWidth: 0, detail },
        texture,
      );
    };

    /** The largest row bands of a cell at full width that stay near the audit's texel budget. */
    const bands = (w: number, h: number): ReadonlyArray<{ readonly y: number; readonly h: number }> => {
      const cap = 4_000_000;
      if (w * h <= cap) return [{ y: 0, h }];
      const count = 16;
      const bandH = Math.max(1, Math.floor(cap / Math.max(1, w * count)));
      if (bandH >= h) return [{ y: 0, h }];
      const out: Array<{ y: number; h: number }> = [];
      for (let i = 0; i < count; i += 1) {
        const y = Math.round((i * (h - bandH)) / (count - 1));
        const last = out[out.length - 1];
        if (last !== undefined && y < last.y + last.h) continue;
        out.push({ y, h: Math.min(bandH, h - y) });
      }
      return out;
    };

    const freshBytes = (pixels: AtlasPixels, w: number, h: number, bpp: number): Uint8Array | Uint8ClampedArray | undefined => {
      const carried = (pixels as { readonly data?: Uint8Array }).data;
      if (carried !== undefined) {
        if (bpp === 1 && carried.length >= w * h) return carried;
        if (bpp === 4 && carried.length >= w * h * 4) return carried;
      }
      const src = ("source" in pixels ? pixels.source : pixels) as CanvasImageSource;
      let ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;
      if (typeof (src as HTMLCanvasElement).getContext === "function" && (src as HTMLCanvasElement).width === w && (src as HTMLCanvasElement).height === h) {
        ctx = (src as HTMLCanvasElement).getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D | null;
      } else {
        let canvas: HTMLCanvasElement | OffscreenCanvas | undefined;
        if (typeof OffscreenCanvas === "function") canvas = new OffscreenCanvas(w, h);
        else if (typeof document !== "undefined") {
          const own = document.createElement("canvas");
          own.width = w;
          own.height = h;
          canvas = own;
        }
        if (canvas === undefined) return undefined;
        ctx = canvas.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
        if (ctx === null) return undefined;
        ctx.drawImage(src, 0, 0, w, h, 0, 0, w, h);
      }
      if (ctx === null || typeof ctx.getImageData !== "function") return undefined;
      const rgba = ctx.getImageData(0, 0, w, h).data;
      if (bpp === 4) return rgba;
      const alpha = new Uint8Array(w * h);
      for (let i = 0; i < alpha.length; i += 1) alpha[i] = rgba[i * 4 + 3]!;
      return alpha;
    };

    // Pending level-0 writes are already in the texture, but their mip levels
    // may still be queued. Draw them before any readback so the texture the
    // audit reads is the one a frame can sample.
    generateDirtyMipmaps();

    const canRead =
      device !== undefined &&
      typeof device.createBuffer === "function" &&
      typeof device.createCommandEncoder === "function";
    if (canRead) {
      encoder = device!.createCommandEncoder();
      if (typeof encoder.copyTextureToBuffer !== "function") encoder = undefined;
    }

    for (let i = 0; i < highWaterCells; i += 1) {
      const rec = slots[i];
      if (rec === undefined) continue;
      if (rec.refCount <= 0) {
        undrawn("cached");
        continue;
      }
      if (rec.state !== "landed") {
        undrawn("not-landed");
        continue;
      }
      const at = rec.placed;
      const own = rec.standalone;
      if ((at !== undefined && at.page.dead) || (at === undefined && own === undefined)) {
        if (at !== undefined && at.page.dead) undrawn("dead-page");
        else skip("no-rect");
        continue;
      }
      if (!canRead || encoder === undefined) {
        skip("no-device");
        continue;
      }
      if (acceptedCells >= limit) {
        result.truncated = true;
        skip("past-limit");
        continue;
      }
      if (rec.desc === undefined) {
        skip("no-desc");
        continue;
      }
      let px: AtlasPixels | undefined;
      try {
        px = rasterizeSync(rec.desc);
      } catch {
        px = undefined;
      }
      if (px === undefined) {
        skip("no-sync-raster");
        continue;
      }
      const bpp = rec.pool === "coverage" ? 1 : 4;
      const boxW = own?.w ?? at?.w ?? 0;
      const boxH = own?.h ?? at?.h ?? 0;
      const page = own === undefined ? at!.page.pageIndex : -1;
      if (px.width !== boxW || px.height !== boxH) {
        result.mismatches.push({
          kind: "box",
          cell: i,
          key: rec.key,
          meanDiff: 255,
          badFraction: 1,
          detail: `box ${boxW}x${boxH}, fresh raster ${px.width}x${px.height}`,
          page,
          x: at?.x ?? 0,
          y: at?.y ?? 0,
          w: boxW,
          h: boxH,
        });
        closePixels(px);
        continue;
      }
      const want = freshBytes(px, boxW, boxH, bpp);
      closePixels(px);
      if (want === undefined) {
        skip("no-2d");
        continue;
      }

      acceptedCells += 1;
      const geom = own === undefined
        ? { texture: at!.page.texture, baseX: at!.x, baseY: at!.y, tileW: boxW, tileH: boxH, tilesX: 1, tilesY: 1 }
        : { texture: own.texture, baseX: 0, baseY: 0, tileW: own.tileW, tileH: own.tileH, tilesX: own.tilesX, tilesY: own.tilesY };
      for (const band of bands(boxW, boxH)) {
        for (let ty = 0; ty < geom.tilesY; ty += 1) {
          const tileTop = ty * geom.tileH;
          const y0 = Math.max(band.y, tileTop);
          const y1 = Math.min(band.y + band.h, tileTop + geom.tileH, boxH);
          if (y1 <= y0) continue;
          for (let tx = 0; tx < geom.tilesX; tx += 1) {
            const tileLeft = tx * geom.tileW;
            const x0 = tileLeft;
            const x1 = Math.min(tileLeft + geom.tileW, boxW);
            if (x1 <= x0) continue;
            const layer = ty * geom.tilesX + tx;
            copyRect(
              {
                cell: i,
                key: rec.key,
                kind: "texels",
                page,
                textureX: geom.baseX + x0 - tileLeft,
                textureY: geom.baseY + y0 - tileTop,
                x: x0,
                y: y0,
                w: x1 - x0,
                h: y1 - y0,
                sourceX: x0,
                sourceY: y0,
                layer,
                bpp,
                want,
                wantWidth: boxW,
                detail: own === undefined ? `state ${rec.state}` : `standalone layer ${layer}`,
              },
              geom.texture,
            );
          }
        }
      }

      // A paged cell owns the clear gutter written with it. The audit reads
      // the level-0 right and bottom bands; mip levels are a separate check.
      if (at !== undefined) {
        const gutter = gutterFor(at.pool);
        const right = Math.min(gutter, at.page.size - (at.x + at.w));
        const bottom = Math.min(gutter, at.page.size - (at.y + at.h));
        zeroRect(at.page.texture, at.x + at.w, at.y, right, at.h, bpp, i, rec.key, "gutter", at.page.pageIndex, "right gutter");
        zeroRect(at.page.texture, at.x, at.y + at.h, at.w + right, bottom, bpp, i, rec.key, "gutter", at.page.pageIndex, "bottom gutter");
      }
    }

    // Texel (0,0) of page 0 of each pool is what every empty row samples. It
    // is no cell's and stays clear.
    for (const pool of [rgbaPool, coveragePool]) {
      const page = pool.pages[0];
      if (page !== undefined && !page.dead && canRead && encoder !== undefined) {
        zeroRect(page.texture, 0, 0, 1, 1, pool.bytesPerPixel, -1, `${pool.kind}-reserved-texel`, "reserved-texel", 0, "texel (0,0) of page 0");
      }
    }

    if (encoder !== undefined && pieces.length > 0) device!.queue.submit([encoder.finish()]);
    const comparedCells = new Set<number>();
    for (const piece of pieces) {
      try {
        await piece.buffer.mapAsync(0x0001);
      } catch {
        if (piece.kind === "texels") skip("map-failed");
        piece.buffer.destroy();
        continue;
      }
      const got = new Uint8Array(piece.buffer.getMappedRange().slice(0));
      piece.buffer.unmap();
      piece.buffer.destroy();
      let sum = 0;
      let bad = 0;
      for (let y = 0; y < piece.h; y += 1) {
        for (let x = 0; x < piece.w; x += 1) {
          let d = 0;
          for (let c = 0; c < piece.bpp; c += 1) {
            const g = got[y * piece.stride + x * piece.bpp + c]!;
            const s = piece.want === undefined ? 0 : piece.want[(piece.sourceY + y) * piece.wantWidth * piece.bpp + (piece.sourceX + x) * piece.bpp + c]!;
            if (piece.bpp === 4 && c < 3) {
              const ga = got[y * piece.stride + x * 4 + 3]! / 255;
              const sa = piece.want === undefined ? 0 : piece.want[(piece.sourceY + y) * piece.wantWidth * 4 + (piece.sourceX + x) * 4 + 3]! / 255;
              d = Math.max(d, Math.abs(g * ga - s * sa));
            } else {
              d = Math.max(d, Math.abs(g - s));
            }
          }
          sum += d;
          if (d > 64) bad += 1;
        }
      }
      if (piece.kind === "texels") comparedCells.add(piece.cell);
      const meanDiff = sum / Math.max(1, piece.w * piece.h);
      const badFraction = bad / Math.max(1, piece.w * piece.h);
      result.worst = Math.max(result.worst, meanDiff);
      const wrong = piece.kind === "texels" ? meanDiff > 12 && badFraction > 0.02 : meanDiff > 0 || badFraction > 0;
      if (wrong) {
        result.mismatches.push({
          kind: piece.kind,
          cell: piece.cell,
          key: piece.key,
          meanDiff,
          badFraction,
          detail: piece.detail,
          page: piece.page,
          x: piece.x,
          y: piece.y,
          w: piece.w,
          h: piece.h,
        });
      }
    }
    result.checked = comparedCells.size;
    return result;
  };

  /**
   * Every page goes with its device. A page marked dead is deaf to an
   * out-of-memory answer that comes late: by then its index is another
   * page's, and the slots it held have landed elsewhere.
   */
  const dropPages = (): void => {
    for (const pool of [rgbaPool, coveragePool]) {
      for (const page of pool.pages) {
        if (!page.dead) {
          dropMipRectsFor(page.texture);
          page.texture.destroy();
        }
        page.dead = true;
      }
      pool.pages.length = 0;
      pool.pageTextures.length = 0;
    }
  };

  const pendingKeys = (limit = 200): ReadonlyArray<AtlasPendingEntry> => {
    const cap = Math.max(0, Math.floor(limit));
    if (cap === 0) return [];
    const out: AtlasPendingEntry[] = [];
    for (let i = 0; i < highWaterCells && out.length < cap; i += 1) {
      const rec = slots[i];
      if (rec === undefined || (rec.state !== "queued" && rec.state !== "rasterizing")) continue;
      const desc = rec.desc;
      const box = desc !== undefined ? expectedBoxFor(desc.quad, rec.scale) : undefined;
      const w = box?.w ?? (desc !== undefined ? Math.max(1, Math.ceil(desc.quad.rect.width * rec.scale)) : 0);
      const h = box?.h ?? (desc !== undefined ? Math.max(1, Math.ceil(desc.quad.rect.height * rec.scale)) : 0);
      let sourceRef: string | null = null;
      const sp = desc?.quad.sprite;
      if (sp !== undefined) {
        if (sp.atlas === "image") sourceRef = sp.key;
        else if (sp.atlas === "media") sourceRef = sp.ref;
        else if (sp.atlas === "glyph") sourceRef = sp.name;
        else sourceRef = `${sp.cell.col},${sp.cell.row}`;
      }
      out.push({
        key: rec.key,
        kind: desc?.kind ?? (rec.key.startsWith("txt:") ? "text" : "sprite"),
        state: rec.state,
        scale: rec.scale,
        width: w,
        height: h,
        sourceRef,
        attempts: rec.attempts,
      });
    }
    return out;
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

      stopPageReclaimTimer();
      dropPages();
      // The side map names page textures too, and one texture for every slot
      // showing it: a texture of its own is destroyed through its one owner.
      for (const rec of slots) rec?.standalone?.texture.destroy();
      dummyRgbaTex?.destroy();
      dummyCovTex?.destroy();
      standaloneTextures.clear();
      standaloneBytes = 0;
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

      // Device loss / re-attach (Ruling 6 #3). No pixels survive the device:
      // nothing is landed, no slot has a cell to show, and a slot no quad
      // holds is not worth a raster. Every held slot is rastered again at
      // once (sync where possible, queued for SVG and media) before the first
      // frame presents.
      contentLanded.clear();
      landedCount = 0;
      // No slot is failed from here, so the retry timer has nothing to wait
      // for. A raster that fails below sets it again.
      stopRetryTimer();
      for (let i = 0; i < highWaterCells; i += 1) {
        const rec = slots[i];
        if (rec === undefined) continue;
        // The page is dead, so giving the rect up writes nothing to it.
        unplace(rec);
        rec.standalone = undefined;
        rec.state = "queued";
        // Nothing has failed on this device yet.
        rec.attempts = 0;
        rec.retryAfter = 0;
        if (rec.standIn !== undefined) {
          rec.standIn.refCount = Math.max(0, rec.standIn.refCount - 1);
          rec.standIn = undefined;
        }
      }
      // Sorted into kept and freed only now, when no slot counts as another's holder.
      const kept: SlotRecord[] = [];
      for (let i = 0; i < highWaterCells; i += 1) {
        const rec = slots[i];
        if (rec === undefined) continue;
        if (rec.refCount > 0) kept.push(rec);
        else freeSlot(rec);
      }
      for (const rec of kept) {
        goByKey(rec);
        writeRow(rec);
      }
      for (const rec of kept) {
        // Sync raster at once, so held text, mark and glyph cells are ready before frame 1.
        if (rec.desc !== undefined && !ensureNow(rec.index)) enqueue(rec.index);
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
    ownImage,
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
    pendingKeys,
    rerasterLog: (limit = 256): ReadonlyArray<AtlasRerasterEntry> => rerasterLog.slice(-limit),
    audit,
    auditTexels,
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
      stopRetryTimer();
      stopPageReclaimTimer();
      seenContentKeys.clear();
      drainChannel?.port1.close();
      drainChannel?.port2.close();
      drainChannel = undefined;
      dropPages();
      for (const rec of slots) rec?.standalone?.texture.destroy();
      dummyRgbaTex?.destroy();
      dummyCovTex?.destroy();
      dummyRgbaTex = undefined;
      dummyCovTex = undefined;
      standaloneTextures.clear();
      standaloneBytes = 0;
      dirtyMipRects.length = 0;
      mipPipeline = undefined;
      mipBindLayout = undefined;
      queue.length = 0;
      queueHead = 0;
      queuedSet.clear();
      contentLanded.clear();
      byKey.clear();
      byShown.clear();
      waitingByKey.clear();
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

/**
 * Grow-only scratch canvas: never shrinks, clears (w+1)x(h+1) so the 1px
 * gutter is transparent. Its pixels are good only until the next raster: a
 * caller copies from it before anything else runs, and never hands the canvas
 * itself across an `await`.
 */
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
let pendingDecodeHead = 0;
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
  while (pendingDecodeHead < pendingDecodeQueue.length) {
    const item = pendingDecodeQueue[pendingDecodeHead++]!;
    if (pendingDecodeHead >= 1024 && pendingDecodeHead * 2 >= pendingDecodeQueue.length) {
      pendingDecodeQueue.splice(0, pendingDecodeHead);
      pendingDecodeHead = 0;
    }
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
    if (pendingDecodeHead < pendingDecodeQueue.length && nowMs() - start >= DECODE_SLICE_MS) {
      decodeDrainScheduled = true;
      postDecodeDrain();
      return;
    }
  }
  if (pendingDecodeHead > 0) {
    pendingDecodeQueue.length = 0;
    pendingDecodeHead = 0;
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

/**
 * The async sprite rasterizer answers with a bitmap of its own, never with
 * the shared scratch.
 *
 * Every cell waiting on one decode resumes back to back. Each cleared and
 * redrew the scratch, and only then did the atlas copy from it, so every cell
 * but the last landed the last one's picture cropped to its own box: a small
 * portrait cell held the top-left corner of a larger raster of the same
 * portrait, for good. `createImageBitmap` copies the canvas's pixels when it
 * is called, so the bitmap is taken in the same turn as the draw.
 */
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
    return createImageBitmap(canvas, 0, 0, w, h);
  }

  // media: decode once per file, draw fitted at any scale
  const entry = await decodeMediaSourceOnce(ref);
  const { canvas, ctx } = getDrawScratch(w, h);
  drawDecodedMedia(ctx, entry, ref.fit, mode, w, h);
  return createImageBitmap(canvas, 0, 0, w, h);
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
    const pending = new Map<number, { workerIdx: number; resolve: (px: AtlasPixels) => void; reject: (err: Error) => void }>();
    let nextId = 1;
    let rr = 0;

    for (let i = 0; i < count; i += 1) {
      const workerIdx = i;
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
        const reason = new Error(`atlas raster worker error: ${err.message}`);
        for (const [id, entry] of [...pending.entries()]) {
          if (entry.workerIdx !== workerIdx) continue;
          pending.delete(id);
          entry.reject(reason);
        }
      };
      workers.push(worker);
    }

    const dispatch = (req: RasterWorkerRequest, id: number): Promise<AtlasPixels> =>
      new Promise<AtlasPixels>((resolve, reject) => {
        const workerIdx = rr % workers.length;
        pending.set(id, { workerIdx, resolve, reject });
        const target = workers[workerIdx]!;
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
