/**
 * A drag routes nothing. While a card moves, the wires touching it draw as the
 * plain elbow on their live ends; the obstacle-avoiding route is worked out
 * once on drop, and then only for wires a moved card can have changed.
 */
import { describe, expect, it } from "vitest";
import {
  edgesTouchedByMove,
  incidentEdgeIds,
  movedObstacles,
  planStandaloneRoutes,
  routesForTick,
  routesOwed,
} from "../src/renderer/lib/loom-view";
import type { LoomEdgeInput, LoomObstacle } from "../src/renderer/lib/wire-loom";
import { routeWire } from "../src/renderer/lib/wire-route";

const COLS = 10;
const ROWS = 8;
const CARD = { width: 260, height: 96 };
const PITCH = { x: 340, y: 180 };

type Offsets = ReadonlyMap<string, { readonly x: number; readonly y: number }>;
const NONE: Offsets = new Map();

const idOf = (col: number, row: number): string => `seat-${col}-${row}`;

/** Cards on a grid, each moved by its offset. */
const cards = (offsets: Offsets = NONE): LoomObstacle[] => {
  const out: LoomObstacle[] = [];
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const nodeId = idOf(col, row);
      const moved = offsets.get(nodeId) ?? { x: 0, y: 0 };
      out.push({ nodeId, x: col * PITCH.x + moved.x, y: row * PITCH.y + moved.y, ...CARD });
    }
  }
  return out;
};

/** A wire from each card to the one on its right and the one below it. */
const wires = (held: ReadonlyArray<LoomObstacle>): LoomEdgeInput[] => {
  const at = new Map(held.map((card) => [card.nodeId, card] as const));
  const out: LoomEdgeInput[] = [];
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const from = at.get(idOf(col, row))!;
      const right = at.get(idOf(col + 1, row));
      const below = at.get(idOf(col, row + 1));
      if (right) {
        out.push({
          id: `${from.nodeId}>right`, blocked: false,
          sourceNodeId: from.nodeId, sourceSide: "right",
          sourceAnchor: { x: from.x + from.width, y: from.y + from.height / 2 },
          targetNodeId: right.nodeId, targetSide: "left",
          targetAnchor: { x: right.x, y: right.y + right.height / 2 },
        });
      }
      if (below) {
        out.push({
          id: `${from.nodeId}>below`, blocked: false,
          sourceNodeId: from.nodeId, sourceSide: "bottom",
          sourceAnchor: { x: from.x + from.width / 2, y: from.y + from.height },
          targetNodeId: below.nodeId, targetSide: "top",
          targetAnchor: { x: below.x + below.width / 2, y: below.y },
        });
      }
    }
  }
  return out;
};

const DRAGGED = [idOf(2, 2), idOf(3, 2), idOf(2, 3), idOf(3, 3)];
const MOVES = 90;
/** Where the dragged cards are after this many moves: across their neighbours. */
const dragOffsets = (move: number): Offsets =>
  new Map(DRAGGED.map((id) => [id, { x: move * 2, y: move }] as const));

const NO_STRANDS: ReadonlySet<string> = new Set();

