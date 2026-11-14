/**
 * The GPU atlas binding (docs/canvas-gpu-architecture.md sections 8 and 9;
 * engine/types.ts AtlasBinding). One texture holds every cell the canvas
 * draws from: text runs rasterized by canvas 2D as coverage, generated art
 * and mark-atlas cells rasterized from SVG or canvas, media later.
 *
 * Records name a cell by index (`Quad.source`); `binding.cells` is one vec4
 * UV rect per index, uploaded through the renderer's cells buffer. A cell
 * lands asynchronously: its UV is written when the bitmap arrives, the
 * texture region is copied in, and `onDirty` fires so the shell can re-upload
 * the cells buffer and repaint. Until then `sourceFor` answers
 * NO_ATLAS_CELL and the quad draws nothing — the same as today.
 *
 * The engine stays DOM-free: every rasterizer is injected. The browser
 * implementations live at the bottom of this file (`browserRasterizers`),
 * built on document canvases; tests hand fakes.
 */

import type { Quad, SpriteRef, TextRun } from "../contract";
import type { ThemeMode } from "@shared/theme";
import { NO_ATLAS_CELL } from "./quad";
import type { AtlasBinding } from "./types";
import {
  fontCss,
  layoutRun,
  runKey,
  type MeasureContext,
} from "./text";
import { MARK_CELL, paintMarkAtlasCanvas } from "../../lib/activity-atlas";

/** Anything the GPU can copy into the atlas: an ImageBitmap or canvas. */
export type AtlasPixels = ImageBitmap | HTMLCanvasElement | OffscreenCanvas;

export interface TextRasterize {
  (run: TextRun, scale: number): Promise<AtlasPixels>;
}
export interface SpriteRasterize {
  (ref: Extract<SpriteRef, { atlas: "image" | "mark" }>, mode: ThemeMode): Promise<AtlasPixels>;
}

export interface GpuAtlasOptions {
  /** Texture edge in pixels; cells pack left to right, top to bottom. */
  readonly size?: number;
  /** Cell slots; the cells buffer is allocated at this capacity up front. */
  readonly maxCells?: number;
  readonly rasterizeText?: TextRasterize;
  readonly rasterizeSprite?: SpriteRasterize;
  readonly mode?: ThemeMode;
  /** Fired (batched, once per task) when landed cells changed the texture or UVs. */
  readonly onDirty?: () => void;
}

export interface GpuAtlas {
  /** The live binding: `texture`, `sampler` and `cells` fill in on attach(). */
  readonly binding: AtlasBinding;
  /** Attach the device the atlas uploads into; safe to call again per generation. */
  attach(device: GPUDevice): void;
  /** Theme switch: sprite keys carry the mode, so new asks rasterize anew. */
  setMode(mode: ThemeMode): void;
  /** The record's atlas cell for a quad's sprite or text, or NO_ATLAS_CELL. */
  sourceFor(quad: Quad, scale: number): number;
  /** Bumped every time landed cells change the texture or the UV buffer. */
  revision(): number;
  readonly pending: number;
  dispose(): void;
}

interface CellJob {
  readonly index: number;
  readonly promise: Promise<void>;
}

interface Placed {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

const DEFAULT_SIZE = 2048;
const DEFAULT_CELLS = 8192;

export const createGpuAtlas = (options: GpuAtlasOptions = {}): GpuAtlas => {
  const size = options.size ?? DEFAULT_SIZE;
  const maxCells = options.maxCells ?? DEFAULT_CELLS;
  let mode = options.mode ?? "dark";

  const cells = new Float32Array(maxCells * 4);
  const jobs = new Map<string, CellJob>();
  const placed = new Map<string, Placed>();
  let device: GPUDevice | undefined;
  let texture: GPUTexture | undefined;
  let sampler: GPUSampler | undefined;
  let cursorX = 0;
  let cursorY = 0;
  let rowH = 0;
  let dirty = false;
  let flushScheduled = false;
  let disposed = false;
  let revision = 0;
  // Every landed cell keeps its pixels so a new device (context loss, a new
  // generation) gets a fresh texture with the same contents; `awaiting` marks
  // the ones whose UV rect is not in `cells` yet (landed before attach).
  const landed = new Map<number, { readonly pixels: AtlasPixels; readonly at: Placed }>();
  const awaiting = new Set<number>();

  // The binding object is stable for the engine's lifetime; attach() fills
  // its fields through the mutable view. Until then the renderer's dummy
  // texture stands in.
  const mutable = {
    texture: undefined as unknown as GPUTexture,
    sampler: undefined as unknown as GPUSampler,
    cells,
  };
  const binding = mutable as AtlasBinding;

  const flush = (): void => {
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
      queueMicrotask(flush);
    }
  };

