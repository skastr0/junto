/**
 * Loom view state — CanvasLoom plans geometry once per tick; edges subscribe
 * only to their own keyed strand and route.
 *
 * Paint and geometry only. Nothing here reads or writes grants, ports,
 * physics, or ether fields.
 */
import { batch, observable } from "@legendapp/state";
import {
  corridorsClearOf,
  type LoomEdgeInput,
  type LoomObstacle,
  type LoomStrand,
} from "./wire-loom";
import {
  routeWire as defaultRouteWire,
  type WirePoint,
  type WireRect,
  type WireRouteResult,
} from "./wire-route";

/** Planned standalone (non-fan) route — same shape as routeWire result. */
export type LoomRoute = {
  readonly path: string;
  readonly labelX: number;
  readonly labelY: number;
  readonly detoured: boolean;
};

/**
 * Where a wire meets its handle, when it must not meet it dead centre.
 *
 * A shift in canvas units at each end, perpendicular to the side the wire
 * leaves from. Both paint paths owe it: the planner bakes it into the anchors
 * it routes between, and the plain smooth-step fallback — which `routeWire`
 * hands back an open field for, so it is the common case, not a failure —
 * applies it to the live handle coordinates.
 */
export type LoomLane = {
  readonly source: WirePoint;
  readonly target: WirePoint;
};

/** edgeId -> planned strand. Absent means the edge uses loomRoutes$ / fallback. */
export const loomStrands$ = observable<Record<string, LoomStrand>>({});

/** edgeId -> handle shift. Absent means the wire meets both handles centred. */
export const loomLanes$ = observable<Record<string, LoomLane>>({});

/**
 * edgeId -> standalone route planned once at the loom boundary.
 * Absent when the edge is a fan strand or routing failed (smooth-step fallback).
 */
export const loomRoutes$ = observable<Record<string, LoomRoute>>({});

/**
 * Every routable node rect from the last geometry tick. Owned by CanvasLoom for
 * planning only — EtherEdge must not subscribe to this array.
 */
export const loomObstacles$ = observable<LoomObstacle[]>([]);

/**
 * Trunk and comb bounds (stoppage clearance furniture). Planning-only; edges
 * must not subscribe — blocked routes bake corridor clearance into loomRoutes$.
 */
export const loomCorridors$ = observable<WireRect[]>([]);

// ---------------------------------------------------------------------------
// Value equality (equal input → no observable write)
// ---------------------------------------------------------------------------

export function sameObstacles(
  a: ReadonlyArray<LoomObstacle>,
  b: ReadonlyArray<LoomObstacle>,
): boolean {
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
      x.height !== y.height
    ) {
      return false;
    }
  }
  return true;
}

export function sameRects(
  a: ReadonlyArray<WireRect>,
  b: ReadonlyArray<WireRect>,
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.x !== y.x || x.y !== y.y || x.width !== y.width || x.height !== y.height) {
      return false;
    }
  }
  return true;
}

export function sameLoomRoute(a: LoomRoute, b: LoomRoute): boolean {
  return (
    a.path === b.path &&
    a.labelX === b.labelX &&
    a.labelY === b.labelY &&
    a.detoured === b.detoured
  );
}

export function samePoints(
  a: ReadonlyArray<{ readonly x: number; readonly y: number }>,
  b: ReadonlyArray<{ readonly x: number; readonly y: number }>,
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.x !== b[i]!.x || a[i]!.y !== b[i]!.y) return false;
  }
  return true;
}

export function sameLane(a: LoomLane, b: LoomLane): boolean {
  return (
    a.source.x === b.source.x &&
    a.source.y === b.source.y &&
    a.target.x === b.target.x &&
    a.target.y === b.target.y
  );
}

export function sameStrand(a: LoomStrand, b: LoomStrand): boolean {
  return (
    a.bundleKey === b.bundleKey &&
    a.hubEnd === b.hubEnd &&
    a.hubAxis === b.hubAxis &&
    a.laneIndex === b.laneIndex &&
    a.laneCount === b.laneCount &&
    a.laneOffset === b.laneOffset &&
    a.splayAt === b.splayAt &&
    a.stationAt === b.stationAt &&
    samePoints(a.lane, b.lane) &&
    samePoints(a.comb, b.comb)
  );
}

/** Whether publishing `next` would change the held obstacle field. */
export function shouldPublishObstacles(
  held: ReadonlyArray<LoomObstacle>,
  next: ReadonlyArray<LoomObstacle>,
): boolean {
  return !sameObstacles(held, next);
}

/** Whether publishing `next` would change the held corridor field. */
export function shouldPublishCorridors(
  held: ReadonlyArray<WireRect>,
  next: ReadonlyArray<WireRect>,
): boolean {
  return !sameRects(held, next);
}

// ---------------------------------------------------------------------------
// Central standalone routing (one planner, not N edge-local routeWire calls)
// ---------------------------------------------------------------------------

export type RouteWireFn = (input: {
  readonly source: { readonly x: number; readonly y: number };
  readonly target: { readonly x: number; readonly y: number };
  readonly obstacles: ReadonlyArray<WireRect>;
  readonly padding?: number;
  readonly borderRadius?: number;
  readonly sourceDirection?: LoomEdgeInput["sourceSide"];
  readonly targetDirection?: LoomEdgeInput["targetSide"];
}) => WireRouteResult | null;

