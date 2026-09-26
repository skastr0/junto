import { useEffect } from "react";
import { useOnViewportChange, useStoreApi } from "@xyflow/react";
import { clearCanvasTier, publishCanvasTier } from "../lib/canvas-tier";

/**
 * Publishes the canvas level-of-detail tier for the camera zoom (canvas-tier.ts).
 * Renders nothing and never re-renders on zoom: the tier travels as an
 * attribute on <html> and an observable.
 *
 * Must be mounted inside <ReactFlow> so the store resolves.
 */
export function CanvasTierGate() {
  const store = useStoreApi();
  useEffect(() => {
    publishCanvasTier(store.getState().transform[2]);
    return clearCanvasTier;
  }, [store]);
  useOnViewportChange({ onChange: ({ zoom }) => publishCanvasTier(zoom) });
  return null;
}