  const alloc = (w: number, h: number): Placed | undefined => {
    if (cursorX + w > size) {
      cursorX = 0;
      cursorY += rowH;
      rowH = 0;
    }
    if (cursorY + h > size) return undefined; // atlas full: rebuild is a later problem
    const at: Placed = { x: cursorX, y: cursorY, w, h };
    cursorX += w;
    rowH = Math.max(rowH, h);
    return at;
  };

  const copyPixels = (pixels: AtlasPixels, at: Placed): void => {
    device!.queue.copyExternalImageToTexture(
      { source: pixels as unknown as ImageBitmap },
      { texture: texture!, origin: { x: at.x, y: at.y } },
      { width: Math.max(1, pixels.width), height: Math.max(1, pixels.height) },
    );
  };

  const writeUV = (index: number, pixels: AtlasPixels, at: Placed): void => {
    const w = Math.max(1, pixels.width);
    const h = Math.max(1, pixels.height);
    cells[index * 4] = at.x / size;
    cells[index * 4 + 1] = at.y / size;
    cells[index * 4 + 2] = (at.x + w) / size;
    cells[index * 4 + 3] = (at.y + h) / size;
  };

  const land = (index: number, pixels: AtlasPixels, at: Placed): void => {
    landed.set(index, { pixels, at });
    if (device === undefined || texture === undefined) {
      awaiting.add(index);
      return;
    }
    copyPixels(pixels, at);
    writeUV(index, pixels, at);
    awaiting.delete(index);
    markDirty();
  };

  const intern = (key: string, rasterize: () => Promise<AtlasPixels>): number => {
    const existing = placed.get(key);
    if (existing !== undefined) {
      // Recompute the index from insertion order: placed stores geometry,
      // jobs store the promise; the index lives in the job's slot map.
      return indexOf(key);
    }
    const job = jobs.get(key);
    if (job !== undefined) return job.index;
    const index = nextIndex++;
    if (index >= maxCells) return NO_ATLAS_CELL;
    const promise = rasterize()
      .then(async (pixels) => {
        const w = Math.max(1, pixels.width);
        const h = Math.max(1, pixels.height);
        const at = alloc(w, h);
        if (at === undefined) return;
        placed.set(key, at);
        land(index, pixels, at);
      })
      .catch(() => {
        // A failed raster leaves the cell empty; the quad keeps NO_ATLAS_CELL
        // semantics through the zeroed UV (samples texel 0,0 = transparent).
      })
      .finally(() => {
        jobs.delete(key);
      });
    jobs.set(key, { index, promise });
    return index;
  };

  // Cell indices are handed out in intern order; a reverse map keeps
  // sourceFor cheap for repeated asks of the same key.
  const indices = new Map<string, number>();
  let nextIndex = 0;
  const indexOf = (key: string): number => indices.get(key) ?? NO_ATLAS_CELL;
  const remember = (key: string, index: number): void => {
    indices.set(key, index);
  };

  // intern() records the index before the async work; keep indices and
  // placed in one pass by wrapping: sourceFor asks intern, which returns
  // the index synchronously and remembers it.
  const internRemembered = (key: string, rasterize: () => Promise<AtlasPixels>): number => {
    const known = indices.get(key);
    if (known !== undefined) return known;
    const index = intern(key, rasterize);
    if (index !== NO_ATLAS_CELL) remember(key, index);
    return index;
  };

  const textKey = (run: TextRun, scale: number): string => `${runKey(run, scale, 0)}`;

  const sourceFor = (quad: Quad, scale: number): number => {
    if (quad.sprite !== undefined) {
      const ref = quad.sprite;
      // Mode is part of the key: generated art and the mark atlas repaint per
      // theme, so a theme switch must not hit a stale cell.
      if (ref.atlas === "image") {
        return internRemembered(`img:${mode}:${ref.key}:${ref.size.width}x${ref.size.height}`,
          () => options.rasterizeSprite?.(ref, mode) ?? Promise.reject(new Error("no sprite rasterizer")));
      }
      if (ref.atlas === "mark") {
        return internRemembered(`mark:${mode}:${ref.cell.col},${ref.cell.row}`,
          () => options.rasterizeSprite?.(ref, mode) ?? Promise.reject(new Error("no sprite rasterizer")));
      }
      // glyph and media have no raster path yet: they keep drawing nothing.
      return NO_ATLAS_CELL;
    }
    if (quad.text !== undefined && options.rasterizeText !== undefined) {
      return internRemembered(`txt:${textKey(quad.text, scale)}`,
        () => options.rasterizeText!(quad.text!, scale));
    }
    return NO_ATLAS_CELL;
  };

