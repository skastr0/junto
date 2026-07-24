import { describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import {
  composeRegionExecutionContext,
  deriveExecutionGraph,
  edgeGlyphProjects,
  evaluateEdge,
  type GlyphRow,
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

/** Named sink used as glyph/wip criteria source (join key = name). */
const projectNode = (id: string, label: string, projectKey: string) =>
  seat(id, "sink", { label, name: projectKey });

const glyph = (partial: Partial<GlyphRow> & Pick<GlyphRow, "glyphId" | "state">): GlyphRow => ({
  orbit: "forge",
  title: partial.glyphId,
  ...partial,
});

const viewOf = (...entries: Array<[string, ReadonlyArray<GlyphRow> | undefined]>): GlyphView =>
  new Map(entries);

describe("evaluateEdge — authorial modes", () => {
  it("no criteria → relates", () => {
    const edge = { id: "e1", fromNode: "a", toNode: "b" };
    const result = evaluateEdge(edge, projectNode("a", "A", "proj"), new Map());
    expect(result.phase).toBe("relates");
    expect(result.generates).toBe(false);
  });

  it("kind-only ether is soft relates (kind is not authorial)", () => {
    const edge = { id: "e1", fromNode: "a", toNode: "b", ether: { kind: "blocks" as const } };
    const result = evaluateEdge(edge, projectNode("a", "A", "proj"), new Map());
    expect(result.phase).toBe("relates");
    expect(result.generates).toBe(false);
  });

  it("selected glyphs pending → blocks; all done → depends", () => {
    const from = projectNode("a", "A", "proj");
    const edge = {
      id: "e1",
      fromNode: "a",
      toNode: "b",
      ether: {
        criteria: { mode: "glyphs" as const, glyphIds: ["g1", "g2"] },
      },
    };
    const pending = evaluateEdge(
      edge,
      from,
      viewOf(["proj", [glyph({ glyphId: "g1", state: "building" }), glyph({ glyphId: "g2", state: "done" })]]),
    );
    expect(pending.phase).toBe("blocks");
    expect(pending.generates).toBe(true);

    const done = evaluateEdge(
      edge,
      from,
      viewOf(["proj", [glyph({ glyphId: "g1", state: "done" }), glyph({ glyphId: "g2", state: "done" })]]),
    );
    expect(done.phase).toBe("depends");
    expect(done.generates).toBe(false);
    expect(done.relays).toBe(true);
  });

  it("opt-in WIP: any committed|building|reviewing → blocks; clear → depends", () => {
    const from = projectNode("a", "A", "proj");
    const edge = {
      id: "e1",
      fromNode: "a",
      toNode: "b",
      ether: { criteria: { mode: "wip" as const } },
    };
    const hot = evaluateEdge(
      edge,
      from,
      viewOf([
        "proj",
        [
          glyph({ glyphId: "g1", state: "backlog" }),
          glyph({ glyphId: "g2", state: "building" }),
        ],
      ]),
    );
    expect(hot.phase).toBe("blocks");

    const cold = evaluateEdge(
      edge,
      from,
      viewOf([
        "proj",
        [
          glyph({ glyphId: "g1", state: "backlog" }),
          glyph({ glyphId: "g2", state: "done" }),
          glyph({ glyphId: "g3", state: "exploring" }),
        ],
      ]),
    );
    expect(cold.phase).toBe("depends");
  });

  it("unknown/missing glyph index does not generate blocks", () => {
    const from = projectNode("a", "A", "proj");
    const edge = {
      id: "e1",
      fromNode: "a",
      toNode: "b",
      ether: { criteria: { mode: "glyphs" as const, glyphIds: ["g1"] } },
    };
    expect(evaluateEdge(edge, from, new Map()).phase).toBe("relates");
    expect(evaluateEdge(edge, from, viewOf(["proj", undefined])).phase).toBe("relates");
    expect(evaluateEdge(edge, from, new Map()).generates).toBe(false);
  });

  it("tasks criteria: submitted/working do not block; input-required does; clear depends", () => {
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
    expect(evaluateEdge(edge, openQueue, new Map()).phase).toBe("depends");
    expect(evaluateEdge(edge, openQueue, new Map()).generates).toBe(false);

    const needsInput = text("t1", "Checklist", {
      entity: { kind: "task" },
      tasks: {
        items: [a2aTask("i1", "one", "input-required"), a2aTask("i2", "two", "completed")],
      },
    });
    expect(evaluateEdge(edge, needsInput, new Map()).phase).toBe("blocks");
    expect(evaluateEdge(edge, needsInput, new Map()).generates).toBe(true);

    const auth = text("t1", "Checklist", {
      entity: { kind: "task" },
      tasks: { items: [a2aTask("i1", "auth", "auth-required")] },
    });
    expect(evaluateEdge(edge, auth, new Map()).phase).toBe("blocks");

    const doneTasks = text("t1", "Checklist", {
      entity: { kind: "task" },
      tasks: {
        items: [a2aTask("i1", "one", "completed"), a2aTask("i2", "two", "completed")],
      },
    });
    expect(evaluateEdge(edge, doneTasks, new Map()).phase).toBe("depends");

    const empty = text("t1", "Checklist", { entity: { kind: "task" }, tasks: { items: [] } });
    expect(evaluateEdge(edge, empty, new Map()).phase).toBe("depends");
  });

  it("requests criteria: input-required blocks; completed/rejected/canceled depends", () => {
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
      expect(evaluateEdge(edge, resolved, new Map()).phase).toBe("depends");
    }
  });

  it("tasks criteria: canceled/failed/rejected are terminal and do not block", () => {
    const edge = {
      id: "e1",
      fromNode: "t1",
      toNode: "b",
      ether: { criteria: { mode: "tasks" as const } },
    };
    for (const state of ["canceled", "failed", "rejected"] as const) {
      const node = text("t1", "Checklist", {
        entity: { kind: "task" },
        tasks: { items: [a2aTask("i1", "x", state)] },
      });
      expect(evaluateEdge(edge, node, new Map()).phase).toBe("depends");
    }
  });
});

describe("deriveExecutionGraph — propagation", () => {
  it("sink→actor→actor: generating blocks actor B and relays to actor C", () => {
    const doc: CanvasDoc = {
      nodes: [
        seat("a", "sink", { label: "A", name: "proj-a" }),
        seat("b", "actor", { label: "B" }),
        seat("c", "actor", { label: "C" }),
      ],
      edges: [
        {
          id: "e-ab",
          fromNode: "a",
          toNode: "b",
          ether: { criteria: { mode: "glyphs", glyphIds: ["g1"] } },
        },
        {
          id: "e-bc",
          fromNode: "b",
          toNode: "c",
          ether: { criteria: { mode: "glyphs", project: "proj-b", glyphIds: ["gb"] } },
        },
      ],
    };
    const glyphs = viewOf(
      ["proj-a", [glyph({ glyphId: "g1", state: "building" })]],
      ["proj-b", [glyph({ glyphId: "gb", state: "done" })]],
    );
    const graph = deriveExecutionGraph(doc, glyphs);
    expect(graph.phaseByEdgeId.get("e-ab")).toBe("blocks");
    expect(graph.phaseByEdgeId.get("e-bc")).toBe("depends");
    // sink never in blocked set; actors B (generate) and C (relay) are
    expect(graph.blocked.has("a")).toBe(false);
    expect(graph.blocked).toEqual(new Set(["b", "c"]));
    expect(graph.blockedEdgeIds.has("e-ab")).toBe(true);
    expect(graph.blockedEdgeIds.has("e-bc")).toBe(true);
  });

  it("when generating condition clears, relay chain unblocks", () => {
    const doc: CanvasDoc = {
      nodes: [
        seat("a", "sink", { label: "A", name: "proj-a" }),
        seat("b", "actor", { label: "B" }),
        seat("c", "actor", { label: "C" }),
      ],
      edges: [
        {
          id: "e-ab",
          fromNode: "a",
          toNode: "b",
          ether: { criteria: { mode: "glyphs", glyphIds: ["g1"] } },
        },
        {
          id: "e-bc",
          fromNode: "b",
          toNode: "c",
          ether: { criteria: { mode: "glyphs", project: "proj-b", glyphIds: ["gb"] } },
        },
      ],
    };
    const clear = viewOf(
      ["proj-a", [glyph({ glyphId: "g1", state: "done" })]],
      ["proj-b", [glyph({ glyphId: "gb", state: "done" })]],
    );
    const graph = deriveExecutionGraph(doc, clear);
    expect(graph.phaseByEdgeId.get("e-ab")).toBe("depends");
    expect(graph.blocked.size).toBe(0);
  });

  it("relates never generates or relays", () => {
    const doc: CanvasDoc = {
      nodes: [
        seat("a", "sink", { label: "A", name: "proj-a" }),
        seat("b", "actor", { label: "B" }),
        seat("c", "actor", { label: "C" }),
      ],
      edges: [
        {
          id: "e-ab",
          fromNode: "a",
          toNode: "b",
          ether: { criteria: { mode: "glyphs", glyphIds: ["g1"] } },
        },
        { id: "e-bc", fromNode: "b", toNode: "c" }, // relates
      ],
    };
    const glyphs = viewOf(["proj-a", [glyph({ glyphId: "g1", state: "building" })]]);
    const graph = deriveExecutionGraph(doc, glyphs);
    expect(graph.blocked).toEqual(new Set(["b"]));
    expect(graph.blocked.has("c")).toBe(false);
  });

  it("submitted tasks never block; input-required blocks actors only (not sinks)", () => {
    const tasks = text("t1", "Checklist", {
      entity: { kind: "task" },
      tasks: { items: [a2aTask("i1", "do it", "submitted")] },
    });
    const actor = seat("worker", "actor", { label: "worker" });
    const sinkSeat = seat("p1", "sink", { label: "Proj", name: "proj" });

    const submittedToActor: CanvasDoc = {
      nodes: [tasks, actor],
      edges: [
        {
          id: "e1",
          fromNode: "t1",
          toNode: "worker",
          ether: { criteria: { mode: "tasks" } },
        },
      ],
    };
    const calm = deriveExecutionGraph(submittedToActor);
    expect(calm.phaseByEdgeId.get("e1")).toBe("depends");
    expect(calm.blocked.size).toBe(0);

    const needsInput = text("t1", "Checklist", {
      entity: { kind: "task" },
      tasks: { items: [a2aTask("i1", "do it", "input-required")] },
    });
    const hotToActor: CanvasDoc = {
      nodes: [needsInput, actor],
      edges: [
        {
          id: "e1",
          fromNode: "t1",
          toNode: "worker",
          ether: { criteria: { mode: "tasks" } },
        },
      ],
    };
    const hot = deriveExecutionGraph(hotToActor);
    expect(hot.phaseByEdgeId.get("e1")).toBe("blocks");
    expect(hot.blocked).toEqual(new Set(["worker"]));

    // Sink never joins blocked set even when edge phase is blocks.
    const hotToSink: CanvasDoc = {
      nodes: [needsInput, sinkSeat],
      edges: [
        {
          id: "e2",
          fromNode: "t1",
          toNode: "p1",
          ether: { criteria: { mode: "tasks" } },
        },
      ],
    };
    const sinkGraph = deriveExecutionGraph(hotToSink);
    expect(sinkGraph.phaseByEdgeId.get("e2")).toBe("blocks");
    expect(sinkGraph.blocked.has("p1")).toBe(false);
  });

  it("blocked set is actors only — sinks and furniture never", () => {
    const doc: CanvasDoc = {
      nodes: [
        seat("src", "sink", { label: "src", name: "proj-a" }),
        furnitureSeat("note1", "just a note"),
        seat("actor1", "actor", { label: "A1" }),
        seat("actor2", "actor", { label: "A2" }),
      ],
      edges: [
        { id: "e1", fromNode: "src", toNode: "note1", ether: { criteria: { mode: "wip", project: "proj-a" } } },
        { id: "e2", fromNode: "src", toNode: "actor1", ether: { criteria: { mode: "wip", project: "proj-a" } } },
        { id: "e3", fromNode: "src", toNode: "actor2", ether: { criteria: { mode: "wip", project: "proj-a" } } },
      ],
    };
    const glyphs = viewOf(["proj-a", [glyph({ glyphId: "g1", state: "building" })]]);
    const graph = deriveExecutionGraph(doc, glyphs);
    expect(graph.blocked.has("src")).toBe(false);
    expect(graph.blocked.has("note1")).toBe(false);
    expect(graph.blocked.has("actor1")).toBe(true);
    expect(graph.blocked.has("actor2")).toBe(true);
  });

  it("multi-inbound: either generating edge is enough", () => {
    const doc: CanvasDoc = {
      nodes: [
        seat("a", "sink", { label: "A", name: "pa" }),
        seat("b", "sink", { label: "B", name: "pb" }),
        seat("c", "actor", { label: "C" }),
      ],
      edges: [
        {
          id: "e-ac",
          fromNode: "a",
          toNode: "c",
          ether: { criteria: { mode: "glyphs", glyphIds: ["g1"] } },
        },
        {
          id: "e-bc",
          fromNode: "b",
          toNode: "c",
          ether: { criteria: { mode: "glyphs", glyphIds: ["g2"] } },
        },
      ],
    };
    const glyphs = viewOf(
      ["pa", [glyph({ glyphId: "g1", state: "done" })]],
      ["pb", [glyph({ glyphId: "g2", state: "reviewing" })]],
    );
    const graph = deriveExecutionGraph(doc, glyphs);
    expect(graph.blocked).toEqual(new Set(["c"]));
    expect(graph.phaseByEdgeId.get("e-ac")).toBe("depends");
    expect(graph.phaseByEdgeId.get("e-bc")).toBe("blocks");
  });

  it("manual blocker flag on actor seeds outbound depends onto another actor", () => {
    const doc2: CanvasDoc = {
      nodes: [
        seat("b", "actor", { label: "B", flags: ["blocker"] }),
        seat("c", "actor", { label: "C" }),
      ],
      edges: [
        {
          id: "e-bc",
          fromNode: "b",
          toNode: "c",
          ether: { criteria: { mode: "glyphs", project: "pb", glyphIds: ["gx"] } },
        },
      ],
    };
    const glyphs = viewOf(["pb", [glyph({ glyphId: "gx", state: "done" })]]);
    const graph = deriveExecutionGraph(doc2, glyphs);
    expect(graph.seedNodeIds.has("b")).toBe(true);
    expect(graph.phaseByEdgeId.get("e-bc")).toBe("depends");
    expect(graph.blocked.has("c")).toBe(true);
  });

  it("edgeGlyphProjects collects criteria projects", () => {
    const doc: CanvasDoc = {
      nodes: [projectNode("a", "A", "pa"), projectNode("b", "B", "pb")],
      edges: [
        {
          id: "e1",
          fromNode: "a",
          toNode: "b",
          ether: { criteria: { mode: "wip" } },
        },
        {
          id: "e2",
          fromNode: "a",
          toNode: "b",
          ether: { criteria: { mode: "glyphs", project: "explicit", glyphIds: ["x"] } },
        },
      ],
    };
    // duplicate e2 same pair not allowed in real UI but fine for unit collection
    const projects = edgeGlyphProjects({
      nodes: doc.nodes,
      edges: [
        doc.edges[0]!,
        {
          id: "e2",
          fromNode: "a",
          toNode: "b",
          ether: { criteria: { mode: "glyphs", project: "explicit", glyphIds: ["x"] } },
        },
      ],
    });
    expect(projects).toEqual(new Set(["pa", "explicit"]));
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
          tasks: { items: [a2aTask("i1", "ship docs", "submitted")] },
        }),
      ],
      edges: [
        {
          id: "e-ab",
          fromNode: "a",
          toNode: "b",
          ether: { criteria: { mode: "glyphs", glyphIds: ["g1"] } },
        },
      ],
    };
    (doc.nodes[3] as { x: number; y: number }).x = 40;
    (doc.nodes[3] as { x: number; y: number }).y = 100;

    const glyphs = viewOf(["pa", [glyph({ glyphId: "g1", state: "building" })]]);
    const graph = deriveExecutionGraph(doc, glyphs);
    const members = groupMembers(doc).get("grp") ?? [];
    const ctx = composeRegionExecutionContext(doc, "grp", graph, members);
    expect(ctx).toContain("execution");
    expect(ctx).toContain("Alpha --blocks");
    expect(ctx).toContain("blocked");
    expect(ctx).toContain("Beta");
    expect(ctx).toContain("tasks");
    expect(ctx).toContain("ship docs");
  });
});

