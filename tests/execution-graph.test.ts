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

  it("tasks criteria: incomplete blocks; all done depends; empty list depends", () => {
    const tasks = text("t1", "Checklist", {
      entity: { kind: "task" },
      tasks: {
        items: [
          { id: "i1", text: "one", done: false },
          { id: "i2", text: "two", done: true },
        ],
      },
    });
    const edge = {
      id: "e1",
      fromNode: "t1",
      toNode: "b",
      ether: { criteria: { mode: "tasks" as const } },
    };
    expect(evaluateEdge(edge, tasks, new Map()).phase).toBe("blocks");

    const doneTasks = text("t1", "Checklist", {
      entity: { kind: "task" },
      tasks: {
        items: [
          { id: "i1", text: "one", done: true },
          { id: "i2", text: "two", done: true },
        ],
      },
    });
    expect(evaluateEdge(edge, doneTasks, new Map()).phase).toBe("depends");

    const empty = text("t1", "Checklist", { entity: { kind: "task" }, tasks: { items: [] } });
    expect(evaluateEdge(edge, empty, new Map()).phase).toBe("depends");
  });
});

describe("deriveExecutionGraph — propagation", () => {
  it("chain A→B→C: generating A blocks B and relays to C through depends", () => {
    const doc: CanvasDoc = {
      nodes: [
        projectNode("a", "A", "proj-a"),
        projectNode("b", "B", "proj-b"),
        projectNode("c", "C", "proj-c"),
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
    expect(graph.blocked).toEqual(new Set(["b", "c"]));
    expect(graph.blockedEdgeIds.has("e-ab")).toBe(true);
    expect(graph.blockedEdgeIds.has("e-bc")).toBe(true);
  });

  it("when generating condition clears, relay chain unblocks", () => {
    const doc: CanvasDoc = {
      nodes: [
        projectNode("a", "A", "proj-a"),
        projectNode("b", "B", "proj-b"),
        projectNode("c", "C", "proj-c"),
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
        projectNode("a", "A", "proj-a"),
        projectNode("b", "B", "proj-b"),
        projectNode("c", "C", "proj-c"),
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

  it("tasks incomplete without edge does not block; with edge does", () => {
    const tasks = text("t1", "Checklist", {
      entity: { kind: "task" },
      tasks: { items: [{ id: "i1", text: "do it", done: false }] },
    });
    const target = projectNode("p1", "Proj", "proj");
    const noEdge: CanvasDoc = { nodes: [tasks, target], edges: [] };
    expect(deriveExecutionGraph(noEdge).blocked.size).toBe(0);

    const withEdge: CanvasDoc = {
      nodes: [tasks, target],
      edges: [
        {
          id: "e1",
          fromNode: "t1",
          toNode: "p1",
          ether: { criteria: { mode: "tasks" } },
        },
      ],
    };
    const graph = deriveExecutionGraph(withEdge);
    expect(graph.blocked).toEqual(new Set(["p1"]));
    expect(graph.phaseByEdgeId.get("e1")).toBe("blocks");
  });

  it("notes and agents are never blocked", () => {
    const doc: CanvasDoc = {
      nodes: [
        projectNode("a", "A", "proj-a"),
        text("note1", "just a note"),
        text("agent1", "hermes", {
          entity: { kind: "agent", name: "local:default" },
        }),
      ],
      edges: [
        { id: "e1", fromNode: "a", toNode: "note1", ether: { criteria: { mode: "wip", project: "proj-a" } } },
        { id: "e2", fromNode: "a", toNode: "agent1", ether: { criteria: { mode: "wip", project: "proj-a" } } },
      ],
    };
    const glyphs = viewOf(["proj-a", [glyph({ glyphId: "g1", state: "building" })]]);
    const graph = deriveExecutionGraph(doc, glyphs);
    expect(graph.blocked.size).toBe(0);
  });

  it("multi-inbound: either generating edge is enough", () => {
    const doc: CanvasDoc = {
      nodes: [
        projectNode("a", "A", "pa"),
        projectNode("b", "B", "pb"),
        projectNode("c", "C", "pc"),
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

  it("manual blocker flag seeds outbound depends criteria edges", () => {
    const doc2: CanvasDoc = {
      nodes: [
        projectNode("a", "A", "pa"),
        text("b", "B", {
          entity: { kind: "project", name: "pb" },
          flags: ["blocker"],
        }),
        projectNode("c", "C", "pc"),
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
        projectNode("a", "Alpha", "pa"),
        projectNode("b", "Beta", "pb"),
        text("t1", "Ops", {
          entity: { kind: "task" },
          tasks: { items: [{ id: "i1", text: "ship docs", done: false }] },
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
    // place members inside group for groupMembers (center-in)
    (doc.nodes[1] as { x: number; y: number }).x = 20;
    (doc.nodes[1] as { x: number; y: number }).y = 20;
    (doc.nodes[2] as { x: number; y: number }).x = 200;
    (doc.nodes[2] as { x: number; y: number }).y = 20;
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