  return {
    binding,
    attach: (next) => {
      if (disposed) return;
      const fresh = device !== next;
      device = next;
      if (texture === undefined || fresh) {
        texture?.destroy();
        texture = next.createTexture({
          size: { width: size, height: size },
          format: "rgba8unorm",
          // GPUTextureUsage bits, as renderer.ts spells them: copy in, sample
          // out, and a render attachment because copyExternalImageToTexture
          // may run as a render pass and validates that bit.
          usage: 0x04 | 0x02 | 0x10,
        });
        sampler = next.createSampler({ magFilter: "linear", minFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" });
        mutable.texture = texture;
        mutable.sampler = sampler;
        // A fresh texture starts blank: replay every landed cell's pixels,
        // then write the UVs of the ones that landed before any attach.
        for (const job of landed.values()) copyPixels(job.pixels, job.at);
        for (const index of awaiting) {
          const job = landed.get(index);
          if (job !== undefined) writeUV(index, job.pixels, job.at);
        }
        awaiting.clear();
        markDirty();
      }
    },
    sourceFor,
    setMode: (next) => {
      mode = next;
    },
    revision: () => revision,
    get pending() {
      return jobs.size + awaiting.size;
    },
    dispose: () => {
      disposed = true;
      texture?.destroy();
      jobs.clear();
      placed.clear();
      indices.clear();
      landed.clear();
      awaiting.clear();
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

/**
 * Text runs as coverage: white glyphs on transparent, the style's ink tints
 * them in the shader (architecture §8: the atlas stores coverage, never the
 * colour). `scale` is device pixels per board unit (pixelRatio at the tier's
 * raster scale).
 */
export const rasterizeTextRun: TextRasterize = async (run, scale) => {
  const ctx = canvas2d(8, 8).ctx; // measure context; the draw canvas is the cell
  const measure: MeasureContext = ctx;
  ctx.font = fontCss(run, scale);
  ctx.letterSpacing = run.tracking !== undefined ? `${run.tracking}em` : "0px";
  const lines = layoutRun(run, Math.max(1, run.width * scale), (t) => ctx.measureText(t).width);
  const lineHeight = run.size * scale * (run.leading ?? 1.2);
  // The cell is exactly the quad's aspect: the shader stretches the UV rect
  // across the whole quad, so any padding or widest-line sizing would smear
  // every run to its wrap box.
  const cellW = Math.max(1, Math.ceil(run.width * scale));
  const cellH = Math.max(1, Math.ceil(lineHeight * lines.length));
  const { canvas, ctx: draw } = canvas2d(cellW, cellH);
  draw.font = ctx.font;
  draw.letterSpacing = ctx.letterSpacing;
  draw.fillStyle = "#fff";
  draw.textBaseline = "middle";
  lines.forEach((line, i) => {
    const x = run.align === "center" ? (cellW - draw.measureText(line).width) / 2 : 0;
    draw.fillText(line, x, lineHeight * i + lineHeight / 2);
  });
  return createImageBitmap(canvas);
};

let markAtlasCache: { mode: ThemeMode; canvas: HTMLCanvasElement } | undefined;

const markAtlasCanvas = (mode: ThemeMode): HTMLCanvasElement | undefined => {
  if (markAtlasCache?.mode === mode) return markAtlasCache.canvas;
  const canvas = paintMarkAtlasCanvas(mode);
  if (canvas !== undefined) markAtlasCache = { mode, canvas };
  return canvas;
};

/** Sprites the shell can already paint: generated art (SVG) and mark cells. */
export const rasterizeSprite: SpriteRasterize = async (ref, mode) => {
  const scale = 2; // generated art rasterizes at 2x its board size for near-tier sharpness
  if (ref.atlas === "image") {
    const { width, height } = ref.size;
    const url = URL.createObjectURL(new Blob([ref.svg], { type: "image/svg+xml" }));
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      const { canvas, ctx } = canvas2d(width * scale, height * scale);
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      return createImageBitmap(canvas);
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  const atlas = markAtlasCanvas(mode);
  if (atlas === undefined) throw new Error("mark atlas unavailable");
  const { canvas, ctx } = canvas2d(MARK_CELL * scale, MARK_CELL * scale);
  ctx.drawImage(
    atlas,
    ref.cell.col * MARK_CELL, ref.cell.row * MARK_CELL, MARK_CELL, MARK_CELL,
    0, 0, canvas.width, canvas.height,
  );
  return createImageBitmap(canvas);
};

export const browserRasterizers = (): Pick<GpuAtlasOptions, "rasterizeText" | "rasterizeSprite"> => ({
  rasterizeText: rasterizeTextRun,
  rasterizeSprite: rasterizeSprite,
});