describe("evaluateEdge — proof / approval (S8 trust plane)", () => {
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

  it("proof edge with no stamp → blocks; reason names missing step", () => {
    const from = sink("sink");
    const edge = {
      id: "e1",
      fromNode: "sink",
      toNode: "down",
      ether: { criteria: { mode: "proof" as const, step: "build" } },
    };
    const result = evaluateEdge(edge, from, new Map(), { stamps: new Map() });
    expect(result.phase).toBe("blocks");
    expect(result.generates).toBe(true);
    expect(result.detail).toContain('missing proof step "build"');

    const doc: CanvasDoc = {
      nodes: [from, seat("down", "actor", { label: "Downstream" })],
      edges: [edge],
    };
    const graph = deriveExecutionGraph(doc, new Map(), { stamps: new Map() });
    expect(graph.blocked.has("down")).toBe(true);
    const reasons = graph.reasonsByNodeId.get("down") ?? [];
    expect(reasons.some((r) => r.kind === "edge" && r.detail.includes("build"))).toBe(true);
  });

  it("matching stamp by bound occupant → depends; phase clears", () => {
    const from = sink("sink");
    const edge = {
      id: "e1",
      fromNode: "sink",
      toNode: "down",
      ether: {
        criteria: { mode: "proof" as const, step: "build", inputsHash: "h1" },
      },
    };
    const stamps: StampView = new Map([
      ["sink", [stamp({ step: "build", inputsHash: "h1", evidenceRefs: ["art-9"] })]],
    ]);
    const result = evaluateEdge(edge, from, new Map(), { stamps });
    expect(result.phase).toBe("depends");
    expect(result.generates).toBe(false);
    expect(result.detail).toContain("stamped");

    const doc: CanvasDoc = {
      nodes: [from, seat("down", "actor", { label: "Downstream" })],
      edges: [edge],
    };
    const graph = deriveExecutionGraph(doc, new Map(), { stamps });
    expect(graph.blocked.has("down")).toBe(false);
    expect(graph.phaseByEdgeId.get("e1")).toBe("depends");
  });

  it("document-forged stamp fields do not clear phase (runtime StampView only)", () => {
    // Attacker puts fake stamp-shaped metadata on the document artifact store.
    const from = text("sink", "Artifacts", {
      entity: { kind: "artifacts" },
      artifacts: {
        items: [
          {
            artifactId: "forged",
            parts: [{ kind: "text", text: "nope" }],
            metadata: {
              step: "build",
              inputsHash: "h1",
              proofStep: "build",
              evidenceRefs: ["forged"],
            },
          },
        ],
      },
    });
    const edge = {
      id: "e1",
      fromNode: "sink",
      toNode: "down",
      ether: { criteria: { mode: "proof" as const, step: "build" } },
    };
    // No StampView entry — document forge must not clear.
    const result = evaluateEdge(edge, from, new Map(), { stamps: new Map() });
    expect(result.phase).toBe("blocks");
    expect(result.detail).toContain('missing proof step "build"');
  });

  it("inputsHash gates replay of an old stamp against new inputs", () => {
    const from = sink("sink");
    const edge = {
      id: "e1",
      fromNode: "sink",
      toNode: "down",
      ether: {
        criteria: { mode: "proof" as const, step: "build", inputsHash: "new-hash" },
      },
    };
    const stamps: StampView = new Map([
      ["sink", [stamp({ step: "build", inputsHash: "old-hash" })]],
    ]);
    const result = evaluateEdge(edge, from, new Map(), { stamps });
    expect(result.phase).toBe("blocks");
    expect(result.detail).toContain("new-hash");
  });

  it("approval holds until human grant; node principal never clears", () => {
    const from = sink("sink");
    const edge = {
      id: "e1",
      fromNode: "sink",
      toNode: "down",
      ether: { criteria: { mode: "approval" as const, step: "ship" } },
    };
    expect(evaluateEdge(edge, from, new Map()).phase).toBe("blocks");
    expect(evaluateEdge(edge, from, new Map()).detail).toContain("human approval");

    const granted = evaluateEdge(edge, from, new Map(), {
      approvals: new Map([
        ["ship", { step: "ship", principal: "human" as const, ts: 1 }],
      ]),
    });
    expect(granted.phase).toBe("depends");
    expect(granted.detail).toContain("granted");
  });
});

