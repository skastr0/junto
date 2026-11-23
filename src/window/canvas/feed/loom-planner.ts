/**
 * The loom planner (architecture section 13): today's planners, fed from the
 * model instead of React Flow's node lookup. No React, no observable, no
 * store: it is pure, so the feed can run it in a worker (feed/loom-worker.ts)
 * and the first frame never waits on routing (issue 912).
 *
 * From card rectangles and wires it works out each wire's sides, its pair
 * lane, whether it is a strand of a cable, a planned route around cards, or
 * neither (the engine draws the elbow between the anchors). It keeps what it
 * planned, so a later plan routes only the wires a change can have altered
 * (`ROUTE_REACH`), and sends exactly the facts that differ from before.
 *
 * A plan runs in steps. `begin` lays out the cables and lanes and sends every
 * fact that needs no routing; each `step` routes the owed wires nearest the
 * operator's view first, for as long as its budget allows, and sends their
 * facts. A wire has no fact until its own is sent, and the engine draws a
 * wire with no fact as nothing, so no wire changes shape by itself: it
 * appears once, routed. A new `begin` before the last plan finished carries
 * the wires it still owed into the new one.
 *
 * Every call here is a settled board: a card being dragged lives in the
 * engine and the model only moves on drop. The engine draws a wire whose ends
 * have left the plan's anchors as the elbow, which is what the old canvas did
 * during a drag.
 */
import type { Node, Side } from "@shared/model";
import { renderedNodeSize } from "@shared/node-geometry";
import type { WireDirection } from "@shared/wire-route";
import { routeWire } from "@shared/wire-route";
import type { Point, Rect, WireId, WireRouteFact } from "../contract";
import type { WireRect } from "@shared/wire-route";
import { createObstacleIndex, type ObstacleIndex } from "@shared/wire-obstacles";
import { routesForTick, routesOwedWithCause, type LoomLane, type LoomRoute } from "../../lib/loom-view";
import { planLoom, stitchStrand, type LoomEdgeInput, type LoomStrand } from "../../lib/wire-loom";
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
import { handleEnd } from "../paint/wires/route";
import { LOOM_ROUTER_VERSION, loomSeedFact, loomSeedTrusted, type LoomSeed, type LoomSeedCard, type LoomSeedChange, type LoomSeedWire } from "./loom-seed";

/** What the planner reads of a card: its board rectangle, and whether it is a region. */
export type LoomCard = {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** A region is geography, not furniture to route around: wires live inside it. */
  readonly region: boolean;
};

/** What the planner reads of a wire. */
export type LoomWireRow = {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  /** The sides the row holds; absent means the default socket (`right` to `left`). */
  readonly fromSide?: Side | undefined;
  readonly toSide?: Side | undefined;
};

export type LoomUpdate = {
  readonly set: ReadonlyArray<WireRouteFact>;
  readonly remove: ReadonlyArray<WireId>;
  /** The sending run's counters so far (loom-run), for the boot measurement. */
  readonly stats?: LoomPlannerStats & { readonly share: number };
  /** Wires this run still owes a route after the slice. */
  readonly owed?: number;
};

/** What a planner has done since it was made, for the boot measurement (issue 912). */
export type LoomPlannerStats = {
  /** Plans begun: one per board that changed what is routed. */
  readonly begins: number;
  /** Time inside `begin`: cables, lanes, obstacles and what is owed. */
  readonly beginMs: number;
  /** Wires routed, counting a wire each time it is routed. */
  readonly routed: number;
  /** Of those, routes of a wire this planner had routed before. */
  readonly rerouted: number;
  /** Time inside `step`, routing. */
  readonly routeMs: number;
  /** Obstacle grids built: one per plan begun, none per wire. */
  readonly indexes: number;
};

