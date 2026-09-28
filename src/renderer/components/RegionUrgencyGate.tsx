import { useEffect } from "react";
import { useStoreApi } from "@xyflow/react";
import type { FlowEdge, FlowNode } from "../lib/convert";
import { publishRegionUrgencies, regionUrgencies, regionUrgency$, seatUrgency$ } from "../lib/region-urgency";

/**
 * Publishes each region's urgency (region-urgency.ts) from its seats' own
 * urgency, the reading their rings draw: blocked, needs you or review,
 * direct or held in a nested region. GroupNode reads it per region, so a
 * change repaints only the regions whose urgency moved. Renders nothing.
 *
 * Recomputes when a seat's urgency changes or the node set does (a seat moved
 * between regions); the work is over urgent seats only.
 *
 * Must be mounted inside <ReactFlow>.
 */
export function RegionUrgencyGate() {
  const store = useStoreApi<FlowNode, FlowEdge>();

  useEffect(() => {
    // Subscribed, not rendered: seatUrgency$ changes key by key in place.
    const compute = (): void => {
      const { nodeLookup } = store.getState();
      publishRegionUrgencies(
        regionUrgencies(
          Object.entries(seatUrgency$.peek()).map(([id, urgency]) => ({ id, urgency })),
          (id) => nodeLookup.get(id)?.data.seatRegion,
          (id) => nodeLookup.get(id)?.data.parentRegion,
        ),
      );
    };
    compute();
    const offSeats = seatUrgency$.onChange(compute);
    let nodes = store.getState().nodes;
    const offNodes = store.subscribe((state) => {
      if (state.nodes === nodes) return;
      nodes = state.nodes;
      compute();
    });
    return () => {
      offSeats();
      offNodes();
      regionUrgency$.set({});
    };
  }, [store]);

  return null;
}