/**
 * Route every non-strand edge once. Strand members are skipped (stitched live).
 * Blocked edges receive corridor furniture cleared of their own endpoints.
 */
export function planStandaloneRoutes(input: {
  readonly edges: ReadonlyArray<LoomEdgeInput>;
  readonly obstacles: ReadonlyArray<LoomObstacle>;
  readonly corridors: ReadonlyArray<WireRect>;
  readonly strandIds: ReadonlySet<string>;
  readonly routeWire?: RouteWireFn;
  /** Invoked once per edge that actually enters routeWire (injectable counters). */
  readonly onRouteWire?: (edgeId: string) => void;
}): Map<string, LoomRoute> {
  const route = input.routeWire ?? defaultRouteWire;
  const out = new Map<string, LoomRoute>();
  for (const edge of input.edges) {
    if (input.strandIds.has(edge.id)) continue;
    const base = input.obstacles.filter(
      (rect) => rect.nodeId !== edge.sourceNodeId && rect.nodeId !== edge.targetNodeId,
    );
    let obstacles: ReadonlyArray<WireRect> = base;
    if (edge.blocked && input.corridors.length > 0) {
      const clear = corridorsClearOf(input.corridors, [
        edge.sourceAnchor,
        edge.targetAnchor,
      ]);
      if (clear.length > 0) obstacles = [...base, ...clear];
    }
    input.onRouteWire?.(edge.id);
    const routed = route({
      source: edge.sourceAnchor,
      target: edge.targetAnchor,
      obstacles,
      padding: 14,
      borderRadius: 8,
      sourceDirection: edge.sourceSide,
      targetDirection: edge.targetSide,
    });
    if (!routed) continue;
    out.set(edge.id, {
      path: routed.path,
      labelX: routed.labelX,
      labelY: routed.labelY,
      detoured: routed.detoured,
    });
  }
  return out;
}

/**
 * Diff keyed routes against held state: preserve identity for equal paths,
 * collect sets/deletes without replacing the whole record.
 */
export function diffKeyedRoutes(
  held: Readonly<Record<string, LoomRoute>>,
  next: ReadonlyMap<string, LoomRoute>,
  /** When set, only these edge ids may be written/deleted (drag localization). */
  scopeIds?: ReadonlySet<string>,
): {
  readonly sets: ReadonlyArray<readonly [string, LoomRoute]>;
  readonly deletes: ReadonlyArray<string>;
  /** Held objects reused (identity stable). */
  readonly retained: ReadonlyArray<string>;
} {
  const sets: Array<readonly [string, LoomRoute]> = [];
  const deletes: string[] = [];
  const retained: string[] = [];

  for (const [id, route] of next) {
    if (scopeIds && !scopeIds.has(id)) continue;
    const prior = held[id];
    if (prior && sameLoomRoute(prior, route)) {
      retained.push(id);
      continue;
    }
    sets.push([id, route]);
  }

  for (const id of Object.keys(held)) {
    if (scopeIds && !scopeIds.has(id)) continue;
    if (!next.has(id)) deletes.push(id);
  }

  return { sets, deletes, retained };
}

/** Apply route diff to loomRoutes$ in one batch. */
export function publishKeyedRoutes(
  held: Readonly<Record<string, LoomRoute>>,
  next: ReadonlyMap<string, LoomRoute>,
  scopeIds?: ReadonlySet<string>,
): { readonly sets: number; readonly deletes: number; readonly retained: number } {
  const diff = diffKeyedRoutes(held, next, scopeIds);
  if (diff.sets.length === 0 && diff.deletes.length === 0) {
    return { sets: 0, deletes: 0, retained: diff.retained.length };
  }
  batch(() => {
    for (const id of diff.deletes) {
      loomRoutes$[id]!.delete();
    }
    for (const [id, route] of diff.sets) {
      loomRoutes$[id]!.set(route);
    }
  });
  return {
    sets: diff.sets.length,
    deletes: diff.deletes.length,
    retained: diff.retained.length,
  };
}

/** Apply a keyed lane diff — write only what changed, delete what left. */
export function publishKeyedLanes(next: ReadonlyMap<string, LoomLane>): void {
  const held = loomLanes$.peek();
  batch(() => {
    for (const id of Object.keys(held)) {
      if (!next.has(id)) loomLanes$[id]!.delete();
    }
    for (const [id, lane] of next) {
      const prior = held[id];
      if (prior && sameLane(prior, lane)) continue;
      loomLanes$[id]!.set(lane);
    }
  });
}

/** Delete keyed strand + route residue for edges no longer in the active set. */
export function pruneKeyedLoomEntries(activeEdgeIds: ReadonlySet<string>): void {
  batch(() => {
    for (const id of Object.keys(loomStrands$.peek())) {
      if (!activeEdgeIds.has(id)) loomStrands$[id]!.delete();
    }
    for (const id of Object.keys(loomRoutes$.peek())) {
      if (!activeEdgeIds.has(id)) loomRoutes$[id]!.delete();
    }
    for (const id of Object.keys(loomLanes$.peek())) {
      if (!activeEdgeIds.has(id)) loomLanes$[id]!.delete();
    }
  });
}