export type LoomPlanner = {
  /** Plan the settled board whole; returns the facts that changed since the last call. */
  readonly plan: (cards: ReadonlyArray<LoomCard>, wires: ReadonlyArray<LoomWireRow>) => LoomUpdate;
  /**
   * Start a plan: lay out cables and lanes, and return the facts that need no
   * routing. `view` is the board rectangle on screen; the owed wires are
   * routed from it outwards.
   */
  readonly begin: (cards: ReadonlyArray<LoomCard>, wires: ReadonlyArray<LoomWireRow>, view?: Rect) => LoomUpdate;
  /**
   * Route owed wires, nearest the view first, until `budgetMs` of `clock`
   * has passed (at least one wire per call), and return their facts.
   */
  readonly step: (budgetMs: number, clock: () => number) => LoomUpdate;
  /** The view moved: the wires still owed in it are routed first, then outwards from it. */
  readonly routeFirst: (view: Rect) => void;
  /** Wires the plan still owes a route. */
  readonly owed: () => number;
  /**
   * Start from a stored seed: the planner's diff says nothing is owed, and
   * the first begin hands the seed's facts to the engine once.
   */
  readonly seed: (seed: LoomSeed) => void;
  /** The settled state as a seed, with this planner's share of the facts. */
  readonly snapshot: () => LoomSeedChange;
  /** Forget everything: the next plan is a first plan and returns every fact. */
  readonly reset: () => void;
  readonly stats: () => LoomPlannerStats;
};

/**
 * One planner's part of the board when several route it side by side (issue
 * 912): each plans the whole board, so every route sees the same cables,
 * lanes and obstacles, but routes and sends only the wires it owns.
 */
export type LoomShare = { readonly index: number; readonly count: number };

/** The share a wire belongs to: a hash of its id, so it never changes hands. */
export const shareOf = (id: string, count: number): number => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % count;
};

const NOT_DRAGGING: ReadonlySet<string> = new Set();
const NO_SHIFT: Point = { x: 0, y: 0 };
const NOTHING: LoomUpdate = { set: [], remove: [] };

const point = (p: Point): Point => ({ x: p.x, y: p.y });

const samePoints = (a: ReadonlyArray<Point> | undefined, b: ReadonlyArray<Point> | undefined): boolean => {
  if (a === b) return true;
  if (a === undefined || b === undefined || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.x !== b[i]!.x || a[i]!.y !== b[i]!.y) return false;
  }
  return true;
};

const sameFact = (a: WireRouteFact, b: WireRouteFact): boolean =>
  a.sourceSide === b.sourceSide &&
  a.targetSide === b.targetSide &&
  a.cable === b.cable &&
  a.source.x === b.source.x &&
  a.source.y === b.source.y &&
  a.target.x === b.target.x &&
  a.target.y === b.target.y &&
  a.lane.source.x === b.lane.source.x &&
  a.lane.source.y === b.lane.source.y &&
  a.lane.target.x === b.lane.target.x &&
  a.lane.target.y === b.lane.target.y &&
  samePoints(a.points, b.points);

const geometryOf = (cards: ReadonlyArray<LoomCard>): LoomNode[] =>
  cards.map((card) => ({
    nodeId: card.id,
    x: card.x,
    y: card.y,
    width: card.width,
    height: card.height,
    obstacle: !card.region,
    dragging: false,
  }));

const wiresOf = (rows: ReadonlyArray<LoomWireRow>): LoomWire[] =>
  rows.map((row) => ({
    id: row.id,
    source: row.from,
    target: row.to,
    heldSource: (row.fromSide ?? "right") satisfies WireDirection,
    heldTarget: (row.toSide ?? "left") satisfies WireDirection,
  }));

/**
 * How far a wire is from the view, for the order owed wires are routed in:
 * zero for one whose anchors' box meets the view, else the distance from the
 * view's centre to the box's.
 */
