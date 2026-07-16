import { describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import { deriveExecutionGraph } from "../src/shared/execution-graph";
import { blockedClosure, blockedEdgeIds, groupMembers } from "../src/shared/graph";

const project = (id: string, label: string) => ({
  id,
  type: "text" as const,
  text: label,
  x: 0,
  y: 0,
  width: 200,
  height: 80,
  ether: {
    entity: { kind: "project" as const, name: id },
  },
});

const tasks = (id: string, open: boolean) => ({
  id,
  type: "text" as const,
  text: id,
  x: 0,
  y: 0,
  width: 200,
  height: 80,
  ether: {
    entity: { kind: "task" as const },
    tasks: { items: [{ id: "i1", text: "item", done: !open }] },
  },
});

describe("graph derivations", () => {
  it("blockedClosure is transitive along criteria edges", () => {
    const doc: CanvasDoc = {
      nodes: [tasks("t1", true), tasks("t2", true), project("c", "c")],
      edges: [
        { id: "e-ab", fromNode: "t1", toNode: "t2", ether: { criteria: { mode: "tasks" } } },
        { id: "e-bc", fromNode: "t2", toNode: "c", ether: { criteria: { mode: "tasks" } } },
      ],
    };
    expect(blockedClosure(doc)).toEqual(new Set(["t2", "c"]));
    expect(blockedEdgeIds(doc)).toEqual(new Set(["e-ab", "e-bc"]));
  });

  it("soft relates never participates in blocked closure", () => {
    const doc: CanvasDoc = {
      nodes: [tasks("t1", true), project("b", "b"), project("c", "c")],
      edges: [
        { id: "e-ab", fromNode: "t1", toNode: "b", ether: { criteria: { mode: "tasks" } } },
        { id: "e-bc", fromNode: "b", toNode: "c" },
      ],
    };
    expect(blockedClosure(doc)).toEqual(new Set(["b"]));
    expect(blockedEdgeIds(doc).has("e-bc")).toBe(false);
  });

  it("wip criteria relays when downstream edge is depends (glyph-aware)", () => {
    const doc: CanvasDoc = {
      nodes: [project("a", "a"), project("b", "b"), project("c", "c")],
      edges: [
        { id: "e-ab", fromNode: "a", toNode: "b", ether: { criteria: { mode: "wip" } } },
        {
          id: "e-bc",
          fromNode: "b",
          toNode: "c",
          ether: { criteria: { mode: "glyphs", project: "b", glyphIds: ["g-done"] } },
        },
      ],
    };
    const glyphs = new Map([
      ["a", [{ glyphId: "g1", orbit: "forge", title: "g1", state: "building" }]],
      ["b", [{ glyphId: "g-done", orbit: "forge", title: "g", state: "done" }]],
    ]);
    const graph = deriveExecutionGraph(doc, glyphs);
    expect(graph.phaseByEdgeId.get("e-ab")).toBe("blocks");
    expect(graph.phaseByEdgeId.get("e-bc")).toBe("depends");
    expect(graph.blocked).toEqual(new Set(["b", "c"]));
  });

  it("groupMembers includes a node whose center is inside the group and excludes one outside", () => {
    const doc: CanvasDoc = {
      nodes: [
        { id: "grp", type: "group", label: "region", x: 0, y: 0, width: 400, height: 200 },
        { id: "inside", type: "text", text: "in", x: 20, y: 20, width: 100, height: 50 },
        { id: "outside", type: "text", text: "out", x: 20, y: 300, width: 100, height: 50 },
      ],
      edges: [],
    };
    expect(groupMembers(doc).get("grp")).toEqual(["inside"]);
  });
});
