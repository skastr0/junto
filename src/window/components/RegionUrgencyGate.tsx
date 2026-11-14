import { useContext, useEffect } from "react";
import { use$ } from "@legendapp/state/react";
import { state$ } from "../lib/state";
import { WindowRuntimeContext } from "../rpc/runtime";
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
  // Undefined outside a runtime provider (tests): the feed then reads git
  // cards as "reading", the same as a card with no git window.
  const runtime = useContext(WindowRuntimeContext);
  useEffect(
    () => (canvasName === "" ? undefined : retainCanvasFeed(canvasName, undefined, runtime)),
    [canvasName, runtime],
  );
  return null;
}
