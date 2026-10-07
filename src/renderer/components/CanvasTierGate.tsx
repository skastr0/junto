import { useEffect } from "react";
import { useStoreApi } from "@xyflow/react";
import { CAMERA_SETTLE_MS, cameraSettled$, clearCanvasTier, publishCanvasTier, publishFarSeatScale } from "../lib/canvas-tier";

/**
 * Publishes the canvas level-of-detail tier for the camera zoom (canvas-tier.ts),
 * and the scale that holds a far seat's ring at its screen floor. Renders
 * nothing and never re-renders on zoom: the tier travels as an attribute on
 * <html> and an observable, the scale as a custom property on the ReactFlow
 * root, written only when its rounded value changes.
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
    publishFarSeatScale(store.getState().domNode, zoom);
    let [x, y] = store.getState().transform;
    let settle: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = store.subscribe((state) => {
      if (state.transform[0] !== x || state.transform[1] !== y || state.transform[2] !== zoom) {
        [x, y] = state.transform;
        // One count when the camera rests (cameraSettled$), never one a frame.
        clearTimeout(settle);
        settle = setTimeout(() => cameraSettled$.set(cameraSettled$.peek() + 1), CAMERA_SETTLE_MS);
      }
      if (state.transform[2] === zoom) return;
      zoom = state.transform[2];
      publishCanvasTier(zoom);
      publishFarSeatScale(state.domNode, zoom);
    });
    return () => {
      unsubscribe();
      clearTimeout(settle);
      clearCanvasTier();
    };
  }, [store]);
  return null;
}
