/**
 * Canvas loom writer — renders nothing.
 *
 * Mounted inside `<ReactFlow>` so it sits in the store provider. Owns the one
 * geometry subscription and the one route plan: obstacles, corridors, fan
 * strands, and standalone routes are published as value-equal / keyed
 * observables. Edges subscribe only to their own keys.
 *
 * Paint and geometry only — edge semantics are read, never written.
 */
import { useEffect, useMemo, useRef } from "react";
import { useStore } from "@xyflow/react";
import { batch } from "@legendapp/state";
import { use$ } from "@legendapp/state/react";
import type { FlowEdge } from "../../lib/convert";
import {
  loomCorridors$,
  loomObstacles$,
  loomRoutes$,
  loomStrands$,
  planStandaloneRoutes,
  pruneKeyedLoomEntries,
  publishKeyedLanes,
  publishKeyedRoutes,
  sameStrand,
  shouldPublishCorridors,
  shouldPublishObstacles,
  type LoomLane,
} from "../../lib/loom-view";
import { MIN_FAN, planLoom } from "../../lib/wire-loom";
import type { LoomEdgeInput, LoomObstacle, LoomStrand } from "../../lib/wire-loom";
import { viewportBusy$ } from "../../lib/viewport-busy";
import { canvasPerformance } from "../../lib/performance/canvas-performance";
import { nodeBounds, routeWire } from "../../lib/wire-route";
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
    const phase = data?.phase ?? "relates";
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

/**
 * Two wires on one handle: give them a lane each.
 *
 * A cable starts at three, so below `MIN_FAN` the loom lanes nothing — and two
 * edges pinned to the same handle are measured off the same point, run the same
 * final approach, and the second one paints over the first. Around a tasks card
 * that is `manages` disappearing underneath `contributes`: the operator sees one
 * wire reaching the card and one that stops in open space. A pair therefore
 * arrives on two points instead of one, spread across the side it enters.
 *
 * Only pairs. A fan of three and up is the loom's own work, and its members are
 * stitched back onto the live handle, which would throw a lane away and leave a
 * jog where the wire meets the card.
 *
 * The lane is published as well as applied. `routeWire` answers `null` for an
 * open field — a plain run is not a routing failure, it is the ordinary case —
 * and that wire is painted by smooth-step off the live handle coordinates, so
 * an anchor shift alone would reach only the wires that happen to need a
 * detour.
 */
const PAIR_LANE = 7;
/** Keep a lane off the card's own corner, however small the card is. */
const PAIR_LANE_MARGIN = 10;
/** Below this the split is not worth the geometry — the card has no room. */
const PAIR_LANE_MIN = 2;

type LaneEnd = "source" | "target";

/** `${end}|${nodeId}|${side}` — one handle, the same key the loom fans on. */
function laneKey(end: LaneEnd, nodeId: string, side: WireDirection): string {
  return `${end === "source" ? "s" : "t"}|${nodeId}|${side}`;
}

/** Lanes run across the side they leave from, never along it. */
function laneAxisOf(side: WireDirection): "x" | "y" {
  return side === "left" || side === "right" ? "y" : "x";
}

function sideExtentOf(bounds: LoomNode, side: WireDirection): number {
  return side === "left" || side === "right" ? bounds.height : bounds.width;
}

function laned(point: WirePoint, axis: "x" | "y", offset: number): WirePoint {
  return axis === "x"
    ? { x: point.x + offset, y: point.y }
    : { x: point.x, y: point.y + offset };
}

const NO_SHIFT: WirePoint = { x: 0, y: 0 };

/** A perpendicular offset, expressed on the axis the side actually moves on. */
function shiftOn(side: WireDirection, offset: number): WirePoint {
  return laneAxisOf(side) === "x" ? { x: offset, y: 0 } : { x: 0, y: offset };
}