const distanceFrom = (view: Rect | undefined, input: LoomEdgeInput): number => {
  if (view === undefined) return 0;
  const minX = Math.min(input.sourceAnchor.x, input.targetAnchor.x);
  const maxX = Math.max(input.sourceAnchor.x, input.targetAnchor.x);
  const minY = Math.min(input.sourceAnchor.y, input.targetAnchor.y);
  const maxY = Math.max(input.sourceAnchor.y, input.targetAnchor.y);
  if (maxX >= view.x && minX <= view.x + view.width && maxY >= view.y && minY <= view.y + view.height) return 0;
  return Math.hypot((minX + maxX) / 2 - (view.x + view.width / 2), (minY + maxY) / 2 - (view.y + view.height / 2));
};

/** An order-independent key of the board's rectangles: the seed's rows mirror it. */
const geometryKeyOf = (nodes: ReadonlyArray<LoomNode>): number => {
  let sum = 0;
  for (const node of nodes) {
    let local = 0x811c9dc5;
    const mix = (value: number): void => {
      local ^= Math.round(value * 100) | 0;
      local = Math.imul(local, 0x01000193);
    };
    for (let index = 0; index < node.nodeId.length; index += 1) mix(node.nodeId.charCodeAt(index));
    mix(node.x);
    mix(node.y);
    mix(node.width);
    mix(node.height);
    mix(node.obstacle ? 1 : 0);
    sum = (sum + local) | 0;
  }
  return sum;
};

