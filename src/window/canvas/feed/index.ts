/**
 * The canvas feed: every canvas-derived state the cards used to compute,
 * derived here from the stores with no card mounted (architecture §20).
 * Plain Legend-State `observe`/`onChange` only — no React. `retainCanvasFeed`
 * is refcount-free: each caller holds one retain and releases it on unmount.
 */
import { subscribeAgentSeatState } from "../../lib/agent-seat-state";
import { subscribeSeatAwareness } from "../../lib/seat-awareness";
import { subscribeSeatOffboard } from "../../lib/seat-offboard-state";
import { subscribeSeatOnboarding } from "../../lib/seat-onboarding";
import { regionRollupStore } from "../../lib/region-rollups";
import { startSeatTaskStore } from "../../lib/seat-tasks";
import { retainHealthClock } from "../../lib/thread-health";
import { modelStore } from "../../lib/use-model";
import { retainNodeChrome } from "./nodes";
import { retainRegionChrome } from "./regions";
import { retainSceneOps } from "./scene";
import { retainSeatSessions } from "./sessions";
import { retainSeatUrgency } from "./seats";
import { retainKindLive } from "./kinds";
import { retainWireRoutes } from "./loom";
import type { WindowRuntime } from "../../rpc/runtime";
import type { SceneOp } from "../contract";

export { readSeatRollups } from "./rollups";
export { retainSceneOps } from "./scene";
export { cardLive$, retainKindLive } from "./kinds";

/**
 * Derive and publish everything the open canvas's cards used to publish:
 * seat and node urgency, node status and spoken kinds, seat session
 * hydration, region severity/counts and region urgency, the kind/spine
 * live facts the card ops carry, and the loom's wire routes. `runtime` is
 * the window's Effect runtime for the git card's IPC read; without it git
 * cards read "reading". Returns the release.
 */
export const retainCanvasFeed = (
  canvasName: string,
  emit?: (ops: ReadonlyArray<SceneOp>) => void,
  runtime?: WindowRuntime,
): (() => void) => {
  if (canvasName === "") return () => undefined;
  const stops: Array<() => void> = [modelStore.open(canvasName)];
  // The stores the derivations read, subscribed once for the window: seat
  // events, awareness, onboarding and offboard progress, seat task indexes.
  subscribeAgentSeatState();
  subscribeSeatAwareness();
  subscribeSeatOnboarding();
  subscribeSeatOffboard();
  startSeatTaskStore();
  stops.push(retainHealthClock());
  stops.push(regionRollupStore.retain(canvasName));
  stops.push(retainSeatUrgency(canvasName));
  stops.push(retainSeatSessions(canvasName));
  stops.push(retainNodeChrome(canvasName));
  stops.push(retainKindLive(canvasName, runtime));
  stops.push(retainRegionChrome(canvasName));
  if (emit !== undefined) {
    // Scene ops first: the load carries the cards and wires the routes name.
    stops.push(retainSceneOps(canvasName, emit));
    stops.push(retainWireRoutes(canvasName, emit));
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const stop of stops.reverse()) stop();
  };
};
