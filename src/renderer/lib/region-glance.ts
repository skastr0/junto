// Region glance — readable canvas when the camera pulls back.
//
// Zoomed out, node cards collapse into rings and blocks and the small region
// label strip is unreadable, so the operator sees shapes with no names. Each
// region prints its own name across its body as a large watermark, once the
// camera is far enough back that the title bar stops reading:
//
//   close in            cards are legible, no watermark at all
//   pulled back a step  nested regions name themselves; the outer plate is
//                       still large enough to read by its own label strip
//   pulled back far     every region names itself, outer and nested
//
// Names never overlap: each prints in the clear ground of its own region,
// outside the regions nested in it (region-name-slot.ts), so a nested name and
// its parent's can share the screen.
//
// Opacity is published as CSS custom properties on the ReactFlow root instead of
// React state: zoom changes every animation frame during a wheel burst, and
// that path stays free of React work.

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

import { FEED_KIND_LABEL } from "@shared/operator-feed";

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
 * Nested regions: one band closer in (a nested plate's title bar stops reading
 * sooner), and inked from there all the way out. Its name sits clear of its
 * parent's, so the two bands may overlap.
 */
export const SUBREGION_BAND: GlanceBand = {
  rise: 1.05,
  peak: 0.86,
  hold: 0,
  fall: 0,
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

/** Member tallies of one region, as region rollups count them. */
export type RegionTally = {
  readonly total: number;
  readonly blocked: number;
  readonly attention: number;
  readonly working: number;
  readonly ready: number;
};

/** One phrase of a region's member tally (the command bar), in the hue of what it counts. */
export type RegionTallyPart = {
  readonly tone: "crimson" | "amber" | "cyan" | "green" | "steel";
  readonly text: string;
};

/**
 * What a region says about its members (the command bar's region row), worst first:
 * only the states that are present, so a quiet region reads as one word. The
 * attention phrase is the feed's own name for it (FEED_KIND_LABEL).
 */
export const regionTallyParts = (tally: RegionTally | undefined): readonly RegionTallyPart[] => {
  if (tally === undefined || tally.total === 0) return [];
  const parts: RegionTallyPart[] = [];
  if (tally.blocked > 0) parts.push({ tone: "crimson", text: `${String(tally.blocked)} blocked` });
  if (tally.attention > 0) parts.push({ tone: "amber", text: `${String(tally.attention)} ${FEED_KIND_LABEL.attention}` });
  if (tally.working > 0) parts.push({ tone: "cyan", text: `${String(tally.working)} working` });
  if (tally.ready > 0) parts.push({ tone: "green", text: `${String(tally.ready)} done` });
  if (parts.length === 0) parts.push({ tone: "steel", text: tally.total === 1 ? "1 idle" : `${String(tally.total)} idle` });
  return parts;
};
