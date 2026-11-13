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
import { memo, useEffect, useMemo, useRef } from "react";
import { useStore } from "@xyflow/react";
import { batch } from "@legendapp/state";
import type { FlowEdge } from "../../lib/convert";
import {
  loomCorridors$,
  loomObstacles$,
  loomRoutes$,
  loomStrands$,
  routesOwedWithCause,
  type RouteCause,
  routesForTick,
  pruneKeyedLoomEntries,
  publishKeyedLanes,
  publishKeyedRoutes,
  sameStrand,
  shouldPublishCorridors,
  shouldPublishObstacles,
} from "../../lib/loom-view";
import { planLoom } from "../../lib/wire-loom";
import type { LoomEdgeInput, LoomObstacle, LoomStrand } from "../../lib/wire-loom";
import {
  buildInputs,
  collectObstacles,
  movedNodeIds,
  sameGeometry,
  specKeyOf,
  specsKeyOf,
  specsOf,
  type LoomNode,
  type LoomWire,
} from "../../lib/loom-geometry";
import { canvasPerformance } from "../../lib/performance/canvas-performance";
import { routeWire } from "@shared/wire-route";
import type { WireDirection, WireRect } from "@shared/wire-route";

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

/** The wires the loom reads, from React Flow's edges. */
function wiresOf(edges: ReadonlyArray<FlowEdge>): LoomWire[] {
  return edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    heldSource: sideOfHandle(edge.sourceHandle),
    heldTarget: sideOfHandle(edge.targetHandle),
  }));
}

const boxOf = (obstacle: LoomObstacle) => ({ x: obstacle.x, y: obstacle.y, width: obstacle.width, height: obstacle.height });

/** Which cards differ between two publications, for the armed recorder only. */
function obstacleChanges(before: ReadonlyArray<LoomObstacle>, after: ReadonlyArray<LoomObstacle>) {
  const was = new Map(before.map((obstacle) => [obstacle.nodeId, obstacle] as const));
  const changed: Array<{ nodeId: string; before: ReturnType<typeof boxOf> | null; after: ReturnType<typeof boxOf> | null }> = [];
  for (const obstacle of after) {
    const old = was.get(obstacle.nodeId);
    was.delete(obstacle.nodeId);
    if (old && old.x === obstacle.x && old.y === obstacle.y && old.width === obstacle.width && old.height === obstacle.height) continue;
    changed.push({ nodeId: obstacle.nodeId, before: old ? boxOf(old) : null, after: boxOf(obstacle) });
  }
  for (const gone of was.values()) changed.push({ nodeId: gone.nodeId, before: boxOf(gone), after: null });
  return changed;
}

