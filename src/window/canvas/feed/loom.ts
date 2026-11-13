/**
 * The GPU canvas's loom (architecture section 13): today's planners, fed from
 * the model instead of React Flow's node lookup.
 *
 * `createLoomPlanner` is the settled-board half of `CanvasLoom`: from card
 * rectangles and wires it works out each wire's sides, its pair lane, whether
 * it is a strand of a cable, a planned route around cards, or neither (the
 * engine draws the fallback elbow between the anchors). It keeps what it
 * planned, so a later call routes only the wires a change can have altered
 * (`ROUTE_REACH`), and returns exactly the facts that differ from before.
 *
 * No React, no observable, no drag branch: a card being dragged lives in the
 * engine and the model only moves on drop, so every call here is a settled
 * board. The engine draws a wire whose ends have left the plan's anchors as
 * the fallback elbow, which is what the old canvas did during a drag.
 *
 * `retainWireRoutes` subscribes the model and sends `routes` ops.
 */
import { observe } from "@legendapp/state";
import type { Node, Side } from "@shared/model";
import type { WireDirection } from "@shared/wire-route";
import { routeWire } from "@shared/wire-route";
import type { Point, SceneOp, WireId, WireRouteFact } from "../contract";
import { routesForTick, routesOwedWithCause, type LoomRoute } from "../../lib/loom-view";
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
import { modelStore } from "../../lib/use-model";
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
  /** Plan the settled board; returns the facts that changed since the last call. */
  readonly plan: (cards: ReadonlyArray<LoomCard>, wires: ReadonlyArray<LoomWireRow>) => LoomUpdate;
  /** Forget everything: the next plan is a first plan and returns every fact. */
  readonly reset: () => void;
};

const NOT_DRAGGING: ReadonlySet<string> = new Set();

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

export const createLoomPlanner = (): LoomPlanner => {
  // Geometry and topology the standing plan was built from.
  let planned: { geometry: LoomNode[]; specsKey: string } | undefined;
  // The cards the standing routes were worked out against, and each wire as it
  // was then, so the next plan can tell which wires a change can have altered.
  let routed:
    | { geometry: LoomNode[]; obstacles: ReturnType<typeof collectObstacles>; specs: ReadonlyMap<string, string> }
    | undefined;
  let strands: ReadonlyMap<string, LoomStrand> = new Map();
  const routes = new Map<string, LoomRoute>();
  const held = new Map<string, WireRouteFact>();

  const factsFor = (
    inputs: ReadonlyArray<LoomEdgeInput>,
    geometry: ReadonlyArray<LoomNode>,
  ): Map<string, WireRouteFact> => {
    const facts = new Map<string, WireRouteFact>();
    const rects = new Map(geometry.map((node) => [node.nodeId, node] as const));
    for (const input of inputs) {
      const strand = strands.get(input.id);
      const route = routes.get(input.id);
      // A cable member is stitched to where the wire meets its handle (the
      // handle box's outer edge), as the old canvas stitches it to the live
      // handle; a planned route is drawn as planned.
      const ends = strand
        ? {
            source: handleEnd(rects.get(input.sourceNodeId)!, input.sourceSide, "source"),
            target: handleEnd(rects.get(input.targetNodeId)!, input.targetSide, "target"),
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
      facts.set(input.id, {
        id: input.id,
        sourceSide: input.sourceSide,
        targetSide: input.targetSide,
        source: point(input.sourceAnchor),
        target: point(input.targetAnchor),
        ...(points ? { points: points.map(point) } : {}),
        cable: strand !== undefined,
      });
    }
    return facts;
  };

  /** The facts that differ from what was last sent, and the wires that left. */
  const diff = (next: ReadonlyMap<string, WireRouteFact>): LoomUpdate => {
    const set: WireRouteFact[] = [];
    const remove: WireId[] = [];
    for (const [id, fact] of next) {
      const before = held.get(id);
      if (before === undefined || !sameFact(before, fact)) set.push(fact);
    }
    for (const id of held.keys()) if (!next.has(id)) remove.push(id);
    held.clear();
    for (const [id, fact] of next) held.set(id, fact);
    return { set, remove };
  };

  const plan: LoomPlanner["plan"] = (cards, rows) => {
    const geometry = geometryOf(cards);
    const specs = specsOf(wiresOf(rows), geometry);
    const specsKey = specsKeyOf(specs);

    // Settled geometry and topology already planned: nothing is routed.
    if (planned && planned.specsKey === specsKey && sameGeometry(planned.geometry, geometry)) {
      return { set: [], remove: [] };
    }

    const obstacles = collectObstacles(geometry);
    const { inputs } = buildInputs(specs, geometry);
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
    const scopeIds = scope ? new Set(scope.keys()) : undefined;
    const planned$ = routesForTick({
      dragging: NOT_DRAGGING,
      edges: inputs,
      obstacles,
      strandIds,
      ...(scopeIds ? { scope: scopeIds } : {}),
      routeWire,
    }).routes;

    if (scopeIds) {
      // Only the owed wires are written or deleted; every other wire keeps its route.
      for (const id of scopeIds) {
        const route = planned$.get(id);
        if (strandIds.has(id) || route === undefined) routes.delete(id);
        else routes.set(id, route);
      }
    } else {
      routes.clear();
      for (const [id, route] of planned$) routes.set(id, route);
    }
    routed = { geometry, obstacles, specs: specsById };
    planned = { geometry, specsKey };
    return diff(factsFor(inputs, geometry));
  };

  const reset = (): void => {
    planned = undefined;
    routed = undefined;
    strands = new Map();
    routes.clear();
    held.clear();
  };

  return { plan, reset };
};

/** A card row as the planner reads it. */
const cardOf = (node: Node): LoomCard => ({
  id: node.id,
  x: node.x,
  y: node.y,
  width: node.width,
  height: node.height,
  region: node.kind === "region",
});

/**
 * Plan the open canvas's wires on every change to its card rectangles or its
 * wires, and send what changed as one `routes` op. Returns the release.
 */
export const retainWireRoutes = (
  canvasName: string,
  emit: (ops: ReadonlyArray<SceneOp>) => void,
): (() => void) => {
  if (canvasName === "") return () => undefined;
  const planner = createLoomPlanner();
  const stop = observe(() => {
    const canvas = modelStore.canvas$(canvasName);
    const cards: LoomCard[] = [];
    for (const id of canvas.nodeIds.get()) {
      const node$ = canvas.nodes[id];
      // Track the fields the planner reads; nothing else re-runs it.
      node$.kind.get();
      node$.x.get();
      node$.y.get();
      node$.width.get();
      node$.height.get();
      const node = node$.peek();
      if (node !== undefined) cards.push(cardOf(node));
    }
    const rows: LoomWireRow[] = [];
    for (const id of canvas.wireIds.get()) {
      const wire$ = canvas.wires[id];
      wire$.from.get();
      wire$.to.get();
      wire$.fromSide.get();
      wire$.toSide.get();
      const wire = wire$.peek();
      if (wire !== undefined) rows.push({ id: wire.id, from: wire.from, to: wire.to, fromSide: wire.fromSide, toSide: wire.toSide });
    }
    const update = planner.plan(cards, rows);
    if (update.set.length > 0 || update.remove.length > 0) emit([{ kind: "routes", set: update.set, remove: update.remove }]);
  });
  return () => {
    stop();
    planner.reset();
  };
};
