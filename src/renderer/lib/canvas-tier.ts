// Canvas level of detail: which tier the camera is in.
//
// A pulled-back camera cannot read what a close one can, and a large board
// pays for every detail it still draws. The canvas renders in four tiers, by
// camera zoom:
//
//   near      full seats, rings in motion, preambles, card text
//   mid       ring (held in its state pose) and name; no lines, no bubbles
//   far       a seat is a disc in its state colour; cards are flat blocks
//   overview  regions carry the board
//
// The tier is stamped on <html> as data-canvas-tier, so CSS switches the
// detail without a React render, and published as canvasTier$ for gates in
// script (the attention clock). Hysteresis: a boundary must be crossed by a
// margin before the tier flips, so a camera resting on a boundary never flaps.

import { observable } from "@legendapp/state";

export type CanvasTier = "near" | "mid" | "far" | "overview";

const ORDER: readonly CanvasTier[] = ["near", "mid", "far", "overview"];

/** Zoom at or above which cards read: region glance starts below it. */
export const TIER_NEAR_MIN = 0.62;
/** Zoom at or above which a seat's ring and name still read (glance fully inked below). */
export const TIER_MID_MIN = 0.34;
/** Below this the board is regions. */
export const TIER_FAR_MIN = 0.2;
/** A boundary must be passed by this much zoom before the tier changes. */
export const TIER_HYSTERESIS = 0.03;

export const TIER_ATTR = "data-canvas-tier";

const tierAt = (zoom: number): CanvasTier =>
  zoom >= TIER_NEAR_MIN ? "near" : zoom >= TIER_MID_MIN ? "mid" : zoom >= TIER_FAR_MIN ? "far" : "overview";

/**
 * The tier for a zoom, given the tier the camera is in now. Moving to less
 * detail needs the zoom a margin below the boundary; moving back needs it a
 * margin above.
 */
export const tierForZoom = (zoom: number, previous?: CanvasTier): CanvasTier => {
  if (!Number.isFinite(zoom) || zoom <= 0) return previous ?? "near";
  if (previous === undefined) return tierAt(zoom);
  const now = ORDER.indexOf(previous);
  const lower = tierAt(zoom + TIER_HYSTERESIS);
  if (ORDER.indexOf(lower) > now) return lower;
  const higher = tierAt(zoom - TIER_HYSTERESIS);
  if (ORDER.indexOf(higher) < now) return higher;
  return previous;
};

/** True when the tier still draws motion (loops, landings, bubbles). */
export const tierMoves = (tier: CanvasTier): boolean => tier === "near";

export const canvasTier$ = observable<CanvasTier>("near");

/** Publish the camera zoom: stamps <html> and the observable when the tier changes. */
export const publishCanvasTier = (zoom: number): CanvasTier => {
  const next = tierForZoom(zoom, canvasTier$.peek());
  if (typeof document !== "undefined" && document.documentElement.getAttribute(TIER_ATTR) !== next) {
    document.documentElement.setAttribute(TIER_ATTR, next);
  }
  if (canvasTier$.peek() !== next) canvasTier$.set(next);
  return next;
};

/** The canvas unmounted: no tier, full detail anywhere else a mark is drawn. */
export const clearCanvasTier = (): void => {
  if (typeof document !== "undefined") document.documentElement.removeAttribute(TIER_ATTR);
  if (canvasTier$.peek() !== "near") canvasTier$.set("near");
};
