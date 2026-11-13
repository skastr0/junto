/**
 * Text on the canvas (docs/canvas-gpu-architecture.md section 8). A run is
 * one piece of text in one style — a seat's name, its line, one line of a
 * note — drawn as one quad from the atlas. The browser rasterizes (the
 * engine never shapes text itself): a TextRasterizer is handed in, exactly
 * as the contract's Rasterize hands images to the engine.
 *
 * What lives here and is testable without a DOM:
 *   - the run model and its cache key (text + font + pixel size + halo)
 *   - truncation: tail ellipsis, head truncation for paths, the two-line
 *     clamp — all computed with measure(), once per text and width, the way
 *     the DOM's text-overflow and -webkit-line-clamp compute theirs
 *   - the atlas: LRU cells against a byte cap; the engine asks for a run,
 *     gets a cell id, and queues raster work through the rasterizer
 *
 * What does not live here: the canvas 2D rasterizer itself (it needs a
 * document; the shell provides it), and drawing (track C).
 */

import { FONT_BODY, FONT_DISPLAY, FONT_MONO } from "@shared/theme";
import type { FontRole, TextRun } from "../contract";

export type { FontRole, TextRun } from "../contract";

export const FONT_STACK: Record<FontRole, string> = {
  mono: FONT_MONO,
  display: FONT_DISPLAY,
  body: FONT_BODY,
};

/** What the rasterizer needs to draw one run into the atlas. */
export interface RasterJob {
  readonly key: string;
  readonly run: TextRun;
  /** Device pixels per CSS pixel the run is rasterized for. */
  readonly pixelRatio: number;
}

/** One atlas cell: coverage (and halo) plus where it sits. */
export interface TextCell {
  readonly key: string;
  readonly width: number;
  readonly height: number;
  /** Bytes the cell holds in the atlas, for the cap. */
  readonly bytes: number;
}

/** The browser's text engine, injected: measure and rasterize. */
export interface TextRasterizer {
  /** Advance width of `text` in the run's font, device pixels. */
  measure(run: TextRun, text: string, pixelRatio: number): number;
  /** Rasterize one run; resolves to its cell metrics. Coverage only — the
   *  style colours it. */
  rasterize(job: RasterJob): Promise<Omit<TextCell, "key">>;
}

const ELLIPSIS = "…";

/** The DOM font shorthand canvas 2D wants, from the token stacks.
 *  font-feature-settings (tabular) and letter-spacing are not font shorthand
 *  slots; the rasterizer applies them alongside. */
export const fontCss = (
  run: Pick<TextRun, "font" | "size" | "weight" | "italic">,
  pixelRatio: number,
): string => {
  const size = run.size * pixelRatio;
  const style = run.italic ? "italic " : "";
  return `${style}${run.weight} ${size}px ${FONT_STACK[run.font]}`;
};

/** The text a run actually lays out: uppercase transform applied. */
export const runText = (run: TextRun): string =>
  run.upper ? run.text.toUpperCase() : run.text;

/** Cache key: everything that changes the raster, and nothing that does not
 *  (colour is the style's ink, layout fields truncate/width/align are
 *  resolved before rasterizing, so none of them key the cell). */
export const runKey = (
  run: TextRun,
  pixelRatio: number,
  scaleBucket: number,
): string =>
  [
    runText(run),
    run.font,
    run.size,
    run.weight,
    run.tracking ?? 0,
    run.leading ?? 0,
    run.upper ? 1 : 0,
    run.italic ? 1 : 0,
    run.tabular ? 1 : 0,
    run.halo ? 1 : 0,
    pixelRatio,
    scaleBucket,
  ].join("|");

/** The slice of a canvas 2D context measurement needs. */
export interface MeasureContext {
  font: string;
  letterSpacing: string;
  measureText(text: string): { readonly width: number };
}

/** `PaintEnv.measure`: the width in board units of a run on one line,
 *  untruncated. `scale` is the board-to-device-pixel factor the rasterizer
 *  works at (fontCss's pixelRatio). */