export const createLoomPlanner = (share?: LoomShare): LoomPlanner => {
  const owns = (id: string): boolean => share === undefined || share.count <= 1 || shareOf(id, share.count) === share.index;
  // Geometry and topology the standing plan was built from, as keys so the
  // seed's row order never matters.
  let planned: { geometryKey: number; specsKey: string } | undefined;
  // The cards the standing routes were worked out against, and each wire as it
  // was then, so the next plan can tell which wires a change can have altered.
  let routed:
    | {
        geometry: LoomNode[];
        obstacles: ReturnType<typeof collectObstacles>;
        specs: ReadonlyMap<string, string>;
        strands: ReadonlySet<string>;
      }
    | undefined;
  let strands: ReadonlyMap<string, LoomStrand> = new Map();
  let lanesNow: ReadonlyMap<string, LoomLane> = new Map();
  const routes = new Map<string, LoomRoute>();
  const held = new Map<string, WireRouteFact>();
  // The plan under way: its inputs, obstacles and cable members, and the
  // wires it still owes a route, nearest the view first.
  let inputsNow = new Map<string, LoomEdgeInput>();
  let rectsNow = new Map<string, LoomNode>();
  let obstaclesNow: ReturnType<typeof collectObstacles> = [];
  // The obstacles in a grid, built once per plan: each wire reads only the
  // cards near its corridor (issue 912). Built on the first step that needs it.
  let indexNow: ObstacleIndex<ReturnType<typeof collectObstacles>[number]> | undefined;
  const counts = { begins: 0, beginMs: 0, routed: 0, rerouted: 0, routeMs: 0, indexes: 0 };
  const routedOnce = new Set<string>();
  // A seeded launch hands the stored facts over once, then plans as usual.
  let replay: ReadonlyArray<WireRouteFact> | undefined;
  let planMeta: { readonly fingerprint: number; readonly specsKey: string; readonly geometryKey: number } | undefined;
  let seededCards: ReadonlyMap<string, LoomSeedCard> | undefined;
  let seededWires: ReadonlyMap<string, { readonly specKey: string; readonly fact: string }> | undefined;
  let seededGeometry: ReadonlyArray<LoomNode> = [];
  let strandIdsNow: ReadonlySet<string> = new Set();
  let queue: string[] = [];
  let view: Rect | undefined;

  const factOf = (input: LoomEdgeInput): WireRouteFact => {
    const strand = strands.get(input.id);
    const route = routes.get(input.id);
    // A cable member is stitched to where the wire meets its handle (the
    // handle box's outer edge), as the old canvas stitches it to the live
    // handle; a planned route is drawn as planned.
    const ends = strand
      ? {
          source: handleEnd(rectsNow.get(input.sourceNodeId)!, input.sourceSide, "source"),
          target: handleEnd(rectsNow.get(input.targetNodeId)!, input.targetSide, "target"),
        }
      : undefined;
    const points =
      strand && ends
        ? stitchStrand(strand, {
            sourceX: ends.source.x,
            sourceY: ends.source.y,
            targetX: ends.target.x,
            targetY: ends.target.y,
          }).points
        : route?.points;
    return {
      id: input.id,
      sourceSide: input.sourceSide,
      targetSide: input.targetSide,
      source: point(input.sourceAnchor),
      target: point(input.targetAnchor),
      lane: {
        source: point(lanesNow.get(input.id)?.source ?? NO_SHIFT),
        target: point(lanesNow.get(input.id)?.target ?? NO_SHIFT),
      },
      ...(points ? { points: points.map(point) } : {}),
      cable: strand !== undefined,
    };
  };

  /** The facts of these wires that differ from what was last sent. */
  const send = (ids: Iterable<string>, set: WireRouteFact[]): void => {
    for (const id of ids) {
      const input = inputsNow.get(id);
      if (input === undefined) continue;
      const fact = factOf(input);
      const before = held.get(id);
      if (before !== undefined && sameFact(before, fact)) continue;
      held.set(id, fact);
      set.push(fact);
    }
  };

  const order = (): void => {
    const distance = new Map(queue.map((id) => [id, distanceFrom(view, inputsNow.get(id)!)] as const));
    // Routed from the end of the array: the nearest wire goes last.
    queue.sort((a, b) => distance.get(b)! - distance.get(a)!);
  };

  const begin: LoomPlanner["begin"] = (cards, rows, at) => {
    // A board posted before the page drew a frame carries no view; the view
    // the first frame sent, which can arrive first, still stands.
    if (at !== undefined) view = at;
    const geometry = geometryOf(cards);
    const specs = specsOf(wiresOf(rows), geometry);
    const specsKey = specsKeyOf(specs);
    const geometryKey = geometryKeyOf(geometry);
    const carried = new Set(queue);

    // Settled geometry and topology already planned: nothing more is owed
    // than what the last plan had left.
    if (planned && planned.specsKey === specsKey && planned.geometryKey === geometryKey) {
      order();
      if (replay !== undefined) {
        // The engine has no facts yet; the seed's are exactly what it draws.
        const set = replay.filter((fact) => owns(fact.id));
        for (const fact of set) held.set(fact.id, fact);
        replay = undefined;
        return { set, remove: [] };
      }
      return NOTHING;
    }

    const begun = performance.now();
    counts.begins += 1;
    const obstacles = collectObstacles(geometry);
    indexNow = undefined;
    const { inputs, lanes } = buildInputs(specs, geometry);
    lanesNow = lanes;
    const loom = planLoom({ edges: inputs, obstacles });
    planMeta = { fingerprint: loom.fingerprint, specsKey, geometryKey };
    replay = undefined;
    strands = loom.strands;
    const strandIds = new Set(loom.strands.keys());
    const specsById = new Map(specs.map((spec) => [spec.id, specKeyOf(spec)] as const));
    const live = new Set(specs.map((spec) => spec.id));
    for (const id of [...routes.keys()]) if (!live.has(id)) routes.delete(id);

    // The seed's cable flags are the previous plan's strands; a first plan
    // has none.
    const wasStrand = new Set(routed?.strands ?? []);
    const scope = routed
      ? routesOwedWithCause({
          edges: inputs,
          specsBefore: routed.specs,
          specsNow: specsById,
          obstaclesBefore: routed.obstacles,
          obstaclesNow: obstacles,
          movedNodeIds: movedNodeIds(routed.geometry, geometry),
          dropped: NOT_DRAGGING,
          strandsBefore: wasStrand,
          strandsNow: strandIds,
        })
      : undefined;

    inputsNow = new Map(inputs.map((input) => [input.id, input] as const));
    rectsNow = new Map(geometry.map((node) => [node.nodeId, node] as const));
    obstaclesNow = obstacles;
    strandIdsNow = strandIds;
    // Owed: what the change can have altered (every wire on a first plan),
    // and what the last plan had not reached. A cable member is stitched,
    // not routed, and a wire that left is owed nothing.
    const owed = new Set<string>();
    if (scope === undefined) {
      routes.clear();
      for (const input of inputs) owed.add(input.id);
    } else {
      for (const id of scope.keys()) owed.add(id);
    }
    for (const id of carried) owed.add(id);
    queue = [];
    for (const id of owed) {
      if (!live.has(id) || !owns(id)) continue;
      if (strandIds.has(id)) {
        routes.delete(id);
        continue;
      }
      queue.push(id);
    }
    order();
    routed = { geometry, obstacles, specs: specsById, strands: strandIds };
    planned = { geometryKey, specsKey };
    seededGeometry = geometry;

    // Every wire that owes no route sends its fact now; an owed wire keeps
    // the fact it had (the engine draws it as the elbow while its card is
    // off its anchors) until its route is worked out.
    const waiting = new Set(queue);
    const set: WireRouteFact[] = [];
    send(
      inputs.filter((input) => owns(input.id) && !waiting.has(input.id)).map((input) => input.id),
      set,
    );
    const remove: WireId[] = [];
    for (const id of [...held.keys()]) {
      if (live.has(id)) continue;
      held.delete(id);
      remove.push(id);
    }
    counts.beginMs += performance.now() - begun;
    return { set, remove };
  };

  const obstacleIndex = (): ObstacleIndex<ReturnType<typeof collectObstacles>[number]> => {
    if (indexNow === undefined) {
      indexNow = createObstacleIndex(obstaclesNow.filter((rect) => rect.width > 0 && rect.height > 0));
      counts.indexes += 1;
    }
    return indexNow;
  };

  const step: LoomPlanner["step"] = (budgetMs, clock) => {
    if (queue.length === 0) return NOTHING;
    const started = clock();
    const routing = performance.now();
    const index = obstacleIndex();
    const done: string[] = [];
    do {
      const id = queue.pop()!;
      const input = inputsNow.get(id)!;
      const planned$ = routesForTick({
        dragging: NOT_DRAGGING,
        edges: [input],
        obstacles: obstaclesNow,
        index,
        strandIds: strandIdsNow,
        routeWire,
      }).routes;
      counts.routed += 1;
      if (routedOnce.has(id)) counts.rerouted += 1;
      else routedOnce.add(id);
      const route = planned$.get(id);
      if (route === undefined) routes.delete(id);
      else routes.set(id, route);
      done.push(id);
    } while (queue.length > 0 && clock() - started < budgetMs);
    const set: WireRouteFact[] = [];
    send(done, set);
    counts.routeMs += performance.now() - routing;
    return { set, remove: [] };
  };

  const plan: LoomPlanner["plan"] = (cards, rows) => {
    const first = begin(cards, rows, view);
    const set = [...first.set];
    while (queue.length > 0) set.push(...step(Number.POSITIVE_INFINITY, () => 0).set);
    return { set, remove: first.remove };
  };

  const routeFirst: LoomPlanner["routeFirst"] = (next) => {
    view = next;
    order();
  };

  const seed: LoomPlanner["seed"] = (stored) => {
    if (!loomSeedTrusted(stored)) return;
    const geometry: LoomNode[] = stored.cards.map((card) => ({
      nodeId: card.nodeId,
      x: card.x,
      y: card.y,
      width: card.width,
      height: card.height,
      obstacle: card.obstacle,
      dragging: false,
    }));
    const obstacles = collectObstacles(geometry);
    const specs = new Map(stored.wires.map((wire) => [wire.wireId, wire.specKey] as const));
    // Only the facts this planner owns are parsed and drawn here; every
    // worker gets the same cards and meta, and its share of the wires.
    const facts: WireRouteFact[] = [];
    const cableStrands = new Set<string>();
    for (const wire of stored.wires) {
      if (!owns(wire.wireId)) continue;
      const fact = loomSeedFact(wire);
      facts.push(fact);
      if (fact.cable) cableStrands.add(wire.wireId);
    }
    planned = { geometryKey: stored.meta.geometryKey, specsKey: stored.meta.specsKey };
    routed = { geometry, obstacles, specs, strands: cableStrands };
    obstaclesNow = obstacles;
    indexNow = undefined;
    strands = new Map();
    routes.clear();
    lanesNow = new Map();
    held.clear();
    queue = [];
    inputsNow = new Map();
    rectsNow = new Map();
    strandIdsNow = new Set();
    replay = facts;
    planMeta = { fingerprint: stored.meta.fingerprint, specsKey: stored.meta.specsKey, geometryKey: stored.meta.geometryKey };
    seededGeometry = geometry;
    seededCards = new Map(stored.cards.map((card) => [card.nodeId, card] as const));
    seededWires = new Map(stored.wires.map((wire) => [wire.wireId, { specKey: wire.specKey, fact: wire.fact }] as const));
    seededGeometry = geometry;
  };

  const snapshot: LoomPlanner["snapshot"] = () => {
    const cards: LoomSeedCard[] = [];
    const removedCards: string[] = [];
    const current = new Map<string, LoomSeedCard>();
    for (const node of seededGeometry) {
      current.set(node.nodeId, {
        nodeId: node.nodeId,
        x: node.x,
        y: node.y,
        width: node.width,
        height: node.height,
        obstacle: node.obstacle,
      });
    }
    for (const [id, row] of current) {
      const before = seededCards?.get(id);
      if (
        before === undefined ||
        before.x !== row.x ||
        before.y !== row.y ||
        before.width !== row.width ||
        before.height !== row.height ||
        before.obstacle !== row.obstacle
      ) {
        cards.push(row);
      }
    }
    for (const id of seededCards?.keys() ?? []) if (!current.has(id)) removedCards.push(id);
    const wires: LoomSeedWire[] = [];
    const removedWires: string[] = [];
    for (const [id, fact] of held) {
      const specKey = routed?.specs.get(id) ?? "";
      const json = JSON.stringify(fact);
      const before = seededWires?.get(id);
      if (before === undefined || before.specKey !== specKey || before.fact !== json) {
        wires.push({ wireId: id, specKey, fact: json });
      }
    }
    for (const id of seededWires?.keys() ?? []) if (!held.has(id)) removedWires.push(id);
    return {
      meta: planMeta ?? { fingerprint: 0, specsKey: "", geometryKey: 0 },
      cards,
      wires,
      removedCards,
      removedWires,
    };
  };

  const reset = (): void => {
    replay = undefined;
    planMeta = undefined;
    seededCards = undefined;
    seededWires = undefined;
    seededGeometry = [];
    planned = undefined;
    routed = undefined;
    strands = new Map();
    routes.clear();
    held.clear();
    lanesNow = new Map();
    inputsNow = new Map();
    rectsNow = new Map();
    obstaclesNow = [];
    indexNow = undefined;
    strandIdsNow = new Set();
    queue = [];
  };

  return { plan, begin, step, routeFirst, owed: () => queue.length, seed, snapshot, reset, stats: () => ({ ...counts }) };
};

/**
 * A card row as the planner reads it, at the rectangle the canvas draws: a
 * seat or kind seat renders at its fixed footprint whatever its stored size,
 * and routing around the stored rectangle would miss it (and leave every
 * seat wire on the fallback elbow, because the plan's anchors would never
 * match the live card).
 */
export const cardOf = (node: Node): LoomCard => {
  const size = renderedNodeSize(node.kind, node);
  return {
    id: node.id,
    x: node.x,
    y: node.y,
    width: size.width,
    height: size.height,
    region: node.kind === "region",
  };
};
