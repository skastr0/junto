/**
 * PERF-P2 — equal geometry must not fan out; routes stay keyed and stable.
 */
import { describe, expect, it, vi } from "vitest";
import {
  diffKeyedRoutes,
  planStandaloneRoutes,
  sameLoomRoute,
  sameObstacles,
  shouldPublishCorridors,
  shouldPublishObstacles,
  type LoomRoute,
} from "../src/renderer/lib/loom-view";
import type { LoomEdgeInput, LoomObstacle } from "../src/renderer/lib/wire-loom";
import type { WireRect } from "../src/renderer/lib/wire-route";

const rect = (
  nodeId: string,
  x: number,
  y: number,
  width = 100,
  height = 60,
): LoomObstacle => ({ nodeId, x, y, width, height });

const edge = (
  id: string,
  from: { x: number; y: number },
  to: { x: number; y: number },
  opts?: { blocked?: boolean; source?: string; target?: string },
): LoomEdgeInput => ({
  id,
  blocked: opts?.blocked ?? false,
  sourceNodeId: opts?.source ?? "a",
  sourceSide: "right",
  sourceAnchor: from,
  targetNodeId: opts?.target ?? "b",
  targetSide: "left",
  targetAnchor: to,
});

describe("obstacle / corridor value equality", () => {
  it("equal obstacle arrays do not publish", () => {
    const a = [rect("n1", 0, 0), rect("n2", 200, 0)];
    const b = [rect("n1", 0, 0), rect("n2", 200, 0)];
    expect(sameObstacles(a, b)).toBe(true);
    expect(shouldPublishObstacles(a, b)).toBe(false);
  });

  it("changed bounds publish", () => {
    const a = [rect("n1", 0, 0)];
    const b = [rect("n1", 10, 0)];
    expect(shouldPublishObstacles(a, b)).toBe(true);
  });

  it("order / id change publishes", () => {
    const a = [rect("n1", 0, 0), rect("n2", 1, 1)];
    const b = [rect("n2", 1, 1), rect("n1", 0, 0)];
    expect(shouldPublishObstacles(a, b)).toBe(true);
  });

  it("equal corridor arrays do not publish", () => {
    const a: WireRect[] = [{ x: 0, y: 0, width: 40, height: 8 }];
    const b: WireRect[] = [{ x: 0, y: 0, width: 40, height: 8 }];
    expect(shouldPublishCorridors(a, b)).toBe(false);
  });
});

describe("keyed route identity", () => {
  it("equal route plans preserve keyed identity via diff", () => {
    const route: LoomRoute = {
      path: "M0 0 L100 0",
      labelX: 50,
      labelY: 0,
      detoured: false,
    };
    const held = { e1: route };
    const next = new Map<string, LoomRoute>([
      [
        "e1",
        {
          path: "M0 0 L100 0",
          labelX: 50,
          labelY: 0,
          detoured: false,
        },
      ],
    ]);
    const diff = diffKeyedRoutes(held, next);
    expect(diff.sets).toEqual([]);
    expect(diff.deletes).toEqual([]);
    expect(diff.retained).toEqual(["e1"]);
    expect(sameLoomRoute(held.e1!, next.get("e1")!)).toBe(true);
  });

  it("path change issues a set; removal issues a delete", () => {
    const held: Record<string, LoomRoute> = {
      e1: { path: "A", labelX: 1, labelY: 2, detoured: false },
      e2: { path: "B", labelX: 3, labelY: 4, detoured: true },
    };
    const next = new Map<string, LoomRoute>([
      ["e1", { path: "A-new", labelX: 1, labelY: 2, detoured: false }],
    ]);
    const diff = diffKeyedRoutes(held, next);
    expect(diff.sets.map(([id]) => id)).toEqual(["e1"]);
    expect(diff.deletes).toEqual(["e2"]);
    expect(diff.retained).toEqual([]);
  });

  it("scoped diff does not touch unrelated edge keys", () => {
    const held: Record<string, LoomRoute> = {
      keep: { path: "K", labelX: 0, labelY: 0, detoured: false },
      move: { path: "M", labelX: 0, labelY: 0, detoured: false },
    };
    const next = new Map<string, LoomRoute>([
      ["move", { path: "M2", labelX: 1, labelY: 1, detoured: true }],
    ]);
    const diff = diffKeyedRoutes(held, next, new Set(["move"]));
    expect(diff.sets.map(([id]) => id)).toEqual(["move"]);
    expect(diff.deletes).toEqual([]);
    // "keep" is outside scope — not deleted even though absent from next
    expect(diff.deletes).not.toContain("keep");
  });
});

