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

import type { ColorRef, Quad, TextRun } from "../contract";
import { gpuColorCss, themeGpu, type GpuColor, type GpuTheme, type ThemeMode } from "@shared/theme";
import { NO_ATLAS_CELL } from "./quad";
import type { AtlasBinding } from "./types";
import { resolveColour } from "./styles";
import { drawGlyph, glyphKnown } from "./glyphs";
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
/**
 * A sprite cell is rasterized for the quad that asked: `scale` is device
 * pixels per board unit (the scene's atlas bucket, pixelRatio included) and
 * the cell is the quad's rect at that scale, so the shader's UV stretch is
 * always pixel-exact.
 */
export interface SpriteRasterize {
  (quad: Quad, mode: ThemeMode, scale: number): Promise<AtlasPixels>;
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
  /**
   * How many cell rasterizations have started: one per new key, never per ask.
   * A camera gesture must add none (section 8 rule 2), which the frame test
   * reads.
   */
  readonly requests: number;
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
  let cursorX = 1; // texel (0,0) stays transparent: a cell whose raster failed keeps zeroed UVs and must sample nothing
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
  /** New cell keys rasterized so far; one per key, never per ask. */
  let requests = 0;
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
    if (index !== NO_ATLAS_CELL) {
      remember(key, index);
      requests += 1;
    }
    return index;
  };

  const textKey = (run: TextRun, scale: number): string => `${runKey(run, scale, 0)}`;

  /** A ColorRef as key text: the same ink must hit the same cell. */
  const inkKey = (ref: ColorRef | undefined): string => {
    if (ref === undefined) return "-";
    if ("token" in ref) return `t:${ref.token}:${ref.alpha ?? 1}`;
    if ("custom" in ref) return `c:${ref.custom}:${ref.alpha ?? 1}`;
    return `m:${inkKey(ref.mix[0])},${inkKey(ref.mix[1])},${ref.share}`;
  };

  const sourceFor = (quad: Quad, scale: number): number => {
    if (quad.sprite !== undefined) {
      const ref = quad.sprite;
      // Mode, raster scale and quad size are part of every sprite key:
      // generated art repaints per theme, a zoom bucket wants sharper cells,
      // and the shader maps the cell's UV across the quad's rect, so the
      // cell is rasterized at that rect's pixels. Glyph cells also carry
      // the resolved ink — coverage tinted at raster time, not in the shader.
      const box = `${Math.ceil(quad.rect.width * scale)}x${Math.ceil(quad.rect.height * scale)}`;
      if (ref.atlas === "image") {
        return internRemembered(`img:${mode}:${scale}:${box}:${ref.key}:${ref.size.width}x${ref.size.height}`,
          () => options.rasterizeSprite?.(quad, mode, scale) ?? Promise.reject(new Error("no sprite rasterizer")));
      }
      if (ref.atlas === "mark") {
        return internRemembered(`mark:${mode}:${scale}:${box}:${ref.cell.col},${ref.cell.row}`,
          () => options.rasterizeSprite?.(quad, mode, scale) ?? Promise.reject(new Error("no sprite rasterizer")));
      }
      if (ref.atlas === "glyph") {
        if (!glyphKnown(ref.name)) return NO_ATLAS_CELL;
        return internRemembered(`glyph:${mode}:${scale}:${box}:${inkKey(quad.style.ink)}:${ref.name}`,
          () => options.rasterizeSprite?.(quad, mode, scale) ?? Promise.reject(new Error("no sprite rasterizer")));
      }
      // media
      return internRemembered(`media:${mode}:${scale}:${box}:${ref.fit}:${ref.ref}`,
        () => options.rasterizeSprite?.(quad, mode, scale) ?? Promise.reject(new Error("no sprite rasterizer")));
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
    get requests() {
      return requests;
    },
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
  // Coverage is opaque white: the shader reads the cell's alpha as the glyph
  // mask and tints it with the quad's ink, so the rgb channels never show.
  draw.fillStyle = gpuColorCss(COVERAGE);
  draw.textBaseline = "middle";
  lines.forEach((line, i) => {
    const x = run.align === "center" ? (cellW - draw.measureText(line).width) / 2 : 0;
    draw.fillText(line, x, lineHeight * i + lineHeight / 2);
  });
  return createImageBitmap(canvas);
};

/** Opaque white for coverage cells: the shader reads alpha as the glyph mask. */
const COVERAGE: GpuColor = { r: 1, g: 1, b: 1, a: 1 };

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

/**
 * A sprite SVG rasterizes as a standalone image: no document, so no custom
 * properties. `var(--color-ink)` and friends arrive unresolved and paint
 * nothing (the harness badge was exactly this). Every `--color-*` the
 * markup names resolves through the theme before the blob is made.
 */
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

/**
 * Chromium refuses nested `<image>` loads inside an SVG loaded as an image,
 * so harness badges that embed a vendor raster mark would lose it. The SVG
 * still draws; after it lands, each `<image>` the markup declared is fetched
 * itself and drawn at its declared rect, in the SVG's own user units.
 */
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
      // A mark that will not decode leaves the badge's plate, as the DOM's
      // broken <img> would; the rest of the art is already down.
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

/**
 * Sprite cells, rasterized for the quad that asked: `scale` is device pixels
 * per board unit and the cell is the quad's rect at that scale, so the
 * shader's UV stretch is always pixel-exact. The cell carries the sprite's
 * own colours — generated art and media are opaque RGBA; glyphs bake their
 * resolved ink because the sprite path tints by fill, not style.ink.
 */
export const rasterizeSprite: SpriteRasterize = async (quad, mode, scale) => {
  const ref = quad.sprite;
  if (ref === undefined) throw new Error("rasterizeSprite needs a sprite quad");
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

  if (ref.atlas === "mark") {
    const atlas = markAtlasCanvas(mode);
    if (atlas === undefined) throw new Error("mark atlas unavailable");
    ctx.drawImage(
      atlas,
      ref.cell.col * MARK_CELL, ref.cell.row * MARK_CELL, MARK_CELL, MARK_CELL,
      0, 0, canvas.width, canvas.height,
    );
    return createImageBitmap(canvas);
  }

  if (ref.atlas === "glyph") {
    const ink = resolveColour(quad.style.ink, themeFor(mode))
      ?? { r: 1, g: 1, b: 1, a: 1 };
    const side = Math.min(canvas.width, canvas.height);
    ctx.translate((canvas.width - side) / 2, (canvas.height - side) / 2);
    drawGlyph(ctx, ref.name, side, ink);
    return createImageBitmap(canvas);
  }

  // media: the content store's bitmap on the DOM's bare ground, fitted the
  // way object-fit fits it.
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

export const browserRasterizers = (): Pick<GpuAtlasOptions, "rasterizeText" | "rasterizeSprite"> => ({
  rasterizeText: rasterizeTextRun,
  rasterizeSprite: rasterizeSprite,
});
