import { describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import {
  composeRegionExecutionContext,
  deriveExecutionGraph,
  edgeGlyphProjects,
  evaluateEdge,
  type GlyphView,
} from "../src/shared/execution-graph";
import { groupMembers } from "../src/shared/graph";
import type { ProofStamp, StampView } from "../src/shared/proof-stamps";
import { a2aTask } from "./helpers/a2a-fixtures";
import { furnitureSeat, seat } from "./helpers/physics-seats";

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

describe("evaluateEdge — authorial modes", () => {
  it("no criteria → relates", () => {
    const edge = { id: "e1", fromNode: "a", toNode: "b" };
    const result = evaluateEdge(edge, seat("a", "sink"), new Map());
    expect(result.phase).toBe("relates");
    expect(result.generates).toBe(false);
  });

  it("kind-only ether is soft relates (kind is not authorial)", () => {
    const edge = { id: "e1", fromNode: "a", toNode: "b", ether: { kind: "blocks" as const } };
    const result = evaluateEdge(edge, seat("a", "sink"), new Map());
    expect(result.phase).toBe("relates");
    expect(result.generates).toBe(false);
  });

  it("tasks: submitted/working do not block; input-required does; clear relates", () => {
    const edge = {
      id: "e1",
      fromNode: "t1",
      toNode: "b",
      ether: { criteria: { mode: "tasks" as const } },
    };
    const openQueue = text("t1", "Checklist", {
      entity: { kind: "task" },
      tasks: {
        items: [a2aTask("i1", "one", "submitted"), a2aTask("i2", "two", "working")],
      },
    });
    expect(evaluateEdge(edge, openQueue, new Map()).phase).toBe("relates");
    expect(evaluateEdge(edge, openQueue, new Map()).generates).toBe(false);

    const needsInput = text("t1", "Checklist", {
      entity: { kind: "task" },
      tasks: {
        items: [a2aTask("i1", "one", "input-required"), a2aTask("i2", "two", "completed")],
      },
    });
    expect(evaluateEdge(edge, needsInput, new Map()).phase).toBe("blocks");
    expect(evaluateEdge(edge, needsInput, new Map()).generates).toBe(true);

    const empty = text("t1", "Checklist", { entity: { kind: "task" }, tasks: { items: [] } });
    expect(evaluateEdge(edge, empty, new Map()).phase).toBe("relates");
  });

  it("requests: input-required blocks; resolved relates", () => {
    const edge = {
      id: "e1",
      fromNode: "r1",
      toNode: "b",
      ether: { criteria: { mode: "tasks" as const } },
    };
    const pending = text("r1", "Requests", {
      entity: { kind: "requests" },
      requests: { items: [a2aTask("q1", "approve?", "input-required")] },
    });
    expect(evaluateEdge(edge, pending, new Map()).phase).toBe("blocks");

    for (const state of ["completed", "rejected", "canceled"] as const) {
      const resolved = text("r1", "Requests", {
        entity: { kind: "requests" },
        requests: { items: [a2aTask("q1", "approve?", state)] },
      });
      expect(evaluateEdge(edge, resolved, new Map()).phase).toBe("relates");
    }
  });
});

describe("deriveExecutionGraph — no cascade", () => {
  it("input-required blocks actors only; no relay through second hop", () => {
    const doc: CanvasDoc = {
      nodes: [
        text("t1", "Checklist", {
          entity: { kind: "task" },
          tasks: { items: [a2aTask("i1", "do it", "input-required")] },
        }),
        seat("a1", "actor", { label: "A1" }),
        seat("a2", "actor", { label: "A2" }),
      ],
      edges: [
        {
          id: "e1",
          fromNode: "t1",
          toNode: "a1",
          ether: { criteria: { mode: "tasks" } },
        },
        // would have been depends-relay under old model
        {
          id: "e2",
          fromNode: "a1",
          toNode: "a2",
          ether: { criteria: { mode: "tasks" } },
        },
      ],
    };
    const graph = deriveExecutionGraph(doc);
    expect(graph.phaseByEdgeId.get("e1")).toBe("blocks");
    expect(graph.phaseByEdgeId.get("e2")).toBe("relates");
    expect(graph.blocked).toEqual(new Set(["a1"]));
    expect(graph.blocked.has("a2")).toBe(false);
  });

  it("sink targets never join blocked set", () => {
    const doc: CanvasDoc = {
      nodes: [
        text("t1", "Checklist", {
          entity: { kind: "task" },
          tasks: { items: [a2aTask("i1", "do it", "input-required")] },
        }),
        seat("s1", "sink", { label: "sink" }),
      ],
      edges: [
        {
          id: "e1",
          fromNode: "t1",
          toNode: "s1",
          ether: { criteria: { mode: "tasks" } },
        },
      ],
    };
    const graph = deriveExecutionGraph(doc);
    expect(graph.phaseByEdgeId.get("e1")).toBe("blocks");
    expect(graph.blocked.has("s1")).toBe(false);
  });

  it("manual blocker flags the actor only (no outbound cascade)", () => {
    const doc: CanvasDoc = {
      nodes: [
        seat("b", "actor", { label: "B", flags: ["blocker"] }),
        seat("c", "actor", { label: "C" }),
      ],
      edges: [
        {
          id: "e-bc",
          fromNode: "b",
          toNode: "c",
          ether: { criteria: { mode: "tasks" } },
        },
      ],
    };
    const graph = deriveExecutionGraph(doc);
    expect(graph.seedNodeIds.has("b")).toBe(true);
    expect(graph.blocked.has("b")).toBe(true);
    expect(graph.blocked.has("c")).toBe(false);
  });

  it("furniture and sinks never blocked; actors can be", () => {
    const doc: CanvasDoc = {
      nodes: [
        text("t1", "Checklist", {
          entity: { kind: "task" },
          tasks: { items: [a2aTask("i1", "x", "input-required")] },
        }),
        furnitureSeat("note1"),
        seat("actor1", "actor"),
      ],
      edges: [
        { id: "e1", fromNode: "t1", toNode: "note1", ether: { criteria: { mode: "tasks" } } },
        { id: "e2", fromNode: "t1", toNode: "actor1", ether: { criteria: { mode: "tasks" } } },
      ],
    };
    const graph = deriveExecutionGraph(doc);
    expect(graph.blocked.has("note1")).toBe(false);
    expect(graph.blocked.has("actor1")).toBe(true);
  });

  it("edgeGlyphProjects is empty (glyphs criteria retired)", () => {
    expect(edgeGlyphProjects({ nodes: [], edges: [] }).size).toBe(0);
  });
});

describe("composeRegionExecutionContext", () => {
  it("includes edges, blocked reasons, and in-region task lists", () => {
    const doc: CanvasDoc = {
      nodes: [
        { id: "grp", type: "group", label: "region", x: 0, y: 0, width: 500, height: 300 },
        seat("a", "sink", { label: "Alpha", name: "pa", x: 20, y: 20 }),
        seat("b", "actor", { label: "Beta", x: 200, y: 20 }),
        text("t1", "Ops", {
          entity: { kind: "task" },
          tasks: { items: [a2aTask("i1", "ship docs", "input-required")] },
        }),
      ],
      edges: [
        {
          id: "e-tb",
          fromNode: "t1",
          toNode: "b",
          ether: { criteria: { mode: "tasks" } },
        },
      ],
    };
    (doc.nodes[3] as { x: number; y: number }).x = 40;
    (doc.nodes[3] as { y: number }).y = 100;

    const graph = deriveExecutionGraph(doc);
    const members = groupMembers(doc).get("grp") ?? [];
    const ctx = composeRegionExecutionContext(doc, "grp", graph, members);
    expect(ctx).toContain("execution");
    expect(ctx).toContain("blocks");
    expect(ctx).toContain("Beta");
    expect(ctx).toContain("ship docs");
  });
});

describe("evaluateEdge — proof / approval", () => {
  const sink = (id = "sink"): CanvasDoc["nodes"][number] =>
    text(id, "Artifacts", { entity: { kind: "artifacts" }, artifacts: { items: [] } });

  const stamp = (partial: Partial<ProofStamp> & Pick<ProofStamp, "step">): ProofStamp => ({
    seat: "agent-1",
    occupant: "pid:9",
    inputsHash: "h1",
    evidenceRefs: ["art-1"],
    ts: 1,
    ...partial,
  });

  it("proof missing → blocks actor; stamped → relates", () => {
    const from = sink("sink");
    const edge = {
      id: "e1",
      fromNode: "sink",
      toNode: "down",
      ether: { criteria: { mode: "proof" as const, step: "build" } },
    };
    expect(evaluateEdge(edge, from, new Map(), { stamps: new Map() }).phase).toBe("blocks");

    const doc: CanvasDoc = {
      nodes: [from, seat("down", "actor", { label: "Downstream" })],
      edges: [edge],
    };
    expect(deriveExecutionGraph(doc, new Map(), { stamps: new Map() }).blocked.has("down")).toBe(
      true,
    );

    const stamps: StampView = new Map([
      ["sink", [stamp({ step: "build", inputsHash: "h1" })]],
    ]);
    const cleared = evaluateEdge(
      { ...edge, ether: { criteria: { mode: "proof", step: "build", inputsHash: "h1" } } },
      from,
      new Map(),
      { stamps },
    );
    expect(cleared.phase).toBe("relates");
    expect(cleared.generates).toBe(false);
  });

  it("approval holds until human grant", () => {
    const from = sink("sink");
    const edge = {
      id: "e1",
      fromNode: "sink",
      toNode: "down",
      ether: { criteria: { mode: "approval" as const, step: "ship" } },
    };
    expect(evaluateEdge(edge, from, new Map()).phase).toBe("blocks");
    const granted = evaluateEdge(edge, from, new Map(), {
      approvals: new Map([["ship", { step: "ship", principal: "human" as const, ts: 1 }]]),
    });
    expect(granted.phase).toBe("relates");
  });
});
