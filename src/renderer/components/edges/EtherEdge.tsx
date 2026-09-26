import type { EdgeProps, EdgeTypes } from "@xyflow/react";
import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath } from "@xyflow/react";
import { use$ } from "@legendapp/state/react";
import type { FlowEdge } from "../../lib/convert";
import { loomLanes$, loomRoutes$, loomStrands$ } from "../../lib/loom-view";
import { LANE_GAP, stitchStrand } from "../../lib/wire-loom";
import { selectEdge } from "../../lib/state";
import { EDGE_COLOR } from "../../lib/theme";
import { WIRE_PULSE_TOKEN, wirePulses$, wirePulseScheduler } from "../../lib/wire-pulse";
import "./wire-pulse.css";

/**
 * One stroke for every wire: a solid hairline whose only variable is hue.
 *
 * Weight, dash, halo, and travelling light all used to encode something — wire
 * family, worded config, live traffic — and stacked into a picture that had to
 * be decoded rather than read. A verb already says what the relationship is, so
 * the paint carries exactly one fact: which verb, in the verb's own colour.
 * State (stoppage) and selection stay structural — crimson and opacity — and
 * never mint a second stroke.
 *
 * Traffic is the one transient exception: while a delivered message crosses
 * the wire, a short dash of light runs from sender to receiver and then the
 * path is gone (wire-pulse). At idle every wire is still one hairline.
 *
 * Hover and selection are the two things a wire has to answer for now that the
 * bottom bar is the whole edge surface: the canvas must say which wire the
 * sentence down there is about. Both answer in the verb's own hue, republished
 * as `--wire-hue` for the stylesheet to bloom. No second colour, no second
 * stroke, no width or dash change — the hairline stays the hairline.
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
  selected,
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
  const lane = use$(loomLanes$[id]);
  // Traffic: set only while a message is crossing this wire (wire-pulse).
  const pulse = use$(wirePulses$[id]);

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

  // The plain run: an open field is not a routing failure, so most wires land
  // here. The lane is applied to the live handle coordinates, because the
  // planner's anchors never reach this path.
  const [fallbackPath, fallbackLabelX, fallbackLabelY] = getSmoothStepPath({
    sourceX: sourceX + (lane?.source.x ?? 0),
    sourceY: sourceY + (lane?.source.y ?? 0),
    targetX: targetX + (lane?.target.x ?? 0),
    targetY: targetY + (lane?.target.y ?? 0),
    sourcePosition,
    targetPosition,
    borderRadius: 8,
  });

  // Standalone route is planned once at CanvasLoom — no per-edge routeWire.
  const path = stitched?.path ?? plannedRoute?.path ?? fallbackPath;
  const labelX = stitched?.labelX ?? plannedRoute?.labelX ?? fallbackLabelX;
  const labelY = stitched?.labelY ?? plannedRoute?.labelY ?? fallbackLabelY;

  const className = [
    "junto-edge",
    selected ? "junto-edge--selected" : "",
    rippling ? "junto-edge-ripple" : "",
  ]
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
          // Same hue the stroke took, handed to the stylesheet so hover and
          // selection deepen this wire rather than naming a second colour.
          ["--wire-hue" as string]: color,
        }}
      />
      {pulse ? (
        // A transient second path, only while traffic crosses: at idle the
        // wire is still one hairline. pathLength 1 lets the stylesheet run
        // one short dash end to end in either direction.
        <path
          key={pulse.seq}
          d={path}
          pathLength={1}
          className="junto-wire-pulse"
          data-direction={pulse.reverse ? "reverse" : "forward"}
          style={{ stroke: `var(${WIRE_PULSE_TOKEN[pulse.kind]})` }}
          onAnimationEnd={() => wirePulseScheduler.end(id, pulse.seq)}
        />
      ) : null}
      <EdgeLabelRenderer>
        {/* Edge faces are silent by design: the relationship reads through
            stroke colour, node attention states, and the stoppage rank;
            details live in the edge inspector on selection. This midpoint
            target only aids clicking (paths already select) and screen
            readers. */}
        <button
          type="button"
          aria-label={
            phase === "blocks"
              ? `Select edge - waiting on you${detail ? ` - ${detail}` : ""}`
              : `Select edge - ${data?.verb ?? "connection"}`
          }
          className="nodrag nopan junto-edge-label junto-edge-label--silent"
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
