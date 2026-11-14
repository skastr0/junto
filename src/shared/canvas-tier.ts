/**
 * Canvas level of detail, the pure part (docs/canvas-gpu-architecture.md,
 * section 11). The GPU canvas engine imports this and only this for tiers; the
 * React canvas's `canvas-tier.ts` re-exports it, so the two canvases cannot
 * disagree about a threshold, a scale or a rounding step. Nothing here reads
 * the document or an observable.
 */

export type CanvasTier = "near" | "mid" | "far" | "overview";

const ORDER: readonly CanvasTier[] = ["near", "mid", "far", "overview"];

/** Zoom at or above which cards read: region glance starts below it. */
export const TIER_NEAR_MIN = 0.62;
/**
 * Zoom at or above which a seat keeps its compact mid pill. Below it the ring
 * is held at far size: a 13px name at 0.34 is 4.4px on screen, unreadable,
 * while the 40px portrait and ring still read. The operator's live QA found
 * the old 0.34 boundary doing exactly that.
 */
export const TIER_MID_MIN = 0.46;
/** Below this the board is regions. */
export const TIER_FAR_MIN = 0.2;
/** A boundary must be passed by this much zoom before the tier changes. */
export const TIER_HYSTERESIS = 0.03;

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

/** Screen diameter a far seat's ring is held at, when its neighbours leave room. */
export const FAR_RING_SCREEN_PX = 40;
/** The seat ring's own diameter (node-geometry.ts SEAT_RING_PX). */
export const SEAT_RING_UNITS = 52;
/** The largest scale a ring is drawn at: FAR_RING_SCREEN_PX at the camera's minimum zoom (0.15). */
export const SEAT_SCALE_MAX = 5.2;
/**
 * The smallest a seat ring is drawn at the overview, on screen: a crowded
 * ring shrinks to this before its seat gathers into a cluster
 * (seat-clusters.ts SEAT_FLOOR_SCREEN_PX).
 */
export const OVERVIEW_RING_FLOOR_PX = 22;

/**
 * Steps a scale is rounded up to. Tenths, not halves: the ring must never be
 * more than 2px over its screen floor (seat-ring-room.test.ts), and at the
 * far tier's closest zoom 40 + 2px leaves room for a step of only about 0.09.
 * A coarser step bought fewer whole-board restyles but broke that bound.
 */
const SCALE_STEP = 0.1;

const scaleFor = (screenPx: number, zoom: number, floor: number): number => {
  if (!Number.isFinite(zoom) || zoom <= 0) return floor;
  const exact = screenPx / (SEAT_RING_UNITS * zoom);
  return Math.min(SEAT_SCALE_MAX, Math.max(floor, Math.ceil(exact / SCALE_STEP) * SCALE_STEP));
};

/**
 * The scale that draws a 52-unit seat ring FAR_RING_SCREEN_PX across at this
 * zoom, rounded up to a tenth so the ring never passes its screen floor.
 * Never below the 1.75 a ring is drawn at before the floor bites, never above
 * SEAT_SCALE_MAX.
 */
export const farSeatScale = (zoom: number): number => scaleFor(FAR_RING_SCREEN_PX, zoom, 1.75);

/** The scale that draws a seat ring OVERVIEW_RING_FLOOR_PX across at this zoom. */
export const seatFloorScale = (zoom: number): number => scaleFor(OVERVIEW_RING_FLOOR_PX, zoom, 1);

/** The largest node scale: the inverse of the camera's minimum zoom (0.15). */
const NODE_SCALE_MAX = 6.7;

/** The inverse zoom, rounded up to a tenth like the seat scales, between 1 and NODE_SCALE_MAX. */
export const nodeScale = (zoom: number): number => {
  if (!Number.isFinite(zoom) || zoom <= 0) return 1;
  return Math.min(NODE_SCALE_MAX, Math.max(1, Math.ceil((1 / zoom) * 10) / 10));
};

/**
 * The hovered card blooms to a fixed 172.8 screen px (216 board at 0.8), so
 * its near-detail words stay about 10px on screen at every mid and far zoom.
 * The scale is clamped so a near card barely grows and an overview card does
 * not become a giant; the camera's own zoom supplies the rest.
 */
export const HOVER_CARD_SCALE_MIN = 1.1;
export const HOVER_CARD_SCALE_MAX = 2.8;
export const HOVER_CARD_TARGET_WIDTH = 172.8;
export const hoverCardScale = (zoom: number): number => {
  if (!Number.isFinite(zoom) || zoom <= 0) return HOVER_CARD_SCALE_MIN;
  return Math.min(HOVER_CARD_SCALE_MAX, Math.max(HOVER_CARD_SCALE_MIN, HOVER_CARD_TARGET_WIDTH / (216 * zoom)));
};
