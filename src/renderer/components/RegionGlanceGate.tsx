import { useCallback, useEffect } from "react";
import { useOnViewportChange, useStoreApi } from "@xyflow/react";
import { publishRegionGlance } from "../lib/region-glance";

/**
 * Publishes the region-glance opacity for the current zoom onto the ReactFlow
 * root, where every region body inherits it. Renders nothing and never re-renders
 * on zoom — the value travels as a CSS custom property, not React state.
 *
 * Must be mounted inside <ReactFlow> so the store (and its `domNode`) resolve.
 */
export function RegionGlanceGate() {
  const store = useStoreApi();
  const publish = useCallback(
    (zoom: number) => {
      publishRegionGlance(store.getState().domNode, zoom);
    },
    [store],
  );
  // Initial paint: the camera is already placed by fitView before any move fires.
  useEffect(() => {
    publish(store.getState().transform[2]);
  }, [publish, store]);
  useOnViewportChange({ onChange: ({ zoom }) => publish(zoom) });
  return null;
}
