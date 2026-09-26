import { describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import { deriveExecutionGraph as deriveExecutionGraphWithContext } from "../src/shared/execution-graph";
import { impactCone } from "../src/shared/impact";
import {
  claimedByNode as claimed,
  executionContextForDoc,
} from "./helpers/actor-ref-fixtures";
import { taskItem } from "./helpers/task-fixtures";
import { geographySeat, seat } from "./helpers/physics-seats";

const deriveExecutionGraph = (doc: CanvasDoc) =>
  deriveExecutionGraphWithContext(doc, executionContextForDoc(doc));

const text = (
  id: string,
  label: string,
  ether?: CanvasDoc["nodes"][number]["ether"],
): CanvasDoc["nodes"][number] => ({
  id,
  type: "text",
  text: label,
  x: 0,
  y: 0,
  width: 200,
  height: 80,
  ...(ether ? { ether } : {}),
});

describe("impactCone — task stoppage", () => {
  it("input-required tasks block their claimants and build cone membership", () => {
    // Fan-out edges from the sink; each request blocks only its raiser.
    const doc: CanvasDoc = {
      nodes: [
        text("r1", "Requests", {
          entity: { kind: "task" },
          tasks: {
            items: [
              claimed(taskItem("q1", "approve deploy?", "input-required"), "a1"),
              claimed(taskItem("q2", "approve rollback?", "input-required"), "a2"),
            ],
          },
        }),
        seat("a1", "actor", { label: "Ship" }),
        seat("a2", "actor", { label: "Release" }),
      ],
      edges: [
        {
          id: "e-r1",
          fromNode: "a1",
          toNode: "r1",
          ether: { verb: "contributes" },
        },
        {
          id: "e-r2",
          fromNode: "a2",
          toNode: "r1",
          ether: { verb: "contributes" },
        },
      ],
    };

    const graph = deriveExecutionGraph(doc);
    expect(graph.phaseByEdgeId.get("e-r1")).toBe("blocks");
    expect(graph.phaseByEdgeId.get("e-r2")).toBe("blocks");
    expect(graph.blocked.has("a1")).toBe(true);
    expect(graph.blocked.has("a2")).toBe(true);
    // sink-side task node is not itself a blocked member
    expect(graph.blocked.has("r1")).toBe(false);

    const fromRequests = impactCone(doc, graph, "r1");
    expect(fromRequests.rootId).toBe("r1");
    expect(fromRequests.nodeIds).toEqual(new Set(["r1", "a1", "a2"]));
    expect(fromRequests.edgeIds.has("e-r1")).toBe(true);
    expect(fromRequests.edgeIds.has("e-r2")).toBe(true);
    expect(fromRequests.seedReasons.some((r) => r.kind === "edge" && r.edgeId === "e-r1")).toBe(
      true,
    );

    const fromA1 = impactCone(doc, graph, "a1");
    expect(fromA1.nodeIds).toEqual(new Set(["r1", "a1", "a2"]));
    expect(fromA1.pathToSeed("a1")).toEqual(["a1", "r1"]);
    expect(fromA1.pathToSeed("a2")).toEqual(["a2", "r1"]);

    const outsider = impactCone(
      {
        ...doc,
        nodes: [...doc.nodes, seat("other", "actor", { label: "Other" })],
      },
      graph,
      "other",
    );
    expect(outsider.nodeIds.size).toBe(0);
    expect(outsider.edgeIds.size).toBe(0);
    expect(outsider.pathToSeed("a1")).toEqual([]);
  });

  it("task input-required generates cone onto actors; submitted does not", () => {
    const tasksOpen = text("t1", "Checklist", {
      entity: { kind: "task" },
      tasks: { items: [taskItem("i1", "do it", "submitted")] },
    });
    const actor = seat("a1", "actor", { label: "worker" });
    const openDoc: CanvasDoc = {
      nodes: [tasksOpen, actor],
      edges: [
        {
          id: "e1",
          fromNode: "t1",
          toNode: "a1",
          ether: { verb: "works" },
        },
      ],
    };
    const calm = deriveExecutionGraph(openDoc);
    // Open queue is not attention — soft relates, no stoppage.
    expect(calm.phaseByEdgeId.get("e1")).toBe("relates");
    expect(calm.blocked.size).toBe(0);
    expect(impactCone(openDoc, calm, "t1").nodeIds.size).toBe(0);

    const tasksHot = text("t1", "Checklist", {
      entity: { kind: "task" },
      tasks: { items: [claimed(taskItem("i1", "do it", "input-required"), "a1")] },
    });
    const hotDoc: CanvasDoc = {
      nodes: [tasksHot, actor],
      edges: openDoc.edges,
    };
    const graph = deriveExecutionGraph(hotDoc);
    expect(graph.blocked).toEqual(new Set(["a1"]));

    const cone = impactCone(hotDoc, graph, "t1");
    expect(cone.nodeIds).toEqual(new Set(["t1", "a1"]));
    expect(cone.edgeIds).toEqual(new Set(["e1"]));
    expect(cone.seedReasons).toHaveLength(1);
    expect(cone.seedReasons[0]).toMatchObject({
      kind: "edge",
      edgeId: "e1",
      fromNodeId: "t1",
    });
    expect(cone.pathToSeed("a1")).toEqual(["a1", "t1"]);
  });

  it("resolved tasks clear the cone", () => {
    const doc: CanvasDoc = {
      nodes: [
        text("r1", "Requests", {
          entity: { kind: "task" },
          tasks: { items: [taskItem("q1", "approve?", "completed")] },
        }),
        seat("a1", "actor", { label: "Ship" }),
      ],
      edges: [
        {
          id: "e1",
          fromNode: "a1",
          toNode: "r1",
          ether: { verb: "contributes" },
        },
      ],
    };
    const graph = deriveExecutionGraph(doc);
    expect(graph.blocked.size).toBe(0);
    const cone = impactCone(doc, graph, "r1");
    expect(cone.nodeIds.size).toBe(0);
  });
});

describe("impactCone — seeds, relays, attention leads", () => {
  it("attention leads: undirected actor into cone is soft when not phase-blocked", () => {
    const doc: CanvasDoc = {
      nodes: [
        text("t1", "Checklist", {
          entity: { kind: "task" },
          tasks: { items: [claimed(taskItem("i1", "work", "input-required"), "blocked")] },
        }),
        seat("blocked", "actor", { label: "blocked worker" }),
        seat("lead", "actor", { label: "adjacent worker" }),
        geographySeat("note1", "just a note"),
      ],
      edges: [
        {
          id: "e-tb",
          fromNode: "t1",
          toNode: "blocked",
          ether: { verb: "works" },
        },
        // Soft relates from free actor into blocked actor — attention lead.
        { id: "e-lb", fromNode: "lead", toNode: "blocked" },
        { id: "e-nb", fromNode: "note1", toNode: "blocked" },
      ],
    };
    const graph = deriveExecutionGraph(doc);
    expect(graph.blocked).toEqual(new Set(["blocked"]));
    expect(graph.blocked.has("lead")).toBe(false);

    const cone = impactCone(doc, graph, "blocked");
    expect(cone.nodeIds.has("blocked")).toBe(true);
    expect(cone.nodeIds.has("t1")).toBe(true);
    expect(cone.nodeIds.has("lead")).toBe(false);
    expect(cone.attentionLeadIds).toEqual(new Set(["lead"]));
    expect(cone.attentionLeadIds.has("note1")).toBe(false);
  });

  it("relates edges never expand the stoppage cone", () => {
    const doc: CanvasDoc = {
      nodes: [
        text("t1", "Checklist", {
          entity: { kind: "task" },
          tasks: { items: [claimed(taskItem("i1", "x", "input-required"), "a1")] },
        }),
        seat("a1", "actor", { label: "A" }),
        seat("a2", "actor", { label: "B" }),
      ],
      edges: [
        {
          id: "e1",
          fromNode: "t1",
          toNode: "a1",
          ether: { verb: "works" },
        },
        { id: "e2", fromNode: "a1", toNode: "a2" }, // relates — no relay
      ],
    };
    const graph = deriveExecutionGraph(doc);
    const cone = impactCone(doc, graph, "t1");
    expect(cone.nodeIds).toEqual(new Set(["t1", "a1"]));
    expect(cone.nodeIds.has("a2")).toBe(false);
    expect(cone.edgeIds.has("e2")).toBe(false);
  });

  it("unknown root id yields empty cone", () => {
    const doc: CanvasDoc = { nodes: [seat("a1", "actor", { label: "P" })], edges: [] };
    const graph = deriveExecutionGraph(doc);
    const cone = impactCone(doc, graph, "missing");
    expect(cone.nodeIds.size).toBe(0);
    expect(cone.seedReasons).toEqual([]);
  });
});
