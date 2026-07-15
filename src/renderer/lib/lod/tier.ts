import type { LodTier } from "./types";

// Tier selection with hysteresis. The whole point of the enter/exit split is
// that a tier boundary is never a single zoom value — crossing DOWN into a
// coarser tier happens at a lower zoom than crossing back UP into a finer one,
// so a viewport hovering exactly on a boundary can never flicker between two
// tiers frame to frame.
//
// Zoom is the React Flow viewport scale: a `w`-wide node renders `w * zoom`
// screen pixels. Small entity cards (~240px, 12px type) stop being legible
// around 0.42 — that is where regions collapse to emblems. Region emblems
// (~216px) themselves stop reading around 0.22 — that is where they cluster.

export interface TierThresholds {
  // near ↔ mid boundary
  readonly enterMid: number; // zoom ≤ enterMid while near → mid
  readonly exitMid: number; // zoom ≥ exitMid while mid → near
  // mid ↔ far boundary
  readonly enterFar: number; // zoom ≤ enterFar while mid → far
  readonly exitFar: number; // zoom ≥ exitFar while far → mid
}

export const DEFAULT_THRESHOLDS: TierThresholds = {
  enterMid: 0.42,
  exitMid: 0.52,
  enterFar: 0.22,
  exitFar: 0.3,
};

// Given the current tier and a fresh zoom, return the tier the viewport should
// now be in. Pure and allocation-free — called on every `onMove` frame, but it
// only ever *changes* its answer when a hysteresis band is fully crossed, so
// the caller sets React state (and recomputes the projection) rarely.
export const selectTier = (
  zoom: number,
  current: LodTier,
  t: TierThresholds = DEFAULT_THRESHOLDS,
): LodTier => {
  switch (current) {
    case "near":
      // Only leave near once past the mid-enter floor; a further drop can skip
      // straight to far so a fast zoom-out lands where the zoom says, not one
      // tier short.
      if (zoom <= t.enterFar) return "far";
      if (zoom <= t.enterMid) return "mid";
      return "near";
    case "mid":
      if (zoom >= t.exitMid) return "near";
      if (zoom <= t.enterFar) return "far";
      return "mid";
    case "far":
      // Symmetric skip: a fast zoom-in from far can land straight in near.
      if (zoom >= t.exitMid) return "near";
      if (zoom >= t.exitFar) return "mid";
      return "far";
  }
};

// The zoom the boundary sits at when crossing a given direction — used by the
// dive-in interactions so a click lands safely inside the target tier's band
// rather than on its flickering edge.
export const NEAR_LANDING_ZOOM = 0.9; // comfortably inside near
export const MID_LANDING_ZOOM = 0.4; // comfortably inside mid
