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
  /** The view moved: route what is still owed from the new one outwards. */
  readonly focus: (view: Rect) => void;
  /** Wires the plan still owes a route. */
  readonly owed: () => number;
  /** Forget everything: the next plan is a first plan and returns every fact. */
  readonly reset: () => void;
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

export const createLoomPlanner = (): LoomPlanner => {
  // Geometry and topology the standing plan was built from.
  let planned: { geometry: LoomNode[]; specsKey: string } | undefined;
  // The cards the standing routes were worked out against, and each wire as it
  // was then, so the next plan can tell which wires a change can have altered.
  let routed:
    | { geometry: LoomNode[]; obstacles: ReturnType<typeof collectObstacles>; specs: ReadonlyMap<string, string> }
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
    const carried = new Set(queue);

    // Settled geometry and topology already planned: nothing more is owed
    // than what the last plan had left.
    if (planned && planned.specsKey === specsKey && sameGeometry(planned.geometry, geometry)) {
      order();
      return NOTHING;
    }

    const obstacles = collectObstacles(geometry);
    const { inputs, lanes } = buildInputs(specs, geometry);
    lanesNow = lanes;
    const loom = planLoom({ edges: inputs, obstacles });
    const wasStrand = new Set(strands.keys());
    strands = loom.strands;
    const strandIds = new Set(loom.strands.keys());
    const specsById = new Map(specs.map((spec) => [spec.id, specKeyOf(spec)] as const));
    const live = new Set(specs.map((spec) => spec.id));
    for (const id of [...routes.keys()]) if (!live.has(id)) routes.delete(id);

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
      if (!live.has(id)) continue;
      if (strandIds.has(id)) {
        routes.delete(id);
        continue;
      }
      queue.push(id);
    }
    order();
    routed = { geometry, obstacles, specs: specsById };
    planned = { geometry, specsKey };

    // Every wire that owes no route sends its fact now; an owed wire keeps
    // the fact it had (the engine draws it as the elbow while its card is
    // off its anchors) until its route is worked out.
    const waiting = new Set(queue);
    const set: WireRouteFact[] = [];
    send(
      inputs.filter((input) => !waiting.has(input.id)).map((input) => input.id),
      set,
    );
    const remove: WireId[] = [];
    for (const id of [...held.keys()]) {
      if (live.has(id)) continue;
      held.delete(id);
      remove.push(id);
    }
    return { set, remove };
  };

  const step: LoomPlanner["step"] = (budgetMs, clock) => {
    if (queue.length === 0) return NOTHING;
    const started = clock();
    const done: string[] = [];
    do {
      const id = queue.pop()!;
      const input = inputsNow.get(id)!;
      const planned$ = routesForTick({
        dragging: NOT_DRAGGING,
        edges: [input],
        obstacles: obstaclesNow,
        strandIds: strandIdsNow,
        routeWire,
      }).routes;
      const route = planned$.get(id);
      if (route === undefined) routes.delete(id);
      else routes.set(id, route);
      done.push(id);
    } while (queue.length > 0 && clock() - started < budgetMs);
    const set: WireRouteFact[] = [];
    send(done, set);
    return { set, remove: [] };
  };

  const plan: LoomPlanner["plan"] = (cards, rows) => {
    const first = begin(cards, rows, view);
    const set = [...first.set];
    while (queue.length > 0) set.push(...step(Number.POSITIVE_INFINITY, () => 0).set);
    return { set, remove: first.remove };
  };

  const focus: LoomPlanner["focus"] = (next) => {
    view = next;
    order();
  };

  const reset = (): void => {
    planned = undefined;
    routed = undefined;
    strands = new Map();
    routes.clear();
    held.clear();
    lanesNow = new Map();
    inputsNow = new Map();
    rectsNow = new Map();
    obstaclesNow = [];
    strandIdsNow = new Set();
    queue = [];
  };

  return { plan, begin, step, focus, owed: () => queue.length, reset };
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
