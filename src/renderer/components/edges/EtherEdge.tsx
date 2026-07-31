import { useEffect, useRef, useState } from "react";
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
  const visualRole = data?.visualRole ?? "soft-relation";
  const detail = data?.detail ?? "";
  const hasCriteria = Boolean(data?.edge.ether?.criteria);
  const rippling = data?.rippling ?? false;
  const blocked = phase === "blocks" || rippling;
  const previousBlockedRef = useRef(blocked);
  const [blockArrival, setBlockArrival] = useState(false);
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
  // Pair kind lives in construction (rail, packets, provenance dots, ticks),
  // never in an always-hot hue. Color is reserved for live phase or an
  // explicit operator-authored canvas color.
  const color = authoredColor ?? EDGE_COLOR[phase];

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

  const baseWidth = visualRole === "task-flow" ? 2.2 : visualRole === "artifact-flow" ? 0.85 : 1.2;
  const baseOpacity = visualRole === "artifact-flow" ? 0.42 : visualRole === "soft-relation" && !hasCriteria ? 0.38 : 0.9;
  const className = [
    "vellum-edge",
    `vellum-edge--${visualRole}`,
    blocked ? "vellum-edge--blocked" : "",
    rippling ? "vellum-edge-ripple" : "",
    impactIn ? "vellum-edge-impact-in" : "",
  ].filter(Boolean).join(" ");

  return (
    <>
      {visualRole === "task-flow" ? (
        <path
          d={path}
          className="vellum-edge__rail-bed"
          fill="none"
          stroke={color}
          strokeWidth={5.4}
        />
      ) : null}
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        className={className}
        style={{
          stroke: color,
          strokeWidth: impactIn ? Math.max(baseWidth, 2.1) : baseWidth,
          opacity: impactIn ? 1 : baseOpacity,
        }}
      />
      {visualRole === "task-flow" || visualRole === "request-flow" || visualRole === "scheduler-flow" ? (
        <path
          d={path}
          fill="none"
          stroke={color}
          className={`vellum-edge__signal vellum-edge__signal--${visualRole}`}
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