describe("planStandaloneRoutes", () => {
  it("invokes routeWire once per non-strand edge and skips strands", () => {
    const spy = vi.fn(() => ({
      path: "M0 0 L10 0",
      labelX: 5,
      labelY: 0,
      detoured: false,
    }));
    const onRoute = vi.fn();
    const edges = [
      edge("fan-member", { x: 0, y: 0 }, { x: 100, y: 0 }),
      edge("solo", { x: 0, y: 40 }, { x: 100, y: 40 }, { source: "c", target: "d" }),
    ];
    const routes = planStandaloneRoutes({
      edges,
      obstacles: [rect("mid", 40, -10, 20, 80)],
      corridors: [],
      strandIds: new Set(["fan-member"]),
      routeWire: spy,
      onRouteWire: onRoute,
    });
    expect(onRoute).toHaveBeenCalledTimes(1);
    expect(onRoute).toHaveBeenCalledWith("solo");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(routes.has("fan-member")).toBe(false);
    expect(routes.has("solo")).toBe(true);
  });

  it("equal geometry replan with same inputs preserves route values", () => {
    const edges = [edge("e1", { x: 0, y: 0 }, { x: 200, y: 0 })];
    const obstacles = [rect("wall", 80, -40, 20, 80)];
    const a = planStandaloneRoutes({
      edges,
      obstacles,
      corridors: [],
      strandIds: new Set(),
    });
    const b = planStandaloneRoutes({
      edges,
      obstacles,
      corridors: [],
      strandIds: new Set(),
    });
    expect(a.get("e1")).toEqual(b.get("e1"));
    const held = { e1: a.get("e1")! };
    const diff = diffKeyedRoutes(held, b);
    expect(diff.retained).toEqual(["e1"]);
    expect(diff.sets).toEqual([]);
  });

  it("no-op plan: zero routeWire when all edges are strands", () => {
    const spy = vi.fn();
    planStandaloneRoutes({
      edges: [edge("e1", { x: 0, y: 0 }, { x: 10, y: 0 })],
      obstacles: [],
      corridors: [],
      strandIds: new Set(["e1"]),
      routeWire: spy,
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("blocked edges pass corridor furniture into routeWire obstacles", () => {
    const spy = vi.fn(() => ({
      path: "M0 0 L100 0",
      labelX: 50,
      labelY: 0,
      detoured: true,
    }));
    const corridors: WireRect[] = [{ x: 10, y: -4, width: 80, height: 8 }];
    planStandaloneRoutes({
      edges: [
        edge("blocked", { x: 0, y: 100 }, { x: 100, y: 100 }, {
          blocked: true,
          source: "s",
          target: "t",
        }),
      ],
      obstacles: [rect("s", -50, 70), rect("t", 100, 70)],
      corridors,
      strandIds: new Set(),
      routeWire: spy,
    });
    expect(spy).toHaveBeenCalledTimes(1);
    const calls = spy.mock.calls as unknown as Array<
      [{ obstacles: ReadonlyArray<WireRect> }]
    >;
    const args = calls[0]![0];
    // Endpoints excluded; corridor far from y=100 is included as furniture.
    expect(args.obstacles.some((r) => r.y === -4)).toBe(true);
    expect(
      args.obstacles.every(
        (r) => !("nodeId" in r && (r as LoomObstacle).nodeId === "s"),
      ),
    ).toBe(true);
  });
});

describe("renderer subscription contract (static)", () => {
  it("EtherEdge source does not read full obstacle/corridor observables", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(
      resolve(__dirname, "../src/renderer/components/edges/EtherEdge.tsx"),
      "utf8",
    );
    expect(src).not.toMatch(/loomObstacles\$/);
    expect(src).not.toMatch(/loomCorridors\$/);
    expect(src).toMatch(/loomRoutes\$\[id\]/);
    expect(src).toMatch(/loomStrands\$\[id\]/);
    expect(src).toMatch(/edgeSparks\$\[id\]/);
    expect(src).not.toMatch(/routeWire\s*\(/);
    expect(src).not.toMatch(/state\$\.doc/);
  });

  it("CanvasLoom publishes obstacles only when unequal", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(
      resolve(__dirname, "../src/renderer/components/edges/CanvasLoom.tsx"),
      "utf8",
    );
    expect(src).toMatch(/shouldPublishObstacles/);
    expect(src).toMatch(/loomRoutes\$/);
    expect(src).toMatch(/planStandaloneRoutes/);
    // Must not unconditionally set obstacles without equality gate.
    expect(src).toMatch(/if\s*\(\s*!equal\s*\)/);
  });
});
