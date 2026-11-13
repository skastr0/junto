import { useEffect } from "react";
import { use$ } from "@legendapp/state/react";
import { state$ } from "../lib/state";
import { retainCanvasFeed } from "../canvas/feed";

/**
 * Mounts the canvas feed (src/window/canvas/feed): every canvas-derived state
 * the cards used to publish — seat and node urgency, node status, session
 * hydration, region severity/counts and region urgency — is derived there
 * from the stores, so it stays live with no card mounted. Renders nothing.
 *
 * Must be mounted inside <ReactFlow>.
 */
export function RegionUrgencyGate() {
  const canvasName = use$(state$.canvasName);
  useEffect(() => (canvasName === "" ? undefined : retainCanvasFeed(canvasName)), [canvasName]);
  return null;
}
