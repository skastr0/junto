import { useEffect } from "react";
import { useStoreApi } from "@xyflow/react";
import { clearCanvasTier, publishCanvasTier } from "../lib/canvas-tier";

/**
 * Publishes the canvas level-of-detail tier for the camera zoom (canvas-tier.ts).
 * Renders nothing and never re-renders on zoom: the tier travels as an
 * attribute on <html> and an observable.
 *
 * Listens to the store's transform directly rather than through
 * `useOnViewportChange`, whose handler is a single slot shared with the region
 * glance and the magnifier (see RegionGlanceGate).
 *
 * Must be mounted inside <ReactFlow> so the store resolves.
 */
export function CanvasTierGate() {
  const store = useStoreApi();
  useEffect(() => {
    let zoom = store.getState().transform[2];
    publishCanvasTier(zoom);
    const unsubscribe = store.subscribe((state) => {
      if (state.transform[2] === zoom) return;
      zoom = state.transform[2];
      publishCanvasTier(zoom);
    });
    return () => {
      unsubscribe();
      clearCanvasTier();
    };
  }, [store]);
  return null;
}
