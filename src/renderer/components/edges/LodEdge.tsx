import type { EdgeProps, Node } from "@xyflow/react";
import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath } from "@xyflow/react";
import type { LodBundleEdgeData } from "../../lib/lod/flow-types";
import { EDGE_COLOR, withAlpha } from "../../lib/theme";

// A bundled cross-boundary edge at a collapsed tier. Quiet by design — a thin
// line coloured by the bundle's dominant kind, with a small count pill only
// when more than one document edge folded into it. Never interactive: at these
// tiers you dive in to touch the real edges.
export function LodEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data }: EdgeProps) {
  const bundle = data as LodBundleEdgeData | undefined;
  const kind = bundle?.kind ?? "relates";
  const count = bundle?.count ?? 1;
  const color = EDGE_COLOR[kind];
  const [path, labelX, labelY] = getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, borderRadius: 10 });
  return (
    <>
      <BaseEdge id={id} path={path} style={{ stroke: color, strokeWidth: kind === "blocks" ? 1.4 : 1.1, opacity: kind === "relates" ? 0.34 : 0.55 }} />
      {count > 1 ? (
        <EdgeLabelRenderer>
          <div
            className="vellum-lod-bundle-count nodrag nopan tabular-nums"
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: "none",
              padding: "1px 5px",
              borderRadius: 999,
              fontSize: 9,
              letterSpacing: "0.04em",
              color,
              border: `1px solid ${withAlpha(color, 0.4)}`,
              background: "rgba(13,12,11,0.9)",
            }}
          >
            {count}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}