function laneOffsets(
  inputs: ReadonlyArray<LoomEdgeInput>,
  byId: ReadonlyMap<string, LoomNode>,
): Map<string, LoomLane> {
  const lanes = new Map<string, LoomLane>();
  if (inputs.length < 2) return lanes;

  const groups = new Map<string, number[]>();
  const gather = (key: string, index: number): void => {
    const held = groups.get(key);
    if (held) held.push(index);
    else groups.set(key, [index]);
  };
  inputs.forEach((edge, index) => {
    gather(laneKey("source", edge.sourceNodeId, edge.sourceSide), index);
    gather(laneKey("target", edge.targetNodeId, edge.targetSide), index);
  });

  for (const [key, members] of groups) {
    if (members.length !== 2) continue;
    const end: LaneEnd = key.startsWith("s|") ? "source" : "target";
    const otherKeyOf = (edge: LoomEdgeInput): string =>
      end === "source"
        ? laneKey("target", edge.targetNodeId, edge.targetSide)
        : laneKey("source", edge.sourceNodeId, edge.sourceSide);
    // A member that is a strand at its far end gets stitched to the live
    // handle, which discards the lane. Leave such a pair coincident.
    const standalone = members.every(
      (index) => (groups.get(otherKeyOf(inputs[index]!))?.length ?? 0) < MIN_FAN,
    );
    if (!standalone) continue;

    const first = inputs[members[0]!]!;
    const side = end === "source" ? first.sourceSide : first.targetSide;
    const nodeId = end === "source" ? first.sourceNodeId : first.targetNodeId;
    const bounds = byId.get(nodeId);
    if (!bounds) continue;
    const axis = laneAxisOf(side);
    const lane = Math.min(
      PAIR_LANE,
      sideExtentOf(bounds, side) / 2 - PAIR_LANE_MARGIN,
    );
    if (lane < PAIR_LANE_MIN) continue;

    // Ordered by where the far end sits across the same axis, so the two lanes
    // never cross each other on the way in.
    const farAcross = (index: number): number => {
      const edge = inputs[index]!;
      return (end === "source" ? edge.targetAnchor : edge.sourceAnchor)[axis];
    };
    const ordered = [...members].sort((a, b) => {
      const delta = farAcross(a) - farAcross(b);
      if (delta !== 0) return delta;
      return inputs[a]!.id < inputs[b]!.id ? -1 : 1;
    });
    ordered.forEach((index, order) => {
      const edge = inputs[index]!;
      const held = lanes.get(edge.id) ?? { source: NO_SHIFT, target: NO_SHIFT };
      const shift = shiftOn(
        end === "source" ? edge.sourceSide : edge.targetSide,
        order === 0 ? -lane : lane,
      );
      lanes.set(
        edge.id,
        end === "source"
          ? { source: shift, target: held.target }
          : { source: held.source, target: shift },
      );
    });
  }

  return lanes;
}

/** The published lane, applied to the anchors the planner routes between. */
function laneApplied(
  edge: LoomEdgeInput,
  lane: LoomLane | undefined,
): LoomEdgeInput {
  if (!lane) return edge;
  return {
    ...edge,
    sourceAnchor: laned(
      laned(edge.sourceAnchor, "x", lane.source.x),
      "y",
      lane.source.y,
    ),
    targetAnchor: laned(
      laned(edge.targetAnchor, "x", lane.target.x),
      "y",
      lane.target.y,
    ),
  };
}

