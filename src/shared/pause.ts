import type { CanvasDoc } from "./canvas";
import { groupMembers } from "./graph";

// Factory pause plane — pure law. The switch state itself is app-state
// (never the document; see pause-plane in main): definitions travel with
// the file, the switch that lets the factory act exists only in the
// running app, flipped by a human.
//
// LAW: a canvas with no recorded play decision is PAUSED. The factory is
// born paused, always; the first play is an explicit operator confirmation.

export type CanvasPauseState = {
  /** false = paused. Absence of a record decodes to false — paused. */
  readonly playing: boolean;
  /** Latch for the first-play confirmation. */
  readonly everPlayed: boolean;
  readonly pausedNodes: ReadonlyArray<string>;
  readonly pausedRegions: ReadonlyArray<string>;
};

/** The born-paused default: not playing, never played, nothing overridden. */
export const PAUSED_CANVAS: CanvasPauseState = {
  playing: false,
  everPlayed: false,
  pausedNodes: [],
  pausedRegions: [],
};

export type PauseScope =
  | { readonly kind: "canvas" }
  | { readonly kind: "node"; readonly id: string }
  | { readonly kind: "region"; readonly id: string };

/** Region ids (group nodes) whose membership contains `nodeId`. */
export const regionsContaining = (
  doc: CanvasDoc,
  nodeId: string,
): ReadonlyArray<string> => {
  const out: string[] = [];
  for (const [regionId, memberIds] of groupMembers(doc)) {
    if (memberIds.includes(nodeId)) out.push(regionId);
  }
  return out;
};

/**
 * Effective pause for a seat: canvas paused OR the node paused OR any
 * containing region paused. Fail closed — an unknown canvas is paused.
 */
export const seatPaused = (
  state: CanvasPauseState,
  doc: CanvasDoc,
  nodeId: string,
): boolean => {
  if (!state.playing) return true;
  if (state.pausedNodes.includes(nodeId)) return true;
  if (state.pausedRegions.length === 0) return false;
  return regionsContaining(doc, nodeId).some((regionId) =>
    state.pausedRegions.includes(regionId),
  );
};
