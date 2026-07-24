import { describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import { deriveExecutionGraph } from "../src/shared/execution-graph";
import { blockedClosure, blockedEdgeIds, groupMembers } from "../src/shared/graph";
import { taskItem, claimed } from "./helpers/task-fixtures";
import { seat } from "./helpers/physics-seats";

const tasks = (id: string, needsInput: boolean, heldBy?: string) => ({
  id,
  type: "text" as const,
  text: id,
  x: 0,
  y: 0,
  width: 200,
  height: 80,
  ether: {
    entity: { kind: "task" as const },
    tasks: {
      items: [
        needsInput && heldBy !== undefined
          ? claimed(taskItem("i1", "item", "input-required"), heldBy)
          : taskItem("i1", "item", needsInput ? "input-required" : "completed"),
      ],
    },
  },
});

describe("graph derivations", () => {
  it("blockedClosure is direct only (no cascade)", () => {
    const doc: CanvasDoc = {
      nodes: [
        tasks("t1", true, "a1"),
        seat("a1", "actor", { label: "a1" }),
        seat("a2", "actor", { label: "a2" }),
      ],
      edges: [
        { id: "e-ab", fromNode: "t1", toNode: "a1", ether: { criteria: { mode: "tasks" } } },
        { id: "e-bc", fromNode: "a1", toNode: "a2", ether: { criteria: { mode: "tasks" } } },
      ],
    };
    expect(blockedClosure(doc)).toEqual(new Set(["a1"]));
    expect(blockedEdgeIds(doc)).toEqual(new Set(["e-ab"]));
  });

  it("soft relates never participates in blocked closure", () => {
    const doc: CanvasDoc = {
      nodes: [
        tasks("t1", true, "b"),
        seat("b", "actor", { label: "b" }),
        seat("c", "actor", { label: "c" }),
      ],
      edges: [
        { id: "e-ab", fromNode: "t1", toNode: "b", ether: { criteria: { mode: "tasks" } } },
        { id: "e-bc", fromNode: "b", toNode: "c" },
      ],
    };
    expect(blockedClosure(doc)).toEqual(new Set(["b"]));
    expect(blockedEdgeIds(doc).has("e-bc")).toBe(false);
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

  it("deriveExecutionGraph agrees with blockedClosure", () => {
    const doc: CanvasDoc = {
      nodes: [tasks("t1", true), seat("a1", "actor")],
      edges: [
        { id: "e1", fromNode: "t1", toNode: "a1", ether: { criteria: { mode: "tasks" } } },
      ],
    };
    expect(deriveExecutionGraph(doc).blocked).toEqual(blockedClosure(doc));
  });
});
