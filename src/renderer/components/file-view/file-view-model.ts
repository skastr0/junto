/**
 * The file viewers' pure parts (plan 0.11, F6 and F8): what a file previews
 * as, the zoom ladder, a box drawn on a page or an image, and the pixels an
 * extract takes. A box is always a fraction of the surface it was drawn on
 * (0..1 from the top left), so it means the same thing at every zoom and on
 * every machine; pixels exist only while drawing and while rendering.
 */
import { fileMime } from "@shared/file-url";

/** What the main pane shows for a file. Anything not a PDF or an image offers its default app. */
export type FileViewKind = "pdf" | "image" | "other";

/** The file's name, the last part of its relative path. */
export const fileNameOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1) || path;

/** The viewer for a file, by the media type main serves it as (`fileMime`). */
export const fileViewKindOf = (path: string): FileViewKind => {
  const mime = fileMime(path);
  if (mime === "application/pdf") return "pdf";
  if (mime.startsWith("image/")) return "image";
  return "other";
};

// ---------------------------------------------------------------------------
// Zoom

/** The zoom ladder, as a multiple of the page's own size (a PDF point is one CSS pixel at 1). */
export const ZOOM_STEPS: ReadonlyArray<number> = [0.25, 0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 2, 3, 4];
export const ZOOM_MIN = ZOOM_STEPS[0]!;
export const ZOOM_MAX = ZOOM_STEPS[ZOOM_STEPS.length - 1]!;

/** How the viewer sizes the page: to the pane's width, or at a fixed zoom. */
export type ZoomMode = { readonly kind: "fit" } | { readonly kind: "fixed"; readonly zoom: number };

export const clampZoom = (zoom: number): number => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));

/** The next step up from a zoom that may sit between steps (a fitted zoom does). */
export const zoomIn = (zoom: number): number => clampZoom(ZOOM_STEPS.find((step) => step > zoom + 1e-3) ?? ZOOM_MAX);

export const zoomOut = (zoom: number): number =>
  clampZoom([...ZOOM_STEPS].reverse().find((step) => step < zoom - 1e-3) ?? ZOOM_MIN);

/** The pane's padding either side of the page, in CSS pixels. */
export const PAGE_GUTTER = 24;

/** The zoom that fits a surface `width` wide into a pane `paneWidth` wide, never past 100 percent for an image. */
export const fitZoom = (width: number, paneWidth: number, ceiling = ZOOM_MAX): number => {
  if (width <= 0 || paneWidth <= 0) return 1;
  return clampZoom(Math.min(ceiling, (paneWidth - PAGE_GUTTER * 2) / width));
};

export const zoomOf = (mode: ZoomMode, width: number, paneWidth: number, ceiling?: number): number =>
  mode.kind === "fixed" ? mode.zoom : fitZoom(width, paneWidth, ceiling);

export const zoomLabel = (zoom: number): string => `${Math.round(zoom * 100)}%`;

// ---------------------------------------------------------------------------
// Boxes

/** A box on a surface, as fractions of its width and height. */
export type ViewBox = { readonly x: number; readonly y: number; readonly w: number; readonly h: number };

/** A point on a surface in its rendered CSS pixels. */
export type ViewPoint = { readonly x: number; readonly y: number };

/**
 * The smallest box a drag draws, in screen pixels either way. The pad's
 * area pick ignores anything under its minimum shape size the same way; a
 * click is not a box.
 */
export const MIN_BOX_PX = 8;

const unit = (value: number): number => Math.min(1, Math.max(0, value));

/**
 * The box a drag from `start` to `current` draws on a surface `width` by
 * `height` pixels, clamped to the surface, or nothing when it is too small.
 */
export const boxFromDrag = (start: ViewPoint, current: ViewPoint, width: number, height: number): ViewBox | undefined => {
  if (width <= 0 || height <= 0) return undefined;
  const left = Math.max(0, Math.min(start.x, current.x));
  const right = Math.min(width, Math.max(start.x, current.x));
  const top = Math.max(0, Math.min(start.y, current.y));
  const bottom = Math.min(height, Math.max(start.y, current.y));
  if (right - left < MIN_BOX_PX || bottom - top < MIN_BOX_PX) return undefined;
  return { x: unit(left / width), y: unit(top / height), w: unit((right - left) / width), h: unit((bottom - top) / height) };
};

