import { useEffect, useRef, useState } from "react";
import type { EdgeProps, EdgeTypes } from "@xyflow/react";
import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath } from "@xyflow/react";
import { use$ } from "@legendapp/state/react";
import type { FlowEdge } from "../../lib/convert";
import { edgeSparks$ } from "../../lib/edge-sparks";
import { loomRoutes$, loomStrands$ } from "../../lib/loom-view";
import { LANE_GAP, stitchStrand } from "../../lib/wire-loom";
import { selectEdge } from "../../lib/state";
import { accentColor, EDGE_COLOR, HUE } from "../../lib/theme";
import type { WireFamily } from "@shared/physics";
import { familyColorToken } from "@shared/physics";

const FAMILY_HUE: Record<ReturnType<typeof familyColorToken>, string> = {
  steel: HUE.steel,
  cyan: HUE.cyan,
  violet: HUE.violet,
  amber: HUE.amber,
};

const familyHue = (family: WireFamily | undefined): string | undefined =>
  family ? FAMILY_HUE[familyColorToken(family)] : undefined;

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
  const rippling = data?.rippling ?? false;
  const blocked = phase === "blocks" || rippling;
  const previousBlockedRef = useRef(blocked);
  const [blockArrival, setBlockArrival] = useState(false);

  // PERF-P2: edge-local keys only — never full obstacle/corridor arrays.
  const spark = use$(edgeSparks$[id]);
  const strand = use$(loomStrands$[id]);
  const plannedRoute = use$(loomRoutes$[id]);

  useEffect(() => {
    const wasBlocked = previousBlockedRef.current;
    previousBlockedRef.current = blocked;
    if (wasBlocked || !blocked) {
      if (!blocked) setBlockArrival(false);
      return;
    }
    setBlockArrival(true);
    const clear = window.setTimeout(() => setBlockArrival(false), 920);
    return () => window.clearTimeout(clear);
  }, [blocked]);

  // Prefer live phase palette; only honor non-mirror accents (not stuck "1").
  const authoredColor =
    data?.edge.color && data.edge.color !== "1"
      ? accentColor(data.edge.color)
      : undefined;

  // Presentation stamped at convert — no document-wide node scan here.
  const presentation = data?.presentation;
  const family = presentation?.family ?? data?.wireFamily;
  const familyColor = familyHue(family);
  // Centerline may take phase crimson; word-bed stays family hue so config
  // glow never wears stoppage paint (artifact: family color on worded wires).
  const color =
    phase === "blocks"
      ? EDGE_COLOR.blocks
      : (authoredColor ?? familyColor ?? EDGE_COLOR.relates);
  const wordBedColor = familyColor ?? authoredColor ?? color;

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
  // Twelve 8px halos at 3px lane spacing merge into an opaque slab, so the
  // trunk carries centerlines only and the worded paint lands on the tail.
  const overlayPath = stitched?.tailPath ?? path;

  // One paint grammar: wire family. Equal hairline weight for every pair.
  const baseWidth = 1.2;
  const disabled = presentation?.disabled ?? false;
  const baseOpacity = disabled ? 0.25 : family ? 0.9 : 0.55;
  const className = [
    "vellum-edge",
    family ? `vellum-edge--family-${family}` : "vellum-edge--family-unknown",
    presentation?.worded ? "vellum-edge--worded" : "",
    disabled ? "vellum-edge--disabled" : "",
    blocked ? "vellum-edge--blocked" : "",
    rippling ? "vellum-edge-ripple" : "",
    impactIn ? "vellum-edge-impact-in" : "",
    plannedRoute?.detoured && !stitched ? "vellum-edge--routed" : "",
  ]
    .filter(Boolean)
    .join(" ");

  // Word halo: every worded family (access with stops/wakes, watch, effect).
  // Trigger stays bare — isWorded is false. Disabled unmounts the bed.
  const worded = presentation?.worded ?? false;
  const showWordBed = !disabled && worded;
  const strokeDasharray = presentation?.strokeDasharray;

  return (
    <>
      {showWordBed ? (
        <path
          d={overlayPath}
          className="vellum-edge__word-bed"
          fill="none"
          stroke={wordBedColor}
          strokeWidth={8}
          style={{ color: wordBedColor }}
        />
      ) : null}
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
          strokeWidth: impactIn ? Math.max(baseWidth, 1.6) : baseWidth,
          opacity: impactIn && !disabled ? 1 : baseOpacity,
          ...(strokeDasharray
            ? { strokeDasharray: strokeDasharray === "none" ? "none" : strokeDasharray }
            : {}),
        }}
      />
      {!disabled && family === "effect" ? (
        <path
          d={overlayPath}
          fill="none"
          stroke={color}
          className="vellum-edge__signal vellum-edge__signal--effect"
          pathLength={100}
        />
      ) : null}
      {blocked ? (
        <path
          d={path}
          fill="none"
          className="vellum-edge__interruption"
          pathLength={100}
        />
      ) : null}
      {blockArrival ? (
        <g className="vellum-edge__arrival" aria-hidden="true">
          <path
            d={path}
            fill="none"
            className="vellum-edge__flare"
            pathLength={100}
          />
          <circle
            cx={targetX}
            cy={targetY}
            r={3}
            className="vellum-edge__arrival-ring"
          />
        </g>
      ) : null}
      {spark ? (
        <g
          key={`spark-${spark.token}`}
          className="vellum-edge__spark"
          aria-hidden="true"
        >
          <path
            d={path}
            fill="none"
            stroke={wordBedColor}
            className={
              spark.fromNodeId === data?.edge.toNode
                ? "vellum-edge__spark-flare vellum-edge__spark-flare--rev"
                : "vellum-edge__spark-flare"
            }
            pathLength={100}
            style={{ color: wordBedColor }}
          />
          <circle
            r={2.4}
            fill={wordBedColor}
            className="vellum-edge__spark-core"
          >
            <animateMotion
              dur="780ms"
              fill="freeze"
              path={path}
              keyPoints={
                spark.fromNodeId === data?.edge.toNode ? "1;0" : "0;1"
              }
              keyTimes="0;1"
              calcMode="linear"
            />
          </circle>
        </g>
      ) : null}
      <EdgeLabelRenderer>
        {/* Edge faces are silent by design: phase reads through stroke color,
            node attention states, and the stoppage rank; details live in the
            edge inspector on selection. This midpoint target only aids
            clicking (paths already select) and screen readers. */}
        <button
          type="button"
          aria-label={detail ? `Select edge - ${phase} - ${detail}` : `Select edge - ${phase}`}
          className="nodrag nopan vellum-edge-label vellum-edge-label--silent"
          style={{ top: labelY, left: labelX, opacity: 0, width: 14, height: 14, padding: 0 }}
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
