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
  // Live phase is the label. For criteria edges show short detail when blocking.
  const label =
    hasCriteria && detail && phase === "blocks"
      ? `blocks · ${detail.length > 28 ? `${detail.slice(0, 26)}…` : detail}`
      : hasCriteria
        ? phase
        : (data?.edge.label ?? phase);
  const title = hasCriteria
    ? detail
      ? `${phase} · ${detail}`
      : `${phase} (live criteria)`
    : "soft relates · select to attach criteria";
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
        <button
          aria-label={`Select edge · ${phase}`}
          className={[
            "nodrag nopan vellum-edge-label",
            impactIn ? "vellum-edge-label--impact-in" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          style={{ top: labelY, left: labelX }}
          title={title}
          onClick={(e) => {
            e.stopPropagation();
            // Select for inspector — do not cycle kind (that was the old model).
            state$.selectedNodeId.set("");
            state$.selectedEdgeId.set(id);
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