/** A box in a surface's pixels, for drawing it. */
export const boxPixels = (box: ViewBox, width: number, height: number): { left: number; top: number; width: number; height: number } => ({
  left: box.x * width,
  top: box.y * height,
  width: box.w * width,
  height: box.h * height,
});

/** The scale an extract renders at: twice the surface's own size, so a crop reads sharp on a Retina screen. */
export const EXTRACT_SCALE = 2;

/** The largest side an extract may have, in pixels; a bigger box renders at a lower scale. */
export const EXTRACT_MAX_SIDE = 4096;

/**
 * The whole pixels a box covers on a surface `width` by `height` at `scale`:
 * the crop to render or copy. At least one pixel either way, never past the
 * edge, and the scale drops so neither side passes `EXTRACT_MAX_SIDE`.
 */
export const cropOf = (
  box: ViewBox,
  width: number,
  height: number,
  scale: number,
): { readonly x: number; readonly y: number; readonly w: number; readonly h: number; readonly scale: number } => {
  const fit = Math.min(scale, EXTRACT_MAX_SIDE / Math.max(1, box.w * width), EXTRACT_MAX_SIDE / Math.max(1, box.h * height));
  const fullW = width * fit;
  const fullH = height * fit;
  const x = Math.min(Math.floor(box.x * fullW), Math.max(0, Math.ceil(fullW) - 1));
  const y = Math.min(Math.floor(box.y * fullH), Math.max(0, Math.ceil(fullH) - 1));
  const w = Math.max(1, Math.min(Math.ceil((box.x + box.w) * fullW), Math.ceil(fullW)) - x);
  const h = Math.max(1, Math.min(Math.ceil((box.y + box.h) * fullH), Math.ceil(fullH)) - y);
  return { x, y, w, h, scale: fit };
};

/** An extract's title: the file's name, and its page when it has pages. */
export const extractTitle = (path: string, page?: number): string =>
  page === undefined ? fileNameOf(path) : `${fileNameOf(path)}, page ${page}`;

// ---------------------------------------------------------------------------
// Pages

/** The page that holds most of the pane's middle line, from each page's top and height in scroll pixels. */
export const pageAtScroll = (tops: ReadonlyArray<{ readonly top: number; readonly height: number }>, scrollTop: number, paneHeight: number): number => {
  if (tops.length === 0) return 1;
  const middle = scrollTop + paneHeight / 2;
  for (let index = 0; index < tops.length; index += 1) {
    const page = tops[index]!;
    if (middle < page.top + page.height) return index + 1;
  }
  return tops.length;
};

/** A typed page number, or nothing when it names no page of `count`. */
export const parsePageInput = (text: string, count: number): number | undefined => {
  const page = Number.parseInt(text.trim(), 10);
  return Number.isFinite(page) && page >= 1 && page <= count && String(page) === text.trim() ? page : undefined;
};

// ---------------------------------------------------------------------------
// Boxes from the keyboard

/** The box Enter drops with the box tool on: centred, a third of the surface wide. */
export const KEYBOARD_BOX: ViewBox = { x: 1 / 3, y: 0.4, w: 1 / 3, h: 0.2 };

/** How far one arrow press moves or grows a box, as a fraction of the surface; Shift and an arrow resize. */
export const NUDGE = 0.02;

/** Move a box by `dx`, `dy`, kept whole on the surface. */
export const nudgeBox = (box: ViewBox, dx: number, dy: number): ViewBox => ({
  ...box,
  x: Math.min(1 - box.w, Math.max(0, box.x + dx)),
  y: Math.min(1 - box.h, Math.max(0, box.y + dy)),
});

/** Grow or shrink a box from its top left, never under `NUDGE` and never past the edge. */
export const resizeBox = (box: ViewBox, dw: number, dh: number): ViewBox => ({
  ...box,
  w: Math.min(1 - box.x, Math.max(NUDGE, box.w + dw)),
  h: Math.min(1 - box.y, Math.max(NUDGE, box.h + dh)),
});

/** What an arrow does to a box: move it, or with Shift resize it. Nothing for any other key. */
export const boxByArrow = (box: ViewBox, key: string, shift: boolean): ViewBox | undefined => {
  const step = { ArrowLeft: [-NUDGE, 0], ArrowRight: [NUDGE, 0], ArrowUp: [0, -NUDGE], ArrowDown: [0, NUDGE] }[key];
  if (step === undefined) return undefined;
  const [dx, dy] = step as [number, number];
  return shift ? resizeBox(box, dx, dy) : nudgeBox(box, dx, dy);
};
