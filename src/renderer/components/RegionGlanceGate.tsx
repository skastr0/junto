import { useEffect } from "react";
import { useStoreApi } from "@xyflow/react";
import { publishRegionGlance } from "../lib/region-glance";

/**
 * Publishes the region-glance opacity for the current zoom onto the ReactFlow
 * root, where every region body inherits it. Renders nothing and never re-renders
 * on zoom — the value travels as a CSS custom property, not React state.
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
    let zoom = store.getState().transform[2];
    // Initial paint: the camera is already placed by fitView before any move fires.
    publishRegionGlance(store.getState().domNode, zoom);
    return store.subscribe((state) => {
      if (state.transform[2] === zoom) return;
      zoom = state.transform[2];
      publishRegionGlance(state.domNode, zoom);
    });
  }, [store]);
  return null;
}
