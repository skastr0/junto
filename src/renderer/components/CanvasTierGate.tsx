import { useEffect } from "react";
import { useStoreApi } from "@xyflow/react";
import { CAMERA_SETTLE_MS, cameraSettled$, clearCanvasTier, publishCanvasTier, publishFarSeatScale } from "../lib/canvas-tier";

/**
 * Publishes the canvas level-of-detail tier for the camera zoom (canvas-tier.ts),
 * and the three scales the far and overview tiers draw a seat ring by: the far
 * scale, the overview floor and the inverse zoom instruments are sized with.
 * Renders nothing and never re-renders on zoom: the tier travels as an
 * attribute on <html> and an observable, the scales as custom properties on the
 * ReactFlow root.
 *
 * The tier keeps up with the camera frame by frame: it crosses only at a
 * boundary (a handful of writes in a sweep) and the detail under the
 * operator's hand has to be true. The scales cannot: each one is inherited by
 * every node, so a write restyled the whole board, and sizes drawn from
 * --node-s laid it out again. A zoom sweep wrote them 29 to 83 times on the
 * operator's board. They are held through the gesture and published once the
 * camera rests (cameraSettled$): one write per property per gesture, and the
 * ring's size eases onto the screen on the compositor (canvas-lod.css).
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
        // One rest when the camera stops (cameraSettled$), never one a frame.
        // The scales are published before the count is raised, so the glance
        // (RegionGlanceGate) writes in the same task and the board restyles
        // once.
        clearTimeout(settle);
        settle = setTimeout(() => {
          const rested = store.getState();
          publishFarSeatScale(rested.domNode, rested.transform[2]);
          cameraSettled$.set(cameraSettled$.peek() + 1);
        }, CAMERA_SETTLE_MS);
      }
      if (state.transform[2] === zoom) return;
      zoom = state.transform[2];
      publishCanvasTier(zoom);
    });
    return () => {
      unsubscribe();
      clearTimeout(settle);
      clearCanvasTier();
    };
  }, [store]);
  return null;
}
