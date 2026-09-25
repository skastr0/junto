import { afterEach, describe, expect, it } from "vitest";
import type { CanvasDoc, CanvasEdge } from "../src/shared/canvas";
import { loadDoc, undo } from "../src/renderer/lib/mutations";
import {
  connectMesh,
  disconnectWithin,
  edgeIdsWithin,
  planConnectMesh,
} from "../src/renderer/lib/edge-mutations";
import { agentCountLabel, agentSeatIds } from "../src/renderer/lib/multi-selection";
import { placeBesideRect } from "../src/renderer/lib/menu-placement";
import { state$ } from "../src/renderer/lib/state";

const agent = (id: string): CanvasDoc["nodes"][number] => ({
  id,
  type: "text",
  text: id,
  x: 0,
  y: 0,
  width: 200,
  height: 80,
  ether: { entity: { kind: "agent", name: `local:${id}` } },
});

const nodes: CanvasDoc["nodes"] = [
  agent("a"),
  agent("b"),
  agent("c"),
  agent("d"),
  { id: "task", type: "text", text: "T", x: 0, y: 0, width: 200, height: 80, ether: { entity: { kind: "task" }, tasks: { items: [] } } },
  { id: "region", type: "group", label: "R", x: 0, y: 0, width: 400, height: 200 },
];

const wire = (id: string, fromNode: string, toNode: string): CanvasEdge => ({
  id,
  fromNode,
  toNode,
  ether: { verb: "messages" },
});

const pairs = (plan: ReturnType<typeof planConnectMesh>) =>
  plan.toAdd.map((c) => [c.fromNode, c.toNode].sort().join("|")).sort();

// No `junto` bridge, so commits stay in memory; confirm accepts deletes.
(globalThis as unknown as { window: object }).window = {
  setTimeout: globalThis.setTimeout,
  confirm: () => true,
};

afterEach(() => {
  state$.error.set("");
});

describe("planConnectMesh", () => {
  it("wires one edge per unordered pair", () => {
    const plan = planConnectMesh(["a", "b", "c", "d"], nodes, []);
    expect(pairs(plan)).toEqual(["a|b", "a|c", "a|d", "b|c", "b|d", "c|d"]);
    expect(plan.skipped).toEqual([]);
  });

  it("skips pairs already wired in either direction", () => {
    const plan = planConnectMesh(["a", "b", "c"], nodes, [wire("e1", "b", "a"), wire("e2", "a", "c")]);
    expect(pairs(plan)).toEqual(["b|c"]);
    expect(plan.skipped.filter((s) => s.reason === "duplicate")).toHaveLength(2);
  });

  it("ignores repeated ids and plans nothing for fewer than two", () => {
    expect(planConnectMesh(["a", "a"], nodes, []).toAdd).toEqual([]);
    expect(planConnectMesh([], nodes, []).toAdd).toEqual([]);
  });

  it("follows the pair grammar the single-target connect uses", () => {
    const plan = planConnectMesh(["a", "b"], nodes, []);
    expect(plan.toAdd).toHaveLength(1);
    expect(typeof plan.toAdd[0]?.verb).toBe("string");
  });
});

describe("connectMesh", () => {
  it("commits the whole mesh as one undo step", () => {
    state$.canvasName.set("selection-mesh-test");
    loadDoc({ nodes, edges: [wire("e1", "a", "b")] });
    const plan = connectMesh(["a", "b", "c"]);
    expect(plan.toAdd).toHaveLength(2);
    expect(state$.doc.peek().edges).toHaveLength(3);
    undo();
    expect(state$.doc.peek().edges.map((e) => e.id)).toEqual(["e1"]);
  });

  it("reports an already-connected selection without writing", () => {
    state$.canvasName.set("selection-mesh-test");
    loadDoc({ nodes, edges: [wire("e1", "a", "b")] });
    connectMesh(["a", "b"]);
    expect(state$.doc.peek().edges).toHaveLength(1);
    expect(state$.error.peek()).toBe("Those agents are already connected.");
  });
});

describe("disconnect within a selection", () => {
  const edges = [wire("in1", "a", "b"), wire("in2", "c", "a"), wire("out", "a", "d")];

  it("finds only edges with both ends inside", () => {
    expect(edgeIdsWithin(["a", "b", "c"], edges)).toEqual(["in1", "in2"]);
    expect(edgeIdsWithin(["a"], edges)).toEqual([]);
  });

  it("removes inside edges in one write and keeps outside ones", () => {
    state$.canvasName.set("selection-mesh-test");
    loadDoc({ nodes, edges });
    disconnectWithin(["a", "b", "c"]);
    expect(state$.doc.peek().edges.map((e) => e.id)).toEqual(["out"]);
    undo();
    expect(state$.doc.peek().edges).toHaveLength(3);
  });
});

describe("agent seat helpers", () => {
  it("keeps agent seats only and counts them", () => {
    expect(agentSeatIds(nodes)).toEqual(["a", "b", "c", "d"]);
    expect(agentCountLabel(1)).toBe("1 agent");
    expect(agentCountLabel(3)).toBe("3 agents");
  });
});

describe("placeBesideRect", () => {
  const viewport = { width: 1200, height: 800 };
  const menu = { width: 240, height: 300 };

  it("prefers the right side, bottom-aligned with the rect", () => {
    expect(placeBesideRect({ left: 100, top: 100, right: 400, bottom: 500 }, menu, viewport)).toEqual({ x: 408, y: 200 });
  });

  it("falls to below when the right side is off-screen", () => {
    expect(placeBesideRect({ left: 700, top: 100, right: 1100, bottom: 400 }, menu, viewport)).toEqual({ x: 860, y: 408 });
  });

  it("clamps into the viewport when no side is clear", () => {
    const point = placeBesideRect({ left: 0, top: 0, right: 1200, bottom: 800 }, menu, viewport);
    expect(point).toEqual({ x: 952, y: 492 });
  });
});
