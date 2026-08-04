import { useEffect, useMemo, useRef, useState } from "react";
import type { EdgeProps, EdgeTypes } from "@xyflow/react";
import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, useStore } from "@xyflow/react";
import { use$ } from "@legendapp/state/react";
import type { FlowEdge } from "../../lib/convert";
import { edgeSparks$ } from "../../lib/edge-sparks";
import { state$ } from "../../lib/state";
import { accentColor, EDGE_COLOR, HUE } from "../../lib/theme";
import { nodeBounds, routeWire, type WireRect } from "../../lib/wire-route";
import type { WireFamily } from "@shared/physics";
import {
  chipPortsFromOffers,
  edgeMaskAllows,
  familyColorToken,
  familyFromSlot,
  offerPortsForAccessWire,
  offersOf,
  resolveSpec,
  roleOf,
  wirePresentation,
  wireRolePair,
} from "@shared/physics";

const FAMILY_HUE: Record<ReturnType<typeof familyColorToken>, string> = {
  steel: HUE.steel,
  cyan: HUE.cyan,
  violet: HUE.violet,
  amber: HUE.amber,
};

const familyHue = (family: WireFamily | undefined): string | undefined =>
  family ? FAMILY_HUE[familyColorToken(family)] : undefined;

/** Minimal node fields needed for obstacle bounds (xyflow InternalNode shape). */
type RouteNode = {
  readonly id: string;
  readonly type?: string;
  readonly hidden?: boolean;
  readonly width?: number | null;
  readonly height?: number | null;
  readonly measured?: { readonly width?: number; readonly height?: number };
  readonly style?: { readonly width?: number | string; readonly height?: number | string };
  readonly internals: { readonly positionAbsolute: { readonly x: number; readonly y: number } };
};

function readNodeSize(node: RouteNode): { width: number; height: number } | null {
  const measuredW = node.measured?.width;
  const measuredH = node.measured?.height;
  if (typeof measuredW === "number" && typeof measuredH === "number" && measuredW > 0 && measuredH > 0) {
    return { width: measuredW, height: measuredH };
  }
  const style = node.style;
  const styleW = typeof style?.width === "number" ? style.width : undefined;
  const styleH = typeof style?.height === "number" ? style.height : undefined;
  if (typeof styleW === "number" && typeof styleH === "number" && styleW > 0 && styleH > 0) {
    return { width: styleW, height: styleH };
  }
  const w = typeof node.width === "number" ? node.width : undefined;
  const h = typeof node.height === "number" ? node.height : undefined;
  if (typeof w === "number" && typeof h === "number" && w > 0 && h > 0) {
    return { width: w, height: h };
  }
  return null;
}

function collectObstacles(
  nodeLookup: Iterable<RouteNode>,
  sourceId: string,
  targetId: string,
): WireRect[] {
  const out: WireRect[] = [];
  for (const node of nodeLookup) {
    if (node.id === sourceId || node.id === targetId) continue;
    // Groups are geography, not furniture to route around — edges live inside them.
    if (node.type === "group") continue;
    if (node.hidden) continue;
    const size = readNodeSize(node);
    if (!size) continue;
    out.push(nodeBounds(node.internals.positionAbsolute, size));
  }
  return out;
}

