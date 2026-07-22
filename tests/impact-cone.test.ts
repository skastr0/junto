import { describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import { deriveExecutionGraph } from "../src/shared/execution-graph";
import { impactCone } from "../src/shared/impact";
import { a2aTask } from "./helpers/a2a-fixtures";

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

const projectNode = (id: string, label: string, projectKey: string) =>
  text(id, label, {
    entity: { kind: "project", name: projectKey },
  });

describe("impactCone — tasks / requests stoppage", () => {
  it("requests criteria input-required generates blocks and cone membership", () => {
    const doc: CanvasDoc = {
      nodes: [
        text("r1", "Requests", {
          entity: { kind: "requests" },
          requests: { items: [a2aTask("q1", "approve deploy?", "input-required")] },
        }),
        projectNode("p1", "Ship", "ship"),
        projectNode("p2", "Release", "release"),
      ],
      edges: [
        {
          id: "e-rp",
          fromNode: "r1",
          toNode: "p1",
          ether: { criteria: { mode: "tasks" } },
        },
        // Empty tasks criteria → depends (relays when p1 is blocked).
        {
          id: "e-pp",
          fromNode: "p1",
          toNode: "p2",
          ether: { criteria: { mode: "tasks" } },
        },
      ],
    };

    const graph = deriveExecutionGraph(doc);
    expect(graph.phaseByEdgeId.get("e-rp")).toBe("blocks");
    expect(graph.blocked.has("p1")).toBe(true);
    expect(graph.blocked.has("p2")).toBe(true);

    // Cone from the requests generator (apex).
    const fromRequests = impactCone(doc, graph, "r1");
    expect(fromRequests.rootId).toBe("r1");
    expect(fromRequests.nodeIds).toEqual(new Set(["r1", "p1", "p2"]));
    expect(fromRequests.edgeIds.has("e-rp")).toBe(true);
    expect(fromRequests.edgeIds.has("e-pp")).toBe(true);
    expect(fromRequests.seedReasons.some((r) => r.kind === "edge" && r.edgeId === "e-rp")).toBe(
      true,
    );

    // Cone from a mid-chain blocked node shares the same apex blast.
    const fromP1 = impactCone(doc, graph, "p1");
    expect(fromP1.nodeIds).toEqual(new Set(["r1", "p1", "p2"]));
    expect(fromP1.pathToSeed("p1")).toEqual(["p1", "r1"]);
    expect(fromP1.pathToSeed("p2")[0]).toBe("p2");
    expect(fromP1.pathToSeed("p2")).toContain("r1");

    // Unrelated project outside the chain → empty.
    const outsider = impactCone(
      {
        ...doc,
        nodes: [...doc.nodes, projectNode("other", "Other", "other")],
      },
      graph,
      "other",
    );
    expect(outsider.nodeIds.size).toBe(0);
    expect(outsider.edgeIds.size).toBe(0);
    expect(outsider.pathToSeed("p1")).toEqual([]);
  });

  it("task criteria submitted generates cone from task apex", () => {
    const doc: CanvasDoc = {
      nodes: [
        text("t1", "Checklist", {
          entity: { kind: "task" },
          tasks: { items: [a2aTask("i1", "do it", "submitted")] },
        }),
        projectNode("p1", "Proj", "proj"),
      ],
      edges: [
        {
          id: "e1",
          fromNode: "t1",
          toNode: "p1",
          ether: { criteria: { mode: "tasks" } },
        },
      ],
    };
    const graph = deriveExecutionGraph(doc);
    expect(graph.blocked).toEqual(new Set(["p1"]));

    const cone = impactCone(doc, graph, "t1");
    expect(cone.nodeIds).toEqual(new Set(["t1", "p1"]));
    expect(cone.edgeIds).toEqual(new Set(["e1"]));
    expect(cone.seedReasons).toHaveLength(1);
    expect(cone.seedReasons[0]).toMatchObject({
      kind: "edge",
      edgeId: "e1",
      fromNodeId: "t1",
    });
    expect(cone.pathToSeed("p1")).toEqual(["p1", "t1"]);
  });

  it("resolved requests clear the cone", () => {
    const doc: CanvasDoc = {
      nodes: [
        text("r1", "Requests", {
          entity: { kind: "requests" },
          requests: { items: [a2aTask("q1", "approve?", "completed")] },
        }),
        projectNode("p1", "Ship", "ship"),
      ],
      edges: [
        {
          id: "e1",
          fromNode: "r1",
          toNode: "p1",
          ether: { criteria: { mode: "tasks" } },
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
  it("manual blocker seed fans out through depends criteria", () => {
    const doc: CanvasDoc = {
      nodes: [
        text("b", "Blocker", {
          entity: { kind: "project", name: "pb" },
          flags: ["blocker"],
        }),
        projectNode("c", "C", "pc"),
        projectNode("d", "D", "pd"),
      ],
      edges: [
        {
          id: "e-bc",
          fromNode: "b",
          toNode: "c",
          ether: {
            criteria: { mode: "glyphs", project: "pb", glyphIds: ["gx"] },
          },
        },
        {
          id: "e-cd",
          fromNode: "c",
          toNode: "d",
          ether: {
            criteria: { mode: "glyphs", project: "pc", glyphIds: ["gy"] },
          },
        },
      ],
    };
    // glyphs all done → depends (relays), seed still fans out.
    const glyphs = new Map([
      ["pb", [{ glyphId: "gx", orbit: "forge", title: "gx", state: "done" }]],
      ["pc", [{ glyphId: "gy", orbit: "forge", title: "gy", state: "done" }]],
    ]);
    const graph = deriveExecutionGraph(doc, glyphs);
    expect(graph.seedNodeIds.has("b")).toBe(true);
    expect(graph.blocked.has("c")).toBe(true);
    expect(graph.blocked.has("d")).toBe(true);

    const cone = impactCone(doc, graph, "b");
    expect(cone.nodeIds).toEqual(new Set(["b", "c", "d"]));
    expect(cone.edgeIds.has("e-bc")).toBe(true);
    expect(cone.edgeIds.has("e-cd")).toBe(true);
    expect(cone.pathToSeed("d")[0]).toBe("d");
    expect(cone.pathToSeed("d")).toContain("b");
  });

  it("attention leads: actor seats undirected into cone stay soft (not blocked)", () => {
    const doc: CanvasDoc = {
      nodes: [
        text("t1", "Checklist", {
          entity: { kind: "task" },
          tasks: { items: [a2aTask("i1", "work", "working")] },
        }),
        projectNode("p1", "Proj", "proj"),
        text("agent1", "hermes", {
          entity: { kind: "agent", name: "local:default" },
        }),
        text("note1", "just a note"),
      ],
      edges: [
        {
          id: "e-tp",
          fromNode: "t1",
          toNode: "p1",
          ether: { criteria: { mode: "tasks" } },
        },
        // Soft relates from agent into blocked project — attention lead only.
        { id: "e-ap", fromNode: "agent1", toNode: "p1" },
        // Furniture note is not an actor seat.
        { id: "e-np", fromNode: "note1", toNode: "p1" },
      ],
    };
    const graph = deriveExecutionGraph(doc);
    expect(graph.blocked).toEqual(new Set(["p1"]));
    // Agents never enter the phase blocked set.
    expect(graph.blocked.has("agent1")).toBe(false);

    const cone = impactCone(doc, graph, "p1");
    expect(cone.nodeIds.has("p1")).toBe(true);
    expect(cone.nodeIds.has("t1")).toBe(true);
    // Actor is a soft lead, not a phase cone member.
    expect(cone.nodeIds.has("agent1")).toBe(false);
    expect(cone.attentionLeadIds).toEqual(new Set(["agent1"]));
    expect(cone.attentionLeadIds.has("note1")).toBe(false);
  });

  it("relates edges never expand the stoppage cone", () => {
    const doc: CanvasDoc = {
      nodes: [
        text("t1", "Checklist", {
          entity: { kind: "task" },
          tasks: { items: [a2aTask("i1", "x", "submitted")] },
        }),
        projectNode("p1", "A", "pa"),
        projectNode("p2", "B", "pb"),
      ],
      edges: [
        {
          id: "e1",
          fromNode: "t1",
          toNode: "p1",
          ether: { criteria: { mode: "tasks" } },
        },
        { id: "e2", fromNode: "p1", toNode: "p2" }, // relates — no relay
      ],
    };
    const graph = deriveExecutionGraph(doc);
    const cone = impactCone(doc, graph, "t1");
    expect(cone.nodeIds).toEqual(new Set(["t1", "p1"]));
    expect(cone.nodeIds.has("p2")).toBe(false);
    expect(cone.edgeIds.has("e2")).toBe(false);
  });

  it("unknown root id yields empty cone", () => {
    const doc: CanvasDoc = { nodes: [projectNode("p1", "P", "p")], edges: [] };
    const graph = deriveExecutionGraph(doc);
    const cone = impactCone(doc, graph, "missing");
    expect(cone.nodeIds.size).toBe(0);
    expect(cone.seedReasons).toEqual([]);
  });
});
