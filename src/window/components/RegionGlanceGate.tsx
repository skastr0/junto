import { useEffect } from "react";
import { useStoreApi } from "@xyflow/react";
import { observe } from "@legendapp/state";
import { cameraSettled$ } from "../lib/canvas-tier";
import { publishRegionGlance } from "../lib/region-glance";

/**
 * Publishes the region-glance opacity for the camera's zoom onto the ReactFlow
 * root, where every region body inherits it. Renders nothing and never
 * re-renders on zoom — the value travels as a CSS custom property, not React
 * state.
 *
 * Both opacities are inherited by every region, so they are held through a
 * zoom gesture and written when the camera rests (cameraSettled$): a watermark
 * is not worth restyling the board on every frame, and it is read once the
 * camera has stopped anyway. The rest count is raised by CanvasTierGate after
 * it publishes the scales; both write in the same task, so the board pays one
 * restyle, not two.
 *
 * Listens to the store's transform directly. `useOnViewportChange` is a single
 * slot in the store (the last hook to render owns it), and the tier gate and
 * the magnifier both want it: sharing it left the glance stale, with nested
 * names inked and outer names blank at the minimum zoom.
 *
 * Must be mounted inside <ReactFlow> so the store (and its `domNode`) resolve.
 */
export function RegionGlanceGate() {
  const store = useStoreApi();
  useEffect(() => {
    // Initial paint: the camera is already placed by fitView before any move fires.
    publishRegionGlance(store.getState().domNode, store.getState().transform[2]);
    return observe(cameraSettled$, () => {
      const state = store.getState();
      publishRegionGlance(state.domNode, state.transform[2]);
    });
  }, [store]);
  return null;
}
