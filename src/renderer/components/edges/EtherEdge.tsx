import type { EdgeProps, EdgeTypes } from "@xyflow/react";
import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath } from "@xyflow/react";
import { use$ } from "@legendapp/state/react";
import type { FlowEdge } from "../../lib/convert";
import { loomRoutes$, loomStrands$ } from "../../lib/loom-view";
import { LANE_GAP, stitchStrand } from "../../lib/wire-loom";
import { selectEdge } from "../../lib/state";
import { EDGE_COLOR } from "../../lib/theme";

/**
 * One stroke for every wire: a solid hairline whose only variable is hue.
 *
 * Weight, dash, halo, and travelling light all used to encode something — wire
 * family, worded config, live traffic — and stacked into a picture that had to
 * be decoded rather than read. A verb already says what the relationship is, so
 * the paint carries exactly one fact: which verb, in the verb's own colour.
 * State (stoppage) and selection stay structural — crimson and opacity — and
 * never mint a second stroke.
 */
const WIRE_WIDTH = 1.2;
const WIRE_OPACITY = 0.9;
/** No verb means no relationship compiled: draw it, quietly, in neutral ink. */
const UNSET_COLOR = "var(--wire-verb-unset)";

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
  const phase = data?.phase ?? "relates";
  const detail = data?.detail ?? "";
  const rippling = data?.rippling ?? false;
  const blocked = phase === "blocks" || rippling;

  // PERF-P2: edge-local keys only — never full obstacle/corridor arrays.
  const strand = use$(loomStrands$[id]);
  const plannedRoute = use$(loomRoutes$[id]);

  // Verb hue, stamped at convert. Stoppage is the one fact allowed to take a
  // wire off its verb colour, because on this canvas crimson means blocked.
  const token = data?.colorToken;
  const color = blocked
    ? EDGE_COLOR.blocks
    : token
      ? `var(${token})`
      : UNSET_COLOR;

  // Selection impact mode — only "in" is stamped (CSS dims the rest).
  const impactIn = data?.impact === "in";

  // Bundled fan member: lane geometry planned once, stitched against live ends.
  const stitched = strand
    ? stitchStrand(strand, { sourceX, sourceY, targetX, targetY })
    : null;

  const [fallbackPath, fallbackLabelX, fallbackLabelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: 8,
  });

  // Standalone route is planned once at CanvasLoom — no per-edge routeWire.
  const path = stitched?.path ?? plannedRoute?.path ?? fallbackPath;
  const labelX = stitched?.labelX ?? plannedRoute?.labelX ?? fallbackLabelX;
  const labelY = stitched?.labelY ?? plannedRoute?.labelY ?? fallbackLabelY;

  const className = ["vellum-edge", rippling ? "vellum-edge-ripple" : ""]
    .filter(Boolean)
    .join(" ");

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        className={className}
        // The 20px default straddles six neighbours at 3px lane spacing; the
        // tail label button stays the reliable strand-level hit target.
        interactionWidth={stitched ? LANE_GAP : undefined}
        style={{
          stroke: color,
          strokeWidth: WIRE_WIDTH,
          opacity: impactIn ? 1 : WIRE_OPACITY,
        }}
      />
      <EdgeLabelRenderer>
        {/* Edge faces are silent by design: the relationship reads through
            stroke colour, node attention states, and the stoppage rank;
            details live in the edge inspector on selection. This midpoint
            target only aids clicking (paths already select) and screen
            readers. */}
        <button
          type="button"
          aria-label={
            detail
              ? `Select edge - ${phase} - ${detail}`
              : `Select edge - ${phase}`
          }
          className="nodrag nopan vellum-edge-label vellum-edge-label--silent"
          style={{
            top: labelY,
            left: labelX,
            opacity: 0,
            width: 14,
            height: 14,
            padding: 0,
          }}
          onClick={(e) => {
            e.stopPropagation();
            selectEdge(id);
          }}
        />
      </EdgeLabelRenderer>
    </>
  );
}

export const edgeTypes: EdgeTypes = {
  ether: EtherEdge,
};
