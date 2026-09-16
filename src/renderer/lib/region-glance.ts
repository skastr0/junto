// Region glance — readable canvas when the camera pulls back.
//
// Zoomed out, node cards collapse into colored rectangles and the small region
// label strip is unreadable, so the operator sees shapes with no names. Each
// region prints its own name across its body as a large, quiet watermark, but
// only inside the zoom band where that region is the useful unit of navigation:
//
//   close in            cards are legible, no watermark at all
//   pulled back a step  nested regions name themselves; the outer plate is
//                       still large enough to read by its own label strip
//   pulled back far     nested names fade out, outer regions ink in
//
// The two bands are mutually exclusive by construction: the nested band falls
// back to zero at exactly the zoom where the outer band leaves zero, so a nested
// name never prints on top of its parent's name.
//
// Opacity is published as CSS custom properties on the ReactFlow root instead of
// React state: zoom changes every animation frame during a wheel burst, and the
// canvas already keeps that path free of React work (see viewport-busy).

/**
 * A watermark's zoom envelope, written as four stops in the order the camera
 * meets them while pulling back (descending zoom).
 *
 * `rise` -> `peak`  opacity ramps 0 to 1
 * `peak` -> `hold`  fully inked
 * `hold` -> `fall`  opacity ramps 1 back to 0
 * below `fall`      silent
 *
 * An outermost band sets `hold` and `fall` to 0: nothing outranks it, so once
 * inked it stays inked however far the camera pulls back.
 */
export type GlanceBand = {
  readonly rise: number;
  readonly peak: number;
  readonly hold: number;
  readonly fall: number;
};

/** Zoom at or above which cards are readable — no watermark at all. */
export const GLANCE_START = 0.62;
/** Zoom at or below which the outermost watermark is fully inked. */
export const GLANCE_FULL = 0.34;

/** Outermost regions: ink in as cards die, and stay inked all the way out. */
export const REGION_BAND: GlanceBand = {
  rise: GLANCE_START,
  peak: GLANCE_FULL,
  hold: 0,
  fall: 0,
};

/**
 * Nested regions: one band closer in, and gone by the time the outer band
 * starts. `fall` is GLANCE_START — the outer band's `rise` — which is what makes
 * the two mutually exclusive.
 */
export const SUBREGION_BAND: GlanceBand = {
  rise: 1.05,
  peak: 0.86,
  hold: 0.7,
  fall: GLANCE_START,
};

/** Inherited custom property an outermost region body reads for its watermark. */
export const GLANCE_VAR = "--junto-region-glance";
/** The same, for a region nested inside another. */
export const GLANCE_SUB_VAR = "--junto-region-glance-sub";

/** Quantization step — keeps per-frame style writes coarse but visually smooth. */
const STEP = 0.04;

const quantize = (value: number): number => Math.round(value / STEP) * STEP;

/**
 * Watermark opacity for a camera zoom under one band. Quantized so a zoom sweep
 * writes ~25 distinct values per band rather than one per frame.
 */
export const bandOpacity = (band: GlanceBand, zoom: number): number => {
  if (!Number.isFinite(zoom)) return 0;
  if (zoom >= band.rise) return 0;
  if (zoom > band.peak) return quantize((band.rise - zoom) / (band.rise - band.peak));
  if (zoom >= band.hold) return 1;
  if (zoom > band.fall) return quantize((zoom - band.fall) / (band.hold - band.fall));
  return 0;
};

/** Outermost-region opacity for a camera zoom. */
export const regionGlanceOpacity = (zoom: number): number => bandOpacity(REGION_BAND, zoom);

/** Nested-region opacity for a camera zoom. */
export const subregionGlanceOpacity = (zoom: number): number => bandOpacity(SUBREGION_BAND, zoom);

/** Share of the region's height a single-line nameplate may occupy. */
const HEIGHT_SHARE = 0.4;
/** Share of the region's width the nameplate fits inside. */
const WIDTH_SHARE = 0.86;
/** Advance width of one uppercase condensed glyph, letter-spacing included. */
const GLYPH_RATIO = 0.68;
const MIN_PX = 22;
const MAX_PX = 240;

/**
 * A nested plate is smaller and sits inside a parent that still shows its own
 * chrome, so its name takes a narrower share of the box and is allowed to go
 * smaller before it stops shrinking.
 */
const SUB_HEIGHT_SHARE = 0.3;
const SUB_WIDTH_SHARE = 0.78;
const SUB_MIN_PX = 13;

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
  nested = false,
): number => {
  const chars = Math.max(label.trim().length, 3);
  const byWidth = (width * (nested ? SUB_WIDTH_SHARE : WIDTH_SHARE)) / (chars * GLYPH_RATIO);
  const byHeight = height * (nested ? SUB_HEIGHT_SHARE : HEIGHT_SHARE);
  const floor = nested ? SUB_MIN_PX : MIN_PX;
  const fit = Math.min(byWidth, byHeight);
  if (!Number.isFinite(fit)) return floor;
  return Math.round(Math.min(Math.max(fit, floor), MAX_PX));
};

const writeVar = (host: HTMLElement, name: string, value: number): boolean => {
  const text = value === 0 ? "0" : value.toFixed(2);
  if (host.style.getPropertyValue(name) === text) return false;
  host.style.setProperty(name, text);
  return true;
};

/**
 * Write both glance opacities onto `host` (the ReactFlow root, an ancestor of
 * every region body). Returns true when either property actually changed, so
 * callers can skip redundant writes during a gesture.
 */
export const publishRegionGlance = (host: HTMLElement | null, zoom: number): boolean => {
  if (host === null) return false;
  const outer = writeVar(host, GLANCE_VAR, regionGlanceOpacity(zoom));
  const nested = writeVar(host, GLANCE_SUB_VAR, subregionGlanceOpacity(zoom));
  return outer || nested;
};