export const measureRun = (
  ctx: MeasureContext,
  run: TextRun,
  scale: number,
): number => {
  ctx.font = fontCss(run, scale);
  ctx.letterSpacing = run.tracking !== undefined ? `${run.tracking}em` : "0px";
  return ctx.measureText(runText(run)).width / scale;
};

// --- truncation -------------------------------------------------------------
// The DOM's cases (cards inventory): `truncate` is a tail ellipsis,
// paths truncate at the head (direction: rtl + bdi), and -webkit-line-clamp
// clamps to two lines. measure() is the browser's own, so the canvas picks
// the same break the DOM would.

export interface Measure {
  (text: string): number;
}

const fits = (text: string, maxWidth: number, measure: Measure): boolean =>
  measure(text) <= maxWidth;

/** The longest prefix of `text` within `budget`, by binary search — the
 *  shared core of both truncations. */
const prefixWithin = (text: string, budget: number, measure: Measure): string => {
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(text.slice(0, mid)) <= budget) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo);
};

/** Tail ellipsis, as `truncate` / `text-overflow: ellipsis` draws it: the
 *  longest prefix that fits with the ellipsis appended. Returns the input
 *  unchanged when it already fits. */
export const truncateTail = (
  text: string,
  maxWidth: number,
  measure: Measure,
): string => {
  if (fits(text, maxWidth, measure)) return text;
  const budget = maxWidth - measure(ELLIPSIS);
  if (budget <= 0) return ELLIPSIS;
  return prefixWithin(text, budget, measure) + ELLIPSIS;
};

/** Head truncation, as the path leaf's direction:rtl + bdi draws it: the
 *  ellipsis sits at the start and the longest fitting suffix survives. */
export const truncateHead = (
  text: string,
  maxWidth: number,
  measure: Measure,
): string => {
  if (fits(text, maxWidth, measure)) return text;
  const budget = maxWidth - measure(ELLIPSIS);
  if (budget <= 0) return ELLIPSIS;
  // Longest suffix within budget: binary search on the suffix length.
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(text.slice(text.length - mid)) <= budget) lo = mid;
    else hi = mid - 1;
  }
  return ELLIPSIS + text.slice(text.length - lo);
};

/** Greedy word wrap, the way CSS `white-space: normal` breaks: break at
 *  spaces and punctuation, never inside a word, and never before the first
 *  word of a line. Whitespace at a break collapses, as in HTML. Returns the
 *  lines; a single word longer than maxWidth stays whole on its own line,
 *  as the DOM lets it overflow rather than break mid-word. */
export const wrapLines = (
  text: string,
  maxWidth: number,
  measure: Measure,
): string[] => {
  const words = text.split(/(\s+)/).filter((part) => part.length > 0);
  const lines: string[] = [];
  let line = "";
  const push = (): void => {
    const trimmed = line.trim();
    if (trimmed !== "") lines.push(trimmed);
    line = "";
  };
  for (const word of words) {
    if (line === "" && /^\s+$/.test(word)) continue; // leading space collapses
    const candidate = line + word;
    if (fits(candidate, maxWidth, measure)) {
      line = candidate;
      continue;
    }
    // Doesn't fit: the break lands here. A whitespace word is consumed by
    // the break; any other word opens the next line.
    push();
    if (!/^\s+$/.test(word)) line = word;
  }
  push();
  return lines.length === 0 ? [""] : lines;
};

/** -webkit-line-clamp: keep at most `maxLines` wrapped lines and put the
 *  ellipsis at the end of the last when text was cut — exactly what the
 *  clamp paints. `maxWidth` is the content width; wrapping uses the same
 *  measure the DOM's layout would. */