export function EtherEdge({
  id,
  source,
  target,
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
  const spark = use$(edgeSparks$[id]);
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
  // Family presentation (color, dash, worded halo, disabled dim) — pure grammar.
  const slot = data?.edge.ether?.slot;
  const doc = state$.doc.peek();
  const fromNode = doc.nodes.find((n) => n.id === source);
  const toNode = doc.nodes.find((n) => n.id === target);
  const fromKind = fromNode?.ether?.entity?.kind;
  const toKind = toNode?.ether?.entity?.kind;
  const fromSpec = resolveSpec({
    isGroup: fromNode?.type === "group",
    kind: fromKind,
  });
  const toSpec = resolveSpec({
    isGroup: toNode?.type === "group",
    kind: toKind,
  });
  const fromRole = roleOf(fromSpec);
  const toRole = roleOf(toSpec);
  const family =
    familyFromSlot(slot, wireRolePair(fromRole, toRole)) ??
    (fromRole === "actor" || toRole === "actor" ? ("access" as const) : undefined);
  const offerSet = offerPortsForAccessWire(
    fromRole,
    toRole,
    offersOf(fromSpec),
    offersOf(toSpec),
  );
  const offeredChips = chipPortsFromOffers(offerSet);
  const edgeDoc = data?.edge;
  const portsField = edgeDoc?.ether?.ports;
  const activeChipCount: number | "full" =
    !edgeDoc || portsField === undefined || portsField.length === 0
      ? "full"
      : offeredChips.filter((port) => edgeMaskAllows(edgeDoc, port)).length;
  const hasMessages =
    fromRole === "actor" &&
    toRole === "actor" &&
    Boolean(edgeDoc && edgeMaskAllows(edgeDoc, "msg.send"));
  const presentation = family
    ? wirePresentation({
        family,
        ether: edgeDoc?.ether,
        fromKind,
        toKind,
        hasMessages,
        offeredChipCount: offeredChips.length,
        activeChipCount,
      })
    : undefined;
  const familyColor = familyHue(family);
  const color =
    phase === "blocks"
      ? EDGE_COLOR.blocks
      : (authoredColor ?? familyColor ?? EDGE_COLOR.relates);

  // Selection impact mode — only "in" is stamped (CSS dims the rest).
  const impactIn = data?.impact === "in";

  // Absolute node bounds for wire routing — re-run when graph geometry moves.
  const obstacles = useStore(
    (store) => collectObstacles(store.nodeLookup.values() as Iterable<RouteNode>, source, target),
    // Shallow geometry key so we don't rebuild on every unrelated store tick.
    (a, b) => {
      if (a === b) return true;
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) {
        const x = a[i]!;
        const y = b[i]!;
        if (
          x.x !== y.x ||
          x.y !== y.y ||
          x.width !== y.width ||
          x.height !== y.height
        ) {
          return false;
        }
      }
      return true;
    },
  );

  const [fallbackPath, fallbackLabelX, fallbackLabelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: 8,
  });

  const routed = useMemo(
    () =>
      routeWire({
        source: { x: sourceX, y: sourceY },
        target: { x: targetX, y: targetY },
        obstacles,
        padding: 14,
        borderRadius: 8,
        sourceDirection: sourcePosition,
        targetDirection: targetPosition,
      }),
    [sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, obstacles],
  );

  const path = routed?.path ?? fallbackPath;
  const labelX = routed?.labelX ?? fallbackLabelX;
  const labelY = routed?.labelY ?? fallbackLabelY;

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
    routed?.detoured ? "vellum-edge--routed" : "",
  ].filter(Boolean).join(" ");

  // Word halo: every worded family (access with stops/wakes, watch, effect).
  // Trigger stays bare — isWorded is false. Disabled unmounts the bed.
  const worded = presentation?.worded ?? false;
  const showWordBed = !disabled && worded;
  const strokeDasharray = presentation?.strokeDasharray;

  return (
    <>
      {showWordBed ? (
        <path
          d={path}
          className="vellum-edge__word-bed"
          fill="none"
          stroke={color}
          strokeWidth={8}
          style={{ color }}
        />
      ) : null}
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        className={className}
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
          d={path}
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
            stroke={HUE.amber}
            className={
              spark.fromNodeId === target
                ? "vellum-edge__spark-flare vellum-edge__spark-flare--rev"
                : "vellum-edge__spark-flare"
            }
            pathLength={100}
          />
          <circle
            r={2.4}
            fill={HUE.amber}
            className="vellum-edge__spark-core"
          >
            <animateMotion
              dur="780ms"
              fill="freeze"
              path={path}
              keyPoints={spark.fromNodeId === target ? "1;0" : "0;1"}
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