function buildInputs(
  specs: ReadonlyArray<EdgeSpec>,
  geometry: ReadonlyArray<LoomNode>,
): { inputs: LoomEdgeInput[]; lanes: Map<string, LoomLane> } {
  const byId = new Map(geometry.map((node) => [node.nodeId, node] as const));
  const centred: LoomEdgeInput[] = [];
  for (const spec of specs) {
    const from = byId.get(spec.sourceNodeId);
    const to = byId.get(spec.targetNodeId);
    if (!from || !to) continue;
    centred.push({
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
  const lanes = laneOffsets(centred, byId);
  return {
    inputs: centred.map((edge) => laneApplied(edge, lanes.get(edge.id))),
    lanes,
  };
}

function collectObstacles(geometry: ReadonlyArray<LoomNode>): LoomObstacle[] {
  const obstacles: LoomObstacle[] = [];
  for (const node of geometry) {
    if (!node.obstacle) continue;
    obstacles.push({
      nodeId: node.nodeId,
      ...nodeBounds({ x: node.x, y: node.y }, { width: node.width, height: node.height }),
    });
  }
  return obstacles;
}

function publishObstacles(obstacles: LoomObstacle[]): void {
  const equal = !shouldPublishObstacles(loomObstacles$.peek(), obstacles);
  canvasPerformance.recordObstaclePublication(equal);
  // Equal geometry must not write — no subscriber fan-out on value-equal ticks.
  if (!equal) {
    loomObstacles$.set(obstacles);
  }
}

function publishCorridors(corridors: ReadonlyArray<WireRect>): void {
  const equal = !shouldPublishCorridors(loomCorridors$.peek(), corridors);
  canvasPerformance.recordCorridorPublication(equal);
  if (!equal) {
    loomCorridors$.set([...corridors]);
  }
}

function publishStrands(planStrands: ReadonlyMap<string, LoomStrand>): void {
  const held = loomStrands$.peek();
  batch(() => {
    for (const id of Object.keys(held)) {
      if (!planStrands.has(id)) loomStrands$[id]!.delete();
    }
    for (const [id, strand] of planStrands) {
      const prior = held[id];
      // Identity preserved for an unchanged strand so its edge stays put.
      if (prior && sameStrand(prior, strand)) continue;
      loomStrands$[id]!.set(strand);
    }
  });
}

/**
 * Route standalone edges and publish keyed results.
 * - Full plan (`scopeIds` omitted): next map is complete; orphans deleted.
 * - Scoped (drag): only those edge ids are written/deleted.
 */
function publishStandaloneRoutes(
  inputs: ReadonlyArray<LoomEdgeInput>,
  obstacles: ReadonlyArray<LoomObstacle>,
  corridors: ReadonlyArray<WireRect>,
  strandIds: ReadonlySet<string>,
  scopeIds?: ReadonlySet<string>,
): void {
  const candidates = scopeIds
    ? inputs.filter((edge) => scopeIds.has(edge.id))
    : inputs;

  const routes = planStandaloneRoutes({
    edges: candidates,
    obstacles,
    corridors,
    strandIds,
    routeWire,
    onRouteWire: (edgeId) => canvasPerformance.recordRouteWire(edgeId, "geometry"),
  });

  const held = loomRoutes$.peek();
  if (scopeIds) {
    // Delete routes for scoped edges that became strands or failed to route.
    batch(() => {
      for (const id of scopeIds) {
        if (strandIds.has(id) || !routes.has(id)) {
          if (held[id]) loomRoutes$[id]!.delete();
        }
      }
    });
    publishKeyedRoutes(loomRoutes$.peek(), routes, scopeIds);
    return;
  }

  // Full replace-by-diff: next is the complete non-strand route set.
  publishKeyedRoutes(held, routes);
  batch(() => {
    for (const id of strandIds) {
      if (loomRoutes$.peek()[id]) loomRoutes$[id]!.delete();
    }
  });
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
  // Geometry and topology the standing plan was built from. `viewportBusy` is a
  // dependency, so a pan or a zoom re-runs this effect on release; without this
  // the loom would replan the whole canvas at the end of every gesture.
  const plannedRef = useRef<{ geometry: LoomNode[]; specsKey: string } | null>(null);
  // Subscribed, not peeked — a geometry tick inside a pan freezes the plan, and
  // nothing else would re-run this effect when the pan releases.
  const viewportBusy = use$(viewportBusy$);

  useEffect(() => {
    canvasPerformance.recordLoomEffect();
    const obstacles = collectObstacles(geometry);
    publishObstacles(obstacles);

    const specsNow = specsRef.current;
    const activeIds = new Set(specsNow.map((spec) => spec.id));
    // Drop keyed residue for edges that left the rendered set.
    pruneKeyedLoomEntries(activeIds);

    const dragging = geometry.filter((node) => node.dragging).map((node) => node.nodeId);

    // Pan / zoom: canvas-space geometry is unchanged — never replan or re-route.
    if (viewportBusy && dragging.length === 0) {
      freezeRef.current = "__viewport__";
      return;
    }

    if (dragging.length > 0) {
      // Frozen fan plan during drag. Incident edges drop strands once, then
      // receive scoped standalone routes every geometry tick so they stay
      // attached without notifying unrelated edges.
      const signature = dragging.join(",");
      const moving = new Set(dragging);
      if (freezeRef.current !== signature) {
        freezeRef.current = signature;
        const held = loomStrands$.peek();
        batch(() => {
          for (const spec of specsNow) {
            if (!held[spec.id]) continue;
            if (!moving.has(spec.sourceNodeId) && !moving.has(spec.targetNodeId)) continue;
            loomStrands$[spec.id]!.delete();
          }
        });
        plannedRef.current = null;
      }
      const incident = new Set(
        specsNow
          .filter(
            (spec) => moving.has(spec.sourceNodeId) || moving.has(spec.targetNodeId),
          )
          .map((spec) => spec.id),
      );
      if (incident.size === 0) return;
      const { inputs, lanes } = buildInputs(specsNow, geometry);
      publishKeyedLanes(lanes);
      // Standing corridors from last full plan (or empty) — stoppage clearance.
      const corridors = loomCorridors$.peek();
      // During drag, no edge in incident set should keep a strand (deleted above
      // or never had one). Route them all as standalone with live anchors.
      publishStandaloneRoutes(inputs, obstacles, corridors, new Set(), incident);
      return;
    }

    freezeRef.current = null;

    // Settled geometry + topology already planned — zero planLoom / routeWire.
    const planned = plannedRef.current;
    if (planned && planned.specsKey === specsKey && sameGeometry(planned.geometry, geometry)) {
      return;
    }

    const { inputs, lanes } = buildInputs(specsNow, geometry);
    publishKeyedLanes(lanes);
    const planStartedAt = globalThis.performance?.now?.() ?? Date.now();
    const plan = planLoom({ edges: inputs, obstacles });
    canvasPerformance.recordLoomPlan(
      Math.max(0, (globalThis.performance?.now?.() ?? Date.now()) - planStartedAt),
    );

    publishStrands(plan.strands);
    publishCorridors(plan.corridors);

    const strandIds = new Set(plan.strands.keys());
    publishStandaloneRoutes(inputs, obstacles, plan.corridors, strandIds);

    plannedRef.current = { geometry, specsKey };
  }, [geometry, specsKey, viewportBusy]);

  return null;
}
