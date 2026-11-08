import type { EdgeProps, EdgeTypes } from "@xyflow/react";
import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath } from "@xyflow/react";
import { use$ } from "@legendapp/state/react";
import type { FlowEdge } from "../../lib/convert";
import { loomLanes$, loomRoutes$, loomStrands$ } from "../../lib/loom-view";
import { LANE_GAP, stitchStrand } from "../../lib/wire-loom";
import { selectEdge } from "../../lib/state";
import { wirePulses$ } from "../../lib/wire-pulse-state";
import { WIRE_WIDTH } from "../../lib/flow-track";
import { isTaskPathVerb } from "@shared/physics";
import { FlowTrack } from "./FlowTrack";
import { WirePulse } from "./WirePulse";

/**
 * One stroke for every wire but flows: a solid hairline whose only variable
 * is hue.
 *
 * Flows, the task-to-task dependency, is the one wire drawn otherwise, at the
 * operator's ask: a track of open chevrons in ink, half again a wire's weight,
 * opaque at every tier and in every state, sliding toward the dependent board
 * (FlowTrack, lib/flow-track.ts). Derives, its sibling on the same board
 * pair, draws that track as still filled arrowheads that breathe in place.
 * Either way the wire's own path stays, unpainted, as the hit target.
 * Everything below is about the hairline.
 *
 * Weight, dash, halo, and travelling light all used to encode something — wire
 * family, worded config, live traffic — and stacked into a picture that had to
 * be decoded rather than read. A verb already says what the relationship is, so
 * the paint carries exactly one fact: which verb, in the verb's own colour.
 * Stoppage is not a wire's to show: it lives on the blocked seat's ring.
 * Selection stays structural (opacity) and never mints a second stroke.
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
 *
 * At rest a wire is ground: all but hidden, behind every card, and deaf to the
 * pointer, so it never sits between the operator and a seat. Opacity and
 * pointer events are the stylesheet's (factory-grammar.css), which shows the
 * wires and lets them be picked while the loupe is held, while a node's
 * connections are shown, and while a wire is being drawn.
 */
/** No verb means no relationship compiled: draw it, quietly, in neutral ink. */
const UNSET_COLOR = "var(--wire-verb-unset)";

export function WireEdge({
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
  // PERF-P2: edge-local keys only — never full obstacle/corridor arrays.
  const strand = use$(loomStrands$[id]);
  const plannedRoute = use$(loomRoutes$[id]);
  const lane = use$(loomLanes$[id]);
  // Traffic: set only while a message is crossing this wire (wire-pulse).
  const pulse = use$(wirePulses$[id]);

  // Verb hue, stamped at convert.
  const token = data?.colorToken;
  const color = token ? `var(${token})` : UNSET_COLOR;

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

  // Both task verbs draw a track: flows slides its chevrons, derives holds
  // its arrowheads still (FlowTrack).
  const verb = data?.verb;
  const track = isTaskPathVerb(verb) ? verb : null;

  const className = [
    "junto-edge",
    selected ? "junto-edge--selected" : "",
    track ? "junto-edge--track" : "",
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
          // Same hue the stroke took, handed to the stylesheet so hover and
          // selection deepen this wire rather than naming a second colour.
          ["--wire-hue" as string]: color,
        }}
      />
      {track ? <FlowTrack id={id} path={path} selected={Boolean(selected)} verb={track} /> : null}
      {pulse ? (
        // Transient, only while traffic crosses: at idle the wire is still
        // one hairline. The dash runs on the compositor (WirePulse).
        <WirePulse edgeId={id} path={path} pulse={pulse} impactIn={impactIn} />
      ) : null}
      <EdgeLabelRenderer>
        {/* Edge faces are silent by design: the relationship reads through
            stroke colour, node attention states, and the stoppage rank;
            details live in the edge inspector on selection. This midpoint
            target only aids clicking (paths already select) and screen
            readers. */}
        <button
          type="button"
          aria-label={`Select edge - ${data?.verb ?? "connection"}`}
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
  wire: WireEdge,
};
