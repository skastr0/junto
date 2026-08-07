/**
 * Canvas loom writer — renders nothing.
 *
 * Mounted inside `<ReactFlow>` so it sits in the store provider. Holds the one
 * store subscription that used to live per-edge: it walks `nodeLookup` once per
 * geometry tick, publishes the obstacle field every edge routes against, and
 * (when the loom is on) plans the lane geometry for point-coincident fans.
 *
 * Paint and geometry only — edge semantics are read, never written.
 */
import { useEffect, useMemo, useRef } from "react";
import { useStore } from "@xyflow/react";
import type { FlowEdge } from "../../lib/convert";
import {
  LOOM_ENABLED,
  loomCorridors$,
  loomObstacles$,
  loomStrands$,
} from "../../lib/loom-view";
import { planLoom } from "../../lib/wire-loom";
import type { LoomEdgeInput, LoomObstacle, LoomStrand } from "../../lib/wire-loom";
import { viewportBusy$ } from "../../lib/viewport-busy";
import { nodeBounds } from "../../lib/wire-route";
import type { WireDirection, WirePoint, WireRect } from "../../lib/wire-route";

/** Minimal node fields needed for obstacle bounds (xyflow InternalNode shape). */
type RouteNode = {
  readonly id: string;
  readonly type?: string;
  readonly hidden?: boolean;
  readonly dragging?: boolean;
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

/** One measured node: its bounds, whether it is furniture, whether it moves. */
type LoomNode = {
  readonly nodeId: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Groups are geography, not furniture to route around — edges live inside. */
  readonly obstacle: boolean;
  readonly dragging: boolean;
};

function readGeometry(nodeLookup: Iterable<RouteNode>): LoomNode[] {
  const out: LoomNode[] = [];
  for (const node of nodeLookup) {
    if (node.hidden) continue;
    const size = readNodeSize(node);
    if (!size) continue;
    const at = node.internals.positionAbsolute;
    out.push({
      nodeId: node.id,
      x: at.x,
      y: at.y,
      width: size.width,
      height: size.height,
      obstacle: node.type !== "group",
      dragging: node.dragging === true,
    });
  }
  return out;
}

/** Shallow geometry key so we don't rebuild on every unrelated store tick. */
function sameGeometry(a: LoomNode[], b: LoomNode[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (
      x.nodeId !== y.nodeId ||
      x.x !== y.x ||
      x.y !== y.y ||
      x.width !== y.width ||
      x.height !== y.height ||
      x.obstacle !== y.obstacle ||
      x.dragging !== y.dragging
    ) {
      return false;
    }
  }
  return true;
}

const HANDLE_SIDES: Record<string, WireDirection> = {
  left: "left",
  right: "right",
  top: "top",
  bottom: "bottom",
};

/** Handle ids are `s-<side>` / `t-<side>` (convert.ts). Anything else opts out. */
function sideOfHandle(handle: string | null | undefined): WireDirection | null {
  if (!handle) return null;
  return HANDLE_SIDES[handle.slice(2)] ?? null;
}

/** Topology + stoppage only — no positions, so a drag never changes it. */
type EdgeSpec = {
  readonly id: string;
  readonly blocked: boolean;
  readonly sourceNodeId: string;
  readonly sourceSide: WireDirection;
  readonly targetNodeId: string;
  readonly targetSide: WireDirection;
};

function specsOf(edges: ReadonlyArray<FlowEdge>): EdgeSpec[] {
  const out: EdgeSpec[] = [];
  for (const edge of edges) {
    const sourceSide = sideOfHandle(edge.sourceHandle);
    const targetSide = sideOfHandle(edge.targetHandle);
    if (!sourceSide || !targetSide) continue;
    const data = edge.data;
    // Same expression EtherEdge paints from; read only, never written back.
    const phase = data?.phase ?? data?.edge.ether?.kind ?? "relates";
    out.push({
      id: edge.id,
      blocked: phase === "blocks" || (data?.rippling ?? false),
      sourceNodeId: edge.source,
      sourceSide,
      targetNodeId: edge.target,
      targetSide,
    });
  }
  return out;
}

function specsKeyOf(specs: ReadonlyArray<EdgeSpec>): string {
  return specs
    .map(
      (spec) =>
        `${spec.id}|${spec.sourceNodeId}|${spec.sourceSide}|${spec.targetNodeId}|${spec.targetSide}|${spec.blocked ? 1 : 0}`,
    )
    .join(";");
}

/** Handle centre, node-derived. Stitching corrects to the DOM-measured point. */
function anchorOn(bounds: LoomNode, side: WireDirection): WirePoint {
  switch (side) {
    case "left":
      return { x: bounds.x, y: bounds.y + bounds.height / 2 };
    case "right":
      return { x: bounds.x + bounds.width, y: bounds.y + bounds.height / 2 };
    case "top":
      return { x: bounds.x + bounds.width / 2, y: bounds.y };
    case "bottom":
      return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height };
  }
}

