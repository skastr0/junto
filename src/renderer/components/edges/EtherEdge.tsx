import type { EdgeProps, EdgeTypes } from "@xyflow/react";
import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath } from "@xyflow/react";
import type { FlowEdge } from "../../lib/convert";
import { state$ } from "../../lib/state";
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
  const phase = data?.phase ?? data?.edge.ether?.kind ?? "relates";
  const detail = data?.detail ?? "";
  const hasCriteria = Boolean(data?.edge.ether?.criteria);
  const rippling = data?.rippling ?? false;
  // Prefer live phase palette; only honor non-mirror accents (not stuck "1").
  const color =
    data?.edge.color && data.edge.color !== "1"
      ? accentColor(data.edge.color)
      : EDGE_COLOR[phase];

  // Selection impact mode — only "in" is stamped (CSS dims the rest).
  const impactIn = data?.impact === "in";

  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: 8,
  });

  const baseWidth = phase === "blocks" || rippling ? 1.6 : 1.2;
  const baseOpacity = phase === "relates" && !hasCriteria ? 0.55 : 0.9;

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        className={[
          rippling ? "vellum-edge-ripple" : "",
          impactIn ? "vellum-edge-impact-in" : "",
        ]
          .filter(Boolean)
          .join(" ") || undefined}
        style={{
          stroke: color,
          strokeWidth: impactIn ? Math.max(baseWidth, 2.1) : baseWidth,
          opacity: impactIn ? 1 : baseOpacity,
        }}
      />
      <EdgeLabelRenderer>
        {/* Edge faces are silent by design: phase reads through stroke color,
            node attention states, and the stoppage rank; details live in the
            edge inspector on selection. This midpoint target only aids
            clicking (paths already select) and screen readers. */}
        <button
          type="button"
          aria-label={detail ? `Select edge · ${phase} · ${detail}` : `Select edge · ${phase}`}
          className="nodrag nopan vellum-edge-label vellum-edge-label--silent"
          style={{ top: labelY, left: labelX, opacity: 0, width: 14, height: 14, padding: 0 }}
          onClick={(e) => {
            e.stopPropagation();
            state$.selectedNodeId.set("");
            state$.selectedEdgeId.set(id);
          }}
        />
      </EdgeLabelRenderer>
    </>
  );
}

export const edgeTypes: EdgeTypes = {
  ether: EtherEdge,
};
