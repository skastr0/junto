import { describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import { deriveExecutionGraph } from "../src/shared/execution-graph";
import {
  actorRefResolverFromProjection,
  blockedClosure,
  blockedEdgeIds,
  childRegions,
  groupMembers,
  regionStack,
} from "../src/shared/graph";
import {
  actorRefFixture,
  claimedByNode,
  executionContextForDoc,
} from "./helpers/actor-ref-fixtures";
import { taskItem } from "./helpers/task-fixtures";
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
          ? claimedByNode(taskItem("i1", "item", "input-required"), heldBy)
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
        { id: "e-ab", fromNode: "t1", toNode: "a1", ether: { verb: "works" } },
        { id: "e-bc", fromNode: "a1", toNode: "a2", ether: { verb: "messages" } },
      ],
    };
    const context = executionContextForDoc(doc);
    expect(blockedClosure(doc, context)).toEqual(new Set(["a1"]));
    expect(blockedEdgeIds(doc, context)).toEqual(new Set(["e-ab"]));
  });

  it("soft relates never participates in blocked closure", () => {
    const doc: CanvasDoc = {
      nodes: [
        tasks("t1", true, "b"),
        seat("b", "actor", { label: "b" }),
        seat("c", "actor", { label: "c" }),
      ],
      edges: [
        { id: "e-ab", fromNode: "t1", toNode: "b", ether: { verb: "works" } },
        { id: "e-bc", fromNode: "b", toNode: "c" },
      ],
    };
    const context = executionContextForDoc(doc);
    expect(blockedClosure(doc, context)).toEqual(new Set(["b"]));
    expect(blockedEdgeIds(doc, context).has("e-bc")).toBe(false);
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
        { id: "e1", fromNode: "t1", toNode: "a1", ether: { verb: "works" } },
      ],
    };
    const context = executionContextForDoc(doc);
    expect(deriveExecutionGraph(doc, context).blocked).toEqual(
      blockedClosure(doc, context),
    );
  });

  it("projection resolver fails closed for duplicate canvas-local actor refs", () => {
    const first = actorRefFixture("a1");
    const duplicate = {
      ...actorRefFixture("other"),
      canvasName: first.canvasName,
      nodeId: first.nodeId,
    };
    const resolve = actorRefResolverFromProjection([first, duplicate]);

    expect(
      resolve({ canvasName: first.canvasName, nodeId: first.nodeId }),
    ).toBeUndefined();
  });

  it("regionStack: three-deep nesting stacks outer → inner and members belong to every container", () => {
    const doc: CanvasDoc = {
      nodes: [
        { id: "outer", type: "group", label: "outer", x: 0, y: 0, width: 1000, height: 1000 },
        { id: "mid", type: "group", label: "mid", x: 50, y: 50, width: 500, height: 500 },
        { id: "inner", type: "group", label: "inner", x: 100, y: 100, width: 200, height: 200 },
        { id: "n", type: "text", text: "deep", x: 120, y: 120, width: 100, height: 50 },
      ],
      edges: [],
    };
    expect(regionStack(doc, "n").map((g) => g.id)).toEqual(["outer", "mid", "inner"]);
    const members = groupMembers(doc);
    expect(members.get("outer")).toEqual(["n"]);
    expect(members.get("mid")).toEqual(["n"]);
    expect(members.get("inner")).toEqual(["n"]);
  });

  it("regionStack works for a group target (region-in-region), excluding the group itself", () => {
    const doc: CanvasDoc = {
      nodes: [
        { id: "outer", type: "group", x: 0, y: 0, width: 1000, height: 1000 },
        { id: "mid", type: "group", x: 50, y: 50, width: 500, height: 500 },
        { id: "inner", type: "group", x: 100, y: 100, width: 200, height: 200 },
      ],
      edges: [],
    };
    expect(regionStack(doc, "inner").map((g) => g.id)).toEqual(["outer", "mid"]);
    expect(regionStack(doc, "mid").map((g) => g.id)).toEqual(["outer"]);
    expect(regionStack(doc, "outer")).toEqual([]);
  });

  it("childRegions returns every fully contained group; a straddling group is out", () => {
    const doc: CanvasDoc = {
      nodes: [
        { id: "outer", type: "group", x: 0, y: 0, width: 1000, height: 1000 },
        { id: "mid", type: "group", x: 50, y: 50, width: 500, height: 500 },
        { id: "inner", type: "group", x: 100, y: 100, width: 200, height: 200 },
        // extends past outer's right edge — not contained
        { id: "straddler", type: "group", x: 900, y: 0, width: 300, height: 100 },
      ],
      edges: [],
    };
    expect(childRegions(doc, "outer").map((g) => g.id)).toEqual(["mid", "inner"]);
    expect(childRegions(doc, "mid").map((g) => g.id)).toEqual(["inner"]);
    expect(childRegions(doc, "inner")).toEqual([]);
    expect(childRegions(doc, "n-not-a-group")).toEqual([]);
  });

  it("overlapping regions: a node inside both is a member of both, stack order deterministic", () => {
    const doc: CanvasDoc = {
      nodes: [
        // equal areas, partially overlapping — tiebreak on id
        { id: "gB", type: "group", x: 100, y: 0, width: 400, height: 300 },
        { id: "gA", type: "group", x: 0, y: 0, width: 400, height: 300 },
        { id: "n", type: "text", text: "both", x: 150, y: 50, width: 100, height: 50 },
      ],
      edges: [],
    };
    expect(regionStack(doc, "n").map((g) => g.id)).toEqual(["gA", "gB"]);
    const members = groupMembers(doc);
    expect(members.get("gA")).toEqual(["n"]);
    expect(members.get("gB")).toEqual(["n"]);
  });

  it("regionStack excludes partial containment and unknown targets", () => {
    const doc: CanvasDoc = {
      nodes: [
        { id: "outer", type: "group", x: 0, y: 0, width: 400, height: 400 },
        { id: "inner", type: "group", x: 20, y: 20, width: 200, height: 200 },
        // fully inside outer, straddles inner's right edge
        { id: "n", type: "text", text: "straddle", x: 180, y: 40, width: 100, height: 50 },
      ],
      edges: [],
    };
    expect(regionStack(doc, "n").map((g) => g.id)).toEqual(["outer"]);
    expect(regionStack(doc, "missing")).toEqual([]);
  });

  it("missing compiled actor identity never falls back to the node id", () => {
    const doc: CanvasDoc = {
      nodes: [tasks("t1", true, "a1"), seat("a1", "actor")],
      edges: [
        {
          id: "e1",
          fromNode: "t1",
          toNode: "a1",
          ether: { verb: "works" },
        },
      ],
    };
    const context = {
      ...executionContextForDoc(doc),
      resolveActorRef: actorRefResolverFromProjection([]),
    };

    expect(blockedClosure(doc, context)).toEqual(new Set());
    expect(deriveExecutionGraph(doc, context).detailByEdgeId.get("e1")).toContain(
      "actor identity unresolved",
    );
  });
});