function sameStrand(a: LoomStrand, b: LoomStrand): boolean {
  return (
    a.bundleKey === b.bundleKey &&
    a.hubEnd === b.hubEnd &&
    a.hubAxis === b.hubAxis &&
    a.laneIndex === b.laneIndex &&
    a.laneCount === b.laneCount &&
    a.laneOffset === b.laneOffset &&
    a.splayAt === b.splayAt &&
    a.stationAt === b.stationAt
  );
}

function sameRects(a: ReadonlyArray<WireRect>, b: ReadonlyArray<WireRect>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.x !== y.x || x.y !== y.y || x.width !== y.width || x.height !== y.height) return false;
  }
  return true;
}

function clearPlan(): void {
  const held = loomStrands$.peek();
  for (const id of Object.keys(held)) loomStrands$[id]!.delete();
  if (loomCorridors$.peek().length > 0) loomCorridors$.set([]);
}

/**
 * `edges` is the rendered, already filtered array — hidden, filtered, and
 * searched-out nodes are handled by never reaching here.
 */
export function CanvasLoom({ edges }: { readonly edges: ReadonlyArray<FlowEdge> }) {
  const geometry = useStore(
    (store) => readGeometry(store.nodeLookup.values() as Iterable<RouteNode>),
    sameGeometry,
  );
  const specs = useMemo(() => specsOf(edges), [edges]);
  const specsKey = useMemo(() => specsKeyOf(specs), [specs]);
  // The key is the effect dependency; the specs themselves ride a ref so a new
  // edges array with identical topology never replans.
  const specsRef = useRef(specs);
  specsRef.current = specs;
  // Non-null while the plan is frozen, holding the dragged-node signature.
  const freezeRef = useRef<string | null>(null);

  useEffect(() => {
    const obstacles: LoomObstacle[] = [];
    for (const node of geometry) {
      if (!node.obstacle) continue;
      obstacles.push({
        nodeId: node.nodeId,
        ...nodeBounds({ x: node.x, y: node.y }, { width: node.width, height: node.height }),
      });
    }
    // Published unconditionally: this is the per-edge router's field, and with
    // the loom off every edge still routes against it exactly as before.
    loomObstacles$.set(obstacles);

    if (!LOOM_ENABLED) {
      clearPlan();
      return;
    }

    const specsNow = specsRef.current;
    const dragging = geometry.filter((node) => node.dragging).map((node) => node.nodeId);
    if (dragging.length > 0 || viewportBusy$.peek()) {
      // Frozen: nothing reflows during a gesture. Edges incident to a dragged
      // node drop to the per-edge router once, at the start of the freeze.
      const signature = dragging.join(",");
      if (freezeRef.current === signature) return;
      freezeRef.current = signature;
      if (dragging.length === 0) return;
      const moving = new Set(dragging);
      const held = loomStrands$.peek();
      for (const spec of specsNow) {
        if (!held[spec.id]) continue;
        if (!moving.has(spec.sourceNodeId) && !moving.has(spec.targetNodeId)) continue;
        loomStrands$[spec.id]!.delete();
      }
      return;
    }
    // Drag stop lands here: the dragging flags clear, so this is the one
    // recompute that closes the gesture.
    freezeRef.current = null;

    const byId = new Map(geometry.map((node) => [node.nodeId, node] as const));
    const inputs: LoomEdgeInput[] = [];
    for (const spec of specsNow) {
      const from = byId.get(spec.sourceNodeId);
      const to = byId.get(spec.targetNodeId);
      if (!from || !to) continue;
      inputs.push({
        id: spec.id,
        blocked: spec.blocked,
        sourceNodeId: spec.sourceNodeId,
        sourceSide: spec.sourceSide,
        sourceAnchor: anchorOn(from, spec.sourceSide),
        targetNodeId: spec.targetNodeId,
        targetSide: spec.targetSide,
        targetAnchor: anchorOn(to, spec.targetSide),
      });
    }

    const plan = planLoom({ edges: inputs, obstacles });
    const held = loomStrands$.peek();
    for (const id of Object.keys(held)) {
      if (!plan.strands.has(id)) loomStrands$[id]!.delete();
    }
    for (const [id, strand] of plan.strands) {
      const prior = held[id];
      // Identity is preserved for an unchanged strand so its edge stays put.
      if (prior && sameStrand(prior, strand)) continue;
      loomStrands$[id]!.set(strand);
    }
    if (!sameRects(loomCorridors$.peek(), plan.corridors)) {
      loomCorridors$.set([...plan.corridors]);
    }
  }, [geometry, specsKey]);

  return null;
}