describe("a drag of 4 cards over 90 moves on a canvas of 80 cards", () => {
  it("never calls the router while the pointer is down", () => {
    const dragging = new Set(DRAGGED);
    let calls = 0;
    const dropped = new Set<string>();
    for (let move = 1; move <= MOVES; move++) {
      const obstacles = cards(dragOffsets(move));
      const tick = routesForTick({
        dragging,
        edges: wires(obstacles),
        obstacles,
        corridors: [],
        strandIds: NO_STRANDS,
        routeWire: (input) => {
          calls++;
          return routeWire(input);
        },
      });
      expect(tick.routes.size).toBe(0);
      for (const id of tick.drop) dropped.add(id);
    }
    expect(calls).toBe(0);
    // The wires that gave up their route are the ones touching a dragged card.
    expect(dropped).toEqual(incidentEdgeIds(wires(cards()), dragging));
    expect(dropped.size).toBe(12);
  });

  it("on drop routes only the wires a moved card can have changed", () => {
    const before = cards();
    const after = cards(dragOffsets(MOVES));
    const edges = wires(after);
    const scope = edgesTouchedByMove(edges, movedObstacles(before, after));
    let calls = 0;
    routesForTick({
      dragging: new Set(),
      edges,
      obstacles: after,
      corridors: [],
      strandIds: NO_STRANDS,
      scope,
      routeWire: (input) => {
        calls++;
        return routeWire(input);
      },
    });
    expect(edges.length).toBe(142);
    expect(calls).toBe(scope.size);
    // Every wire touching a dragged card, some of their neighbours, and far
    // fewer than the canvas holds.
    for (const id of incidentEdgeIds(edges, new Set(DRAGGED))) expect(scope.has(id)).toBe(true);
    expect(calls).toBeLessThan(edges.length / 3);
  });

  it("leaves out only wires whose route really is unchanged", () => {
    const before = cards();
    const after = cards(dragOffsets(MOVES));
    const scope = edgesTouchedByMove(wires(after), movedObstacles(before, after));
    const route = (held: LoomObstacle[]) =>
      planStandaloneRoutes({ edges: wires(held), obstacles: held, corridors: [], strandIds: NO_STRANDS });
    const was = route(before);
    const now = route(after);
    let kept = 0;
    for (const edge of wires(after)) {
      if (scope.has(edge.id)) continue;
      kept++;
      expect(now.get(edge.id), edge.id).toEqual(was.get(edge.id));
    }
    expect(kept).toBeGreaterThan(90);
  });

  it("a drop that changes the moved wires' sides still routes only those wires", () => {
    // In the window a wire's sides follow where its cards sit, so after a drop
    // the wires on the moved cards are different wires to the planner. That
    // once sent every wire on the canvas back through the router.
    const before = cards();
    const after = cards(dragOffsets(MOVES));
    const edges = wires(after);
    const moved = incidentEdgeIds(edges, new Set(DRAGGED));
    const keyOf = (edge: LoomEdgeInput, flipped: boolean): string =>
      `${edge.id}|${flipped ? "top" : edge.sourceSide}|${edge.targetSide}`;
    const owed = routesOwed({
      edges,
      specsBefore: new Map(edges.map((edge) => [edge.id, keyOf(edge, false)] as const)),
      specsNow: new Map(edges.map((edge) => [edge.id, keyOf(edge, moved.has(edge.id))] as const)),
      obstaclesBefore: before,
      obstaclesNow: after,
      movedNodeIds: new Set(DRAGGED),
      dropped: moved,
      strandsBefore: NO_STRANDS,
      strandsNow: NO_STRANDS,
      corridorsChanged: false,
    });
    expect(owed).toEqual(edgesTouchedByMove(edges, movedObstacles(before, after)));
    expect(owed.size).toBeLessThan(edges.length / 3);
  });

  it("owes a route to a wire that is new, changed, left a cable, or ends on a moved region", () => {
    const held = cards();
    const edges = wires(held);
    const same = new Map(edges.map((edge) => [edge.id, edge.id] as const));
    const base = {
      edges,
      specsBefore: same,
      specsNow: same,
      obstaclesBefore: held,
      obstaclesNow: held,
      movedNodeIds: new Set<string>(),
      dropped: new Set<string>(),
      strandsBefore: NO_STRANDS,
      strandsNow: NO_STRANDS,
      corridorsChanged: false,
    };
    const [first, second, third] = edges;
    expect(routesOwed(base).size).toBe(0);
    const withoutFirst = new Map(same);
    withoutFirst.delete(first!.id);
    expect(routesOwed({ ...base, specsBefore: withoutFirst })).toEqual(new Set([first!.id]));
    expect(routesOwed({ ...base, specsNow: new Map([...same, [second!.id, "other sides"]]) }))
      .toEqual(new Set([second!.id]));
    expect(routesOwed({ ...base, strandsBefore: new Set([third!.id]) })).toEqual(new Set([third!.id]));
    expect(routesOwed({ ...base, dropped: new Set([first!.id]) })).toEqual(new Set([first!.id]));
    // A region is not in the obstacle list; its wires still move with it.
    expect(routesOwed({ ...base, movedNodeIds: new Set([first!.sourceNodeId]) }))
      .toEqual(incidentEdgeIds(edges, new Set([first!.sourceNodeId])));
    // Corridors only matter to a blocked wire.
    expect(routesOwed({ ...base, corridorsChanged: true }).size).toBe(0);
    expect(routesOwed({ ...base, corridorsChanged: true, edges: [{ ...first!, blocked: true }] }))
      .toEqual(new Set([first!.id]));
  });

  it("a card that did not move touches nothing", () => {
    expect(movedObstacles(cards(), cards())).toEqual([]);
    expect(edgesTouchedByMove(wires(cards()), []).size).toBe(0);
  });
});
