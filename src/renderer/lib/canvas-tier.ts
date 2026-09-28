// Canvas level of detail: which tier the camera is in.
//
// A pulled-back camera cannot read what a close one can, and a large board
// pays for every detail it still draws. The canvas renders in four tiers, by
// camera zoom:
//
//   near      full seats, preambles, card text
//   mid       ring and name; no lines, no bubbles
//   far       a seat is its portrait in its ring at a screen size; cards are
//             faint blocks with their kind's glyph
//   overview  regions and seats; crowded seats gather into clusters
//
// Rings move at every tier (attention-clock.ts): a seat moves wherever it is
// drawn. The tier is stamped on <html> as data-canvas-tier, so CSS switches
// the detail without a React render, and published as canvasTier$ for gates
// in script (seat clusters at the overview). Hysteresis: a boundary must be
// crossed by a margin before the tier flips, so a camera resting on a
// boundary never flaps.

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

/** Screen diameter a far seat's ring is held at, when its neighbours leave room. */
export const FAR_RING_SCREEN_PX = 40;
/** The seat ring's own diameter (node-geometry.ts SEAT_RING_PX). */
const SEAT_RING_UNITS = 52;
/** Custom property on the ReactFlow root that canvas-lod.css scales far rings by. */
export const FAR_SEAT_SCALE_VAR = "--far-seat-scale";

/** The largest scale a ring is drawn at: FAR_RING_SCREEN_PX at the camera's minimum zoom (0.15). */
export const SEAT_SCALE_MAX = 5.2;
/**
 * The smallest a seat ring is drawn at the overview, on screen: a crowded
 * ring shrinks to this before its seat gathers into a cluster
 * (seat-clusters.ts SEAT_FLOOR_SCREEN_PX).
 */
export const OVERVIEW_RING_FLOOR_PX = 22;
/** Custom property on the ReactFlow root: the scale that draws a seat ring at the overview floor. */
export const SEAT_FLOOR_SCALE_VAR = "--seat-floor-scale";

const scaleFor = (screenPx: number, zoom: number, floor: number): number => {
  if (!Number.isFinite(zoom) || zoom <= 0) return floor;
  const exact = screenPx / (SEAT_RING_UNITS * zoom);
  return Math.min(SEAT_SCALE_MAX, Math.max(floor, Math.ceil(exact * 10) / 10));
};

/**
 * The scale that draws a 52-unit seat ring FAR_RING_SCREEN_PX across at this
 * zoom, rounded up to a tenth so a zoom sweep writes a few dozen values, not
 * one per frame. Never below the 1.75 a ring is drawn at before the floor
 * bites, never above SEAT_SCALE_MAX.
 */
export const farSeatScale = (zoom: number): number => scaleFor(FAR_RING_SCREEN_PX, zoom, 1.75);

/** The scale that draws a seat ring OVERVIEW_RING_FLOOR_PX across at this zoom. */
export const seatFloorScale = (zoom: number): number => scaleFor(OVERVIEW_RING_FLOOR_PX, zoom, 1);

const writeScale = (host: HTMLElement, name: string, value: number): void => {
  const text = value.toFixed(1);
  if (host.style.getPropertyValue(name) !== text) host.style.setProperty(name, text);
};

/** Write the far seat scale and the overview floor on `host` (the ReactFlow root) when they change. */
export const publishFarSeatScale = (host: HTMLElement | null, zoom: number): void => {
  if (host === null) return;
  writeScale(host, FAR_SEAT_SCALE_VAR, farSeatScale(zoom));
  writeScale(host, SEAT_FLOOR_SCALE_VAR, seatFloorScale(zoom));
};