export const clampLines = (
  text: string,
  maxWidth: number,
  maxLines: number,
  measure: Measure,
): string[] => {
  const lines = wrapLines(text, maxWidth, measure);
  if (lines.length <= maxLines) return lines;
  // The clamp always ends in an ellipsis when it cut content — even when the
  // last visible line happens to fit, as -webkit-line-clamp draws it.
  const kept = lines.slice(0, maxLines);
  const last = kept[maxLines - 1]!;
  const budget = maxWidth - measure(ELLIPSIS);
  kept[maxLines - 1] =
    budget <= 0 ? ELLIPSIS : prefixWithin(last, budget, measure) + ELLIPSIS;
  return kept;
};

/** The lines a run lays out at `maxWidthPx`, honouring its `truncate` field:
 *  "end" tail-ellipsizes, "head" head-ellipsizes (a path), "clamp2" wraps and
 *  clamps to two lines, "none" wraps unclamped. `maxWidthPx` is the run's
 *  width converted to the raster's pixel space. */
export const layoutRun = (
  run: TextRun,
  maxWidthPx: number,
  measure: Measure,
): string[] => {
  const text = runText(run);
  switch (run.truncate) {
    case "end":
      return [truncateTail(text, maxWidthPx, measure)];
    case "head":
      return [truncateHead(text, maxWidthPx, measure)];
    case "clamp2":
      return clampLines(text, maxWidthPx, 2, measure);
    case "none":
      return wrapLines(text, maxWidthPx, measure);
  }
};

// --- the atlas ----------------------------------------------------------------

export interface TextAtlasOptions {
  /** Bytes of atlas the cache may hold; least-recently-used cells evict. */
  readonly byteCap: number;
}

export interface TextAtlas {
  /** The cell for a run at a scale bucket, or undefined while its raster is
   *  queued. Asking twice for the same key returns the same cell. */
  cell(run: TextRun, pixelRatio: number, scaleBucket: number): TextCell | undefined;
  /** Queue a run's raster; resolves when the cell lands. Duplicate asks
   *  share one job. */
  want(run: TextRun, pixelRatio: number, scaleBucket: number): Promise<TextCell>;
  /** Cells held and bytes used, for stats. */
  readonly stats: { readonly cells: number; readonly bytes: number; readonly queued: number };
}

export const createTextAtlas = (
  rasterizer: TextRasterizer,
  options: TextAtlasOptions,
): TextAtlas => {
  const cells = new Map<string, TextCell>();
  const pending = new Map<string, Promise<TextCell>>();
  let bytes = 0;
  let tick = 0;
  const lru = new Map<string, number>();

  const evict = (): void => {
    while (bytes > options.byteCap && lru.size > 0) {
      let oldestKey: string | undefined;
      let oldest = Infinity;
      for (const [key, at] of lru) {
        if (at < oldest) {
          oldest = at;
          oldestKey = key;
        }
      }
      if (oldestKey === undefined) return;
      const cell = cells.get(oldestKey);
      if (cell) bytes -= cell.bytes;
      cells.delete(oldestKey);
      lru.delete(oldestKey);
    }
  };

  const want = (
    run: TextRun,
    pixelRatio: number,
    scaleBucket: number,
  ): Promise<TextCell> => {
    const key = runKey(run, pixelRatio, scaleBucket);
    const existing = cells.get(key);
    if (existing) {
      lru.set(key, ++tick);
      return Promise.resolve(existing);
    }
    const job = pending.get(key);
    if (job) return job;
    const promise = rasterizer
      .rasterize({ key, run, pixelRatio })
      .then((metrics) => {
        const cell: TextCell = { key, ...metrics };
        cells.set(key, cell);
        lru.set(key, ++tick);
        bytes += cell.bytes;
        evict();
        return cell;
      })
      .finally(() => {
        pending.delete(key);
      });
    pending.set(key, promise);
    return promise;
  };

  return {
    cell: (run, pixelRatio, scaleBucket) => {
      const key = runKey(run, pixelRatio, scaleBucket);
      const cell = cells.get(key);
      if (cell) lru.set(key, ++tick);
      return cell;
    },
    want,
    get stats() {
      return { cells: cells.size, bytes, queued: pending.size };
    },
  };
};