function publishObstacles(obstacles: LoomObstacle[], dragging: ReadonlyArray<string>): void {
  const previous = loomObstacles$.peek();
  const equal = !shouldPublishObstacles(previous, obstacles);
  canvasPerformance.recordObstaclePublication(equal);
  if (!equal && canvasPerformance.armed()) {
    canvasPerformance.recordObstacleChange({ dragging, changed: obstacleChanges(previous, obstacles) });
  }
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
const NOT_DRAGGING: ReadonlySet<string> = new Set();

const TRIGGER_OF = { moved: "geometry", changed: "edge-change", dragged: "drag" } as const;

function publishStandaloneRoutes(
  inputs: ReadonlyArray<LoomEdgeInput>,
  obstacles: ReadonlyArray<LoomObstacle>,
  strandIds: ReadonlySet<string>,
  /** The wires to route, each with why; every wire, as a first plan, when absent. */
  scope?: ReadonlyMap<string, RouteCause>,
): void {
  const scopeIds = scope ? new Set(scope.keys()) : undefined;
  const { routes } = routesForTick({
    dragging: NOT_DRAGGING,
    edges: inputs,
    obstacles,
    strandIds,
    ...(scopeIds ? { scope: scopeIds } : {}),
    routeWire,
    // The counters keep why each wire was routed, under the names they
    // already have: a card moved (geometry), the wire itself changed
    // (edge-change), a drag had taken its route (drag), or a first plan.
    onRouteWire: (edgeId) =>
      canvasPerformance.recordRouteWire(edgeId, scope ? TRIGGER_OF[scope.get(edgeId) ?? "moved"] : "initial"),
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
/** What the loom reads of an edge: a new array of the same wires changes nothing. */
const sameWires = (
  a: { readonly edges: ReadonlyArray<FlowEdge> },
  b: { readonly edges: ReadonlyArray<FlowEdge> },
): boolean => {
  if (a.edges === b.edges) return true;
  if (a.edges.length !== b.edges.length) return false;
  for (let i = 0; i < a.edges.length; i++) {
    const x = a.edges[i]!;
    const y = b.edges[i]!;
    if (x === y) continue;
    if (
      x.id !== y.id ||
      x.source !== y.source ||
      x.target !== y.target ||
      x.sourceHandle !== y.sourceHandle ||
      x.targetHandle !== y.targetHandle
    ) {
      return false;
    }
  }
  return true;
};

export const CanvasLoom = memo(CanvasLoomBody, sameWires);

function CanvasLoomBody({ edges }: { readonly edges: ReadonlyArray<FlowEdge> }) {
  const geometry = useStore(
    (store) => readGeometry(store.nodeLookup.values() as Iterable<RouteNode>),
    sameGeometry,
  );
  const specs = useMemo(() => specsOf(wiresOf(edges), geometry), [edges, geometry]);
  const specsKey = useMemo(() => specsKeyOf(specs), [specs]);
  // The key is the effect dependency; the specs themselves ride a ref so a new
  // edges array with identical topology never replans.
  const specsRef = useRef(specs);
  specsRef.current = specs;
  // Non-null while the plan is frozen, holding the dragged-node signature.
  const freezeRef = useRef<string | null>(null);
  // Geometry and topology the standing plan was built from.
  const plannedRef = useRef<{ geometry: LoomNode[]; specsKey: string } | null>(null);
  // The cards the standing standalone routes were worked out against, and
  // each wire as it was then. Kept through a drag, so the plan on drop can
  // tell which wires a moved card can have changed. Wires are compared one by
  // one: a wire's sides follow where its cards sit, so a drop changes the
  // sides of the wires it moved and of no other.
  const routedRef = useRef<{
    geometry: LoomNode[];
    obstacles: LoomObstacle[];
    specs: ReadonlyMap<string, string>;
  } | null>(null);
  // Wires a drag took the planned route from, owed a route at the next plan.
  const freshlyDropped = useRef<Set<string>>(new Set());

  useEffect(() => {
    canvasPerformance.recordLoomEffect();
    const obstacles = collectObstacles(geometry);
    publishObstacles(obstacles, geometry.filter((node) => node.dragging).map((node) => node.nodeId));

    const specsNow = specsRef.current;
    const activeIds = new Set(specsNow.map((spec) => spec.id));
    // Drop keyed residue for edges that left the rendered set.
    pruneKeyedLoomEntries(activeIds);

    const dragging = geometry.filter((node) => node.dragging).map((node) => node.nodeId);

    if (dragging.length > 0) {
      // Frozen fan plan during drag. Incident edges drop their strand once and
      // their planned route once, and are not routed again until the drop.
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
      const { inputs, lanes } = buildInputs(specsNow, geometry);
      publishKeyedLanes(lanes);
      // Nothing is routed while the pointer is down. A wire touching a moving
      // card gives up its planned route once and draws as the plain elbow on
      // its live ends; the route around obstacles is worked out on drop.
      const { drop } = routesForTick({
        dragging: moving,
        edges: inputs,
        obstacles,
        strandIds: NOT_DRAGGING,
      });
      const heldRoutes = loomRoutes$.peek();
      batch(() => {
        for (const id of drop) {
          freshlyDropped.current.add(id);
          if (heldRoutes[id]) loomRoutes$[id]!.delete();
        }
      });
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

    const wasStrand = new Set(Object.keys(loomStrands$.peek()));
    publishStrands(plan.strands);
    publishCorridors(plan.corridors);

    const strandIds = new Set(plan.strands.keys());
    const routed = routedRef.current;
    const specsById = new Map(specsNow.map((spec) => [spec.id, specKeyOf(spec)] as const));
    if (routed) {
      // Only the wires this plan owes a route are routed. Every other wire
      // keeps the route it has.
      const scope = routesOwedWithCause({
        edges: inputs,
        specsBefore: routed.specs,
        specsNow: specsById,
        obstaclesBefore: routed.obstacles,
        obstaclesNow: obstacles,
        movedNodeIds: movedNodeIds(routed.geometry, geometry),
        dropped: freshlyDropped.current,
        strandsBefore: wasStrand,
        strandsNow: strandIds,
      });
      publishStandaloneRoutes(inputs, obstacles, strandIds, scope);
    } else {
      publishStandaloneRoutes(inputs, obstacles, strandIds);
    }
    freshlyDropped.current = new Set();
    routedRef.current = { geometry, obstacles, specs: specsById };

    plannedRef.current = { geometry, specsKey };
  }, [geometry, specsKey]);

  return null;
}
