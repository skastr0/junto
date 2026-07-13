import type { EdgeProps, EdgeTypes } from "@xyflow/react";
import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath } from "@xyflow/react";
import type { FlowEdge } from "../../lib/convert";
import { cycleEdgeKind } from "../../lib/edge-mutations";
import { accentColor, EDGE_COLOR } from "../../lib/theme";

export function EtherEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  markerEnd,
}: EdgeProps<FlowEdge>) {
  const kind = data?.edge.ether?.kind ?? "relates";
  const label = data?.edge.label ?? kind;
  const rippling = data?.rippling ?? false;
  const color = data?.edge.color ? accentColor(data.edge.color) : EDGE_COLOR[kind];

  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: 8,
  });

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        className={rippling ? "vellum-edge-ripple" : undefined}
        style={{
          stroke: color,
          strokeWidth: 1.2,
          opacity: kind === "relates" ? 0.55 : 0.85,
        }}
      />
      <EdgeLabelRenderer>
        <button
          aria-label={`Cycle ${kind} edge kind`}
          className="nodrag nopan vellum-edge-label"
          style={{ top: labelY, left: labelX }}
          title="cycle edge kind"
          onClick={(e) => {
            e.stopPropagation();
            cycleEdgeKind(id);
          }}
        >
          {label}
        </button>
      </EdgeLabelRenderer>
    </>
  );
}

export const edgeTypes: EdgeTypes = {
  ether: EtherEdge,
};
