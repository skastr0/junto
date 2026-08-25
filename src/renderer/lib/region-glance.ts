// Region glance — readable canvas when the camera pulls back.
//
// Zoomed out, node cards collapse into colored rectangles and the small region
// label strip is unreadable, so the operator sees shapes with no names. Below
// GLANCE_START each region prints its own name across its body as a large,
// quiet watermark; the ramp reaches full ink at GLANCE_FULL.
//
// Opacity is published as a CSS custom property on the ReactFlow root instead
// of React state: zoom changes every animation frame during a wheel burst, and
// the canvas already keeps that path free of React work (see viewport-busy).

/** Zoom at or above which cards are readable — no watermark at all. */
export const GLANCE_START = 0.62;
/** Zoom at or below which the watermark is fully inked. */
export const GLANCE_FULL = 0.34;
/** Inherited custom property every region body reads for its watermark. */
export const GLANCE_VAR = "--vellum-region-glance";

/** Quantization step — keeps per-frame style writes coarse but visually smooth. */
const STEP = 0.04;

/**
 * Watermark opacity for a camera zoom: 0 while cards are legible, ramping to 1
 * as the camera pulls back past GLANCE_FULL. Quantized so a zoom sweep writes
 * ~25 distinct values rather than one per frame.
 */
export const regionGlanceOpacity = (zoom: number): number => {
  if (!Number.isFinite(zoom)) return 0;
  if (zoom >= GLANCE_START) return 0;
  if (zoom <= GLANCE_FULL) return 1;
  const ramp = (GLANCE_START - zoom) / (GLANCE_START - GLANCE_FULL);
  return Math.round(ramp / STEP) * STEP;
};

/** Share of the region's height a single-line nameplate may occupy. */
const HEIGHT_SHARE = 0.4;
/** Share of the region's width the nameplate fits inside. */
const WIDTH_SHARE = 0.86;
/** Advance width of one uppercase condensed glyph, letter-spacing included. */
const GLYPH_RATIO = 0.68;
const MIN_PX = 22;
const MAX_PX = 240;

/**
 * Flow-space font size for a region nameplate: the largest single line that fits
 * the plate's width and stays inside its height share. Sized from the region's
 * own box (not the viewport) so the name grows with the plate and shrinks with
 * long labels, and so zooming never re-measures anything.
 */
export const regionGlanceFontSize = (
  width: number,
  height: number,
  label: string,
): number => {
  const chars = Math.max(label.trim().length, 3);
  const byWidth = (width * WIDTH_SHARE) / (chars * GLYPH_RATIO);
  const byHeight = height * HEIGHT_SHARE;
  const fit = Math.min(byWidth, byHeight);
  if (!Number.isFinite(fit)) return MIN_PX;
  return Math.round(Math.min(Math.max(fit, MIN_PX), MAX_PX));
};

/**
 * Write the glance opacity onto `host` (the ReactFlow root, an ancestor of every
 * region body). Returns true when the property actually changed, so callers can
 * skip redundant writes during a gesture.
 */
export const publishRegionGlance = (host: HTMLElement | null, zoom: number): boolean => {
  if (host === null) return false;
  const next = regionGlanceOpacity(zoom);
  const text = next === 0 ? "0" : next.toFixed(2);
  if (host.style.getPropertyValue(GLANCE_VAR) === text) return false;
  host.style.setProperty(GLANCE_VAR, text);
  return true;
};
