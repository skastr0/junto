/**
 * Box comment geometry for a browser page (plan 06), pure.
 *
 * The operator drags a rectangle over a still of the page's viewport. The
 * rectangle is stored in page coordinates (CSS pixels from the document's
 * top left), so it names the same place after the page scrolls, with the
 * scroll offset it was drawn at. The crop of the still is cut in capture
 * pixels: viewport CSS pixels times the device pixel ratio, clamped to the
 * capture.
 */

/** A box smaller than this on either side is a click, not a selection. */
export const PAGE_BOX_MIN_CSS_PX = 8;

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** The view the box was drawn on, read from the page when the still is taken. */
export interface PageViewport {
  /** CSS pixels. */
  readonly width: number;
  readonly height: number;
  readonly scroll: Point;
  readonly devicePixelRatio: number;
}

export interface CaptureSize {
  /** Pixels of the captured still. */
  readonly width: number;
  readonly height: number;
}

export interface PageBox {
  /** Page coordinates, CSS pixels. */
  readonly rect: Rect;
  readonly scroll: Point;
  /** Where to cut the capture, in its own pixels. */
  readonly crop: Rect;
}

export type PageBoxResult =
  | { readonly ok: true; readonly box: PageBox }
  | { readonly ok: false; readonly refusal: { readonly kind: "too_small"; readonly min: number } };

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

/** The rectangle between two drag points, clamped to the viewport, in viewport CSS pixels. */
export const dragRect = (from: Point, to: Point, viewport: Pick<PageViewport, "width" | "height">): Rect => {
  const x0 = clamp(Math.min(from.x, to.x), 0, viewport.width);
  const y0 = clamp(Math.min(from.y, to.y), 0, viewport.height);
  const x1 = clamp(Math.max(from.x, to.x), 0, viewport.width);
  const y1 = clamp(Math.max(from.y, to.y), 0, viewport.height);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
};

/** A viewport rectangle in page coordinates. */
export const toPageRect = (rect: Rect, scroll: Point): Rect => ({
  x: rect.x + scroll.x,
  y: rect.y + scroll.y,
  w: rect.w,
  h: rect.h,
});

/**
 * The crop of a viewport rectangle in capture pixels, rounded outward to
 * whole pixels and clamped to the capture.
 */
export const captureCrop = (rect: Rect, devicePixelRatio: number, capture: CaptureSize): Rect => {
  const scale = devicePixelRatio > 0 && Number.isFinite(devicePixelRatio) ? devicePixelRatio : 1;
  const x0 = clamp(Math.floor(rect.x * scale), 0, capture.width);
  const y0 = clamp(Math.floor(rect.y * scale), 0, capture.height);
  const x1 = clamp(Math.ceil((rect.x + rect.w) * scale), 0, capture.width);
  const y1 = clamp(Math.ceil((rect.y + rect.h) * scale), 0, capture.height);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
};

/** Pure: a drag over a page still, as the box a comment anchors to. */
export const pageBoxOf = (from: Point, to: Point, viewport: PageViewport, capture: CaptureSize): PageBoxResult => {
  const rect = dragRect(from, to, viewport);
  if (rect.w < PAGE_BOX_MIN_CSS_PX || rect.h < PAGE_BOX_MIN_CSS_PX) {
    return { ok: false, refusal: { kind: "too_small", min: PAGE_BOX_MIN_CSS_PX } };
  }
  return {
    ok: true,
    box: {
      rect: toPageRect(rect, viewport.scroll),
      scroll: viewport.scroll,
      crop: captureCrop(rect, viewport.devicePixelRatio, capture),
    },
  };
};

/**
 * Where a stored box sits in the viewport now, for drawing it back over the
 * live page; undefined when it is scrolled fully out of view.
 */
export const viewportRectOf = (rect: Rect, viewport: Pick<PageViewport, "width" | "height" | "scroll">): Rect | undefined => {
  const x = rect.x - viewport.scroll.x;
  const y = rect.y - viewport.scroll.y;
  if (x + rect.w <= 0 || y + rect.h <= 0 || x >= viewport.width || y >= viewport.height) return undefined;
  return { x, y, w: rect.w, h: rect.h };
};
