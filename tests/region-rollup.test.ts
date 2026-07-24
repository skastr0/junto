import { describe, expect, it } from "vitest";
import type { A2ATask, CanvasDoc } from "../src/shared/canvas";
import type { GlyphRow, GlyphView } from "../src/shared/execution-graph";
import { deriveRegionRollups, type AgentActivity } from "../src/shared/region-rollup";
import type { WorkSurfaceActivity } from "../src/shared/terminal";
import { a2aTask } from "./helpers/a2a-fixtures";
import { kindForRole } from "./helpers/physics-seats";

type Node = CanvasDoc["nodes"][number];
type Edge = CanvasDoc["edges"][number];

// Membership is center-containment, so fixtures place whole nodes inside the
// region rect (nodes are 100x40 unless overridden).
const node = (id: string, x: number, y: number, text: string, ether?: Node["ether"]): Node => ({
  id,
  type: "text",
  text,
  x,
  y,
  width: 100,
  height: 40,
  ...(ether ? { ether } : {}),
});

const group = (id: string, x: number, y: number, width: number, height: number, label?: string): Node => ({
  id,
  type: "group",
  x,
  y,
  width,
  height,
  ...(label !== undefined ? { label } : {}),
});

const projectNode = (id: string, x: number, y: number, label: string, projectKey: string): Node =>
  node(id, x, y, label, { entity: { kind: "project", name: projectKey } });

const agentNode = (id: string, x: number, y: number, label: string, agentKey: string): Node =>
  node(id, x, y, label, { entity: { kind: "agent", name: agentKey } });

/** Phase-blockable seat (physics actor). Kind is registry plumbing only. */
const actorSeat = (id: string, x: number, y: number, label: string): Node =>
  node(id, x, y, label, { entity: { kind: kindForRole("actor") } });

const taskNode = (
  id: string,
  x: number,
  y: number,
  label: string,
  items: ReadonlyArray<A2ATask>,
): Node => node(id, x, y, label, { entity: { kind: "task" }, tasks: { items: [...items] } });

const glyphRow = (state: string): GlyphRow => ({ glyphId: "g-1", orbit: "forge", title: "work", state });

const activityOf = (...entries: Array<[string, AgentActivity]>): ReadonlyMap<string, AgentActivity> =>
  new Map(entries);

describe("deriveRegionRollups — member severity ladder", () => {
  it("blocked via blocker flag", () => {
    const doc: CanvasDoc = {
      nodes: [group("r", 0, 0, 500, 500, "ops"), node("n", 10, 10, "hot", { flags: ["blocker"] })],
      edges: [],
    };
    const [rollup] = deriveRegionRollups({ doc });
    expect(rollup?.severity).toBe("blocked");
    expect(rollup?.members[0]).toMatchObject({ nodeId: "n", severity: "blocked", reasons: ["flag:blocker"] });
  });

  it("blocked via execution graph: tasks criteria edge blocks its actor target from the document alone", () => {
    const doc: CanvasDoc = {
      nodes: [
        group("r", 0, 0, 500, 500, "ops"),
        taskNode("t", 10, 10, "Ops tasks", [a2aTask("i1", "ship", "input-required")]),
        actorSeat("p", 10, 100, "prism"),
      ],
      edges: [{ id: "e1", fromNode: "t", toNode: "p", ether: { criteria: { mode: "tasks" } } }],
    };
    const [rollup] = deriveRegionRollups({ doc });
    const target = rollup?.members.find((member) => member.nodeId === "p");
    expect(target?.severity).toBe("blocked");
    expect(target?.reasons).toEqual(["edge:1 need input · ship"]);
    expect(rollup?.counts).toEqual({ total: 2, blocked: 1, attention: 0, working: 0 });
  });

  it("blocked via seed: a manual blocker on an actor pushes through an outbound relaying edge", () => {
    const doc: CanvasDoc = {
      nodes: [
        group("r", 0, 0, 500, 500, "ops"),
        actorSeat("s", 10, 10, "Prism"),
        actorSeat("t", 10, 100, "Quasar"),
      ],
      edges: [],
    };
    const flagged: CanvasDoc = {
      ...doc,
      nodes: doc.nodes.map((n) =>
        n.id === "s" ? { ...n, ether: { ...n.ether, flags: ["blocker" as const] } } : n,
      ),
      edges: [{ id: "e1", fromNode: "s", toNode: "t", ether: { criteria: { mode: "tasks" } } }],
    };
    const [rollup] = deriveRegionRollups({ doc: flagged });
    const target = rollup?.members.find((member) => member.nodeId === "t");
    expect(target?.severity).toBe("blocked");
    expect(target?.reasons).toEqual(["seed:from blocker Prism"]);
  });

  it("blocked via relay: a blocked actor retransmits through an outbound depends edge", () => {
    const doc: CanvasDoc = {
      nodes: [
        group("r", 0, 0, 500, 500, "ops"),
        taskNode("t", 10, 10, "Ops tasks", [a2aTask("i1", "ship", "input-required")]),
        actorSeat("a", 10, 100, "prism"),
        actorSeat("b", 10, 200, "quasar"),
      ],
      edges: [
        { id: "e1", fromNode: "t", toNode: "a", ether: { criteria: { mode: "tasks" } } },
        // a has no open tasks -> depends -> relays the block onward to b
        { id: "e2", fromNode: "a", toNode: "b", ether: { criteria: { mode: "tasks" } } },
      ],
    };
    const [rollup] = deriveRegionRollups({ doc });
    const relayed = rollup?.members.find((member) => member.nodeId === "b");
    expect(relayed?.severity).toBe("blocked");
    expect(relayed?.reasons).toEqual(["relay"]);
  });

  it("graph reasons follow documented rank (edge before seed) when both apply", () => {
    const base: CanvasDoc = {
      nodes: [
        group("r", 0, 0, 800, 800, "ops"),
        taskNode("u", 10, 10, "Ops tasks", [a2aTask("i1", "ship", "input-required")]),
        actorSeat("s", 10, 110, "Seed source"),
        actorSeat("t", 10, 210, "Target"),
      ],
      edges: [
        { id: "e1", fromNode: "u", toNode: "t", ether: { criteria: { mode: "tasks" } } },
        { id: "e2", fromNode: "s", toNode: "t", ether: { criteria: { mode: "tasks" } } },
      ],
    };
    const flagged: CanvasDoc = {
      ...base,
      nodes: base.nodes.map((n) =>
        n.id === "s" ? { ...n, ether: { ...n.ether, flags: ["blocker" as const] } } : n,
      ),
    };
    const [rollup] = deriveRegionRollups({ doc: flagged });
    const target = rollup?.members.find((member) => member.nodeId === "t");
    expect(target?.severity).toBe("blocked");
    expect(target?.reasons).toEqual([
      "edge:1 need input · ship",
      "seed:from blocker Seed source",
    ]);
  });

  it("attention via flag, and via a pending permission on a live agent", () => {
    const doc: CanvasDoc = {
      nodes: [
        group("r", 0, 0, 500, 500, "ops"),
        node("n", 10, 10, "watch me", { flags: ["attention"] }),
        agentNode("a", 10, 100, "MIRA", "remote-a:mira"),
      ],
      edges: [],
    };
    const [rollup] = deriveRegionRollups({
      doc,
      agentActivity: activityOf(["remote-a:mira", { permissionPending: true }]),
    });
    expect(rollup?.severity).toBe("attention");
    const flagged = rollup?.members.find((member) => member.nodeId === "n");
    const agent = rollup?.members.find((member) => member.nodeId === "a");
    expect(flagged).toMatchObject({ severity: "attention", reasons: ["flag:attention"] });
    expect(agent).toMatchObject({ severity: "attention", reasons: ["permission:pending"] });
    expect(rollup?.counts).toEqual({ total: 2, blocked: 0, attention: 2, working: 0 });
  });

  it("session liveness alone does not imply harness work", () => {
    const doc: CanvasDoc = {
      nodes: [group("r", 0, 0, 500, 500, "ops"), agentNode("a", 10, 10, "MIRA", "remote-a:mira")],
      edges: [],
    };
    const [rollup] = deriveRegionRollups({
      doc,
      agentActivity: activityOf(["remote-a:mira", { sessionLive: true }]),
    });
    expect(rollup?.members[0]).toMatchObject({ severity: "idle", reasons: [] });
    expect(rollup?.counts).toEqual({ total: 1, blocked: 0, attention: 0, working: 0 });
  });

  it("maps backend-neutral harness activity without knowing terminal backend", () => {
    const terminal = node("term", 10, 10, "shell", { entity: { kind: "terminal" }, terminal: { bindingId: "b1" } });
    const doc: CanvasDoc = { nodes: [group("r", 0, 0, 500, 500, "ops"), terminal], edges: [] };
    const activity: WorkSurfaceActivity = { session: "running", harness: "working", source: "native" };
    const [rollup] = deriveRegionRollups({ doc, terminalStatusByNodeId: new Map([["term", activity]]) });
    expect(rollup?.members[0]).toMatchObject({ severity: "working", reasons: ["activity:working"] });
  });

  it("working via WIP glyphs on a project node, first such state", () => {
    const doc: CanvasDoc = {
      nodes: [group("r", 0, 0, 500, 500, "ops"), projectNode("p", 10, 10, "prism", "prism")],
      edges: [],
    };
    const glyphs: GlyphView = new Map([["prism", [glyphRow("done"), glyphRow("building"), glyphRow("reviewing")]]]);
    const [rollup] = deriveRegionRollups({ doc, glyphs });
    expect(rollup?.members[0]).toMatchObject({ severity: "working", reasons: ["glyph:wip:building"] });
  });

  it("parked via flag", () => {
    const doc: CanvasDoc = {
      nodes: [group("r", 0, 0, 500, 500, "ops"), node("n", 10, 10, "later", { flags: ["parked"] })],
      edges: [],
    };
    const [rollup] = deriveRegionRollups({ doc });
    expect(rollup?.severity).toBe("parked");
    expect(rollup?.members[0]).toMatchObject({ severity: "parked", reasons: ["flag:parked"] });
    // parked is not a bucketed count
    expect(rollup?.counts).toEqual({ total: 1, blocked: 0, attention: 0, working: 0 });
  });

  it("idle by default: unbound node with no flags and no live data", () => {
    const doc: CanvasDoc = {
      nodes: [group("r", 0, 0, 500, 500, "ops"), node("n", 10, 10, "plain note")],
      edges: [],
    };
    const [rollup] = deriveRegionRollups({ doc });
    expect(rollup?.severity).toBe("idle");
    expect(rollup?.members[0]).toMatchObject({ severity: "idle", kind: "node", reasons: [] });
  });

  it("worst tier wins; reasons collect every match in ladder order; counts bucket the worst only", () => {
    const doc: CanvasDoc = {
      nodes: [
        group("r", 0, 0, 500, 500, "ops"),
        agentNode("a", 10, 10, "MIRA", "remote-a:mira"),
      ],
      edges: [],
    };
    const flagged: CanvasDoc = {
      ...doc,
      nodes: doc.nodes.map((n) =>
        n.id === "a" ? { ...n, ether: { ...n.ether, flags: ["blocker" as const, "attention" as const] } } : n,
      ),
    };
    const [rollup] = deriveRegionRollups({
      doc: flagged,
      agentActivity: activityOf(["remote-a:mira", { sessionLive: true }]),
    });
    const member = rollup?.members[0];
    expect(member?.severity).toBe("blocked");
    expect(member?.reasons).toEqual(["flag:blocker", "flag:attention"]);
    expect(rollup?.counts).toEqual({ total: 1, blocked: 1, attention: 0, working: 0 });
  });
});

describe("deriveRegionRollups — graceful degradation", () => {
  const doc: CanvasDoc = {
    nodes: [
      group("r", 0, 0, 500, 500, "ops"),
      projectNode("p", 10, 10, "prism", "prism"),
      agentNode("a", 10, 100, "MIRA", "remote-a:mira"),
      projectNode("q", 10, 200, "quasar", "quasar"),
    ],
    edges: [{ id: "e1", fromNode: "p", toNode: "q", ether: { criteria: { mode: "wip" } } }],
  };

  it("missing activity and glyphs invent nothing: every member idle, edge stays relates", () => {
    const [rollup] = deriveRegionRollups({ doc });
    expect(rollup?.severity).toBe("idle");
    expect(rollup?.counts).toEqual({ total: 3, blocked: 0, attention: 0, working: 0 });
    expect(rollup?.members.every((member) => member.severity === "idle" && member.reasons.length === 0)).toBe(true);
  });

  it("a glyph view that lacks the project key still invents nothing", () => {
    const glyphs: GlyphView = new Map([["other-project", [glyphRow("building")]]]);
    const [rollup] = deriveRegionRollups({ doc, glyphs });
    expect(rollup?.severity).toBe("idle");
    expect(rollup?.members.every((member) => member.severity === "idle")).toBe(true);
  });

  it("undefined rows for the project key mean data unavailable, not work", () => {
    const glyphs: GlyphView = new Map([["prism", undefined]]);
    const [rollup] = deriveRegionRollups({ doc, glyphs });
    expect(rollup?.members.find((member) => member.nodeId === "p")?.severity).toBe("idle");
  });

  it("non-WIP glyph states do not count as work", () => {
    const glyphs: GlyphView = new Map([["prism", [glyphRow("done"), glyphRow("backlog")]]]);
    const [rollup] = deriveRegionRollups({ doc, glyphs });
    expect(rollup?.members.find((member) => member.nodeId === "p")?.severity).toBe("idle");
  });

  it("activity on a non-agent node is ignored", () => {
    const [rollup] = deriveRegionRollups({
      doc,
      agentActivity: activityOf(["prism", { sessionLive: true, permissionPending: true }]),
    });
    expect(rollup?.members.find((member) => member.nodeId === "p")?.severity).toBe("idle");
  });
});

describe("deriveRegionRollups — region shape", () => {
  it("empty region: idle, zero counts, no members", () => {
    const doc: CanvasDoc = { nodes: [group("r", 0, 0, 500, 500, "ops")], edges: [] };
    const [rollup] = deriveRegionRollups({ doc });
    expect(rollup).toMatchObject({
      regionId: "r",
      label: "ops",
      severity: "idle",
      counts: { total: 0, blocked: 0, attention: 0, working: 0 },
      members: [],
    });
  });

  it("no groups, no rollups", () => {
    const doc: CanvasDoc = { nodes: [node("n", 0, 0, "solo")], edges: [] };
    expect(deriveRegionRollups({ doc })).toEqual([]);
  });

  it("region label is trimmed; blank or absent label falls back to 'unnamed region'", () => {
    const doc: CanvasDoc = {
      nodes: [group("a", 0, 0, 100, 100, "  forge  "), group("b", 200, 0, 100, 100), group("c", 400, 0, 100, 100, "   ")],
      edges: [],
    };
    const rollups = deriveRegionRollups({ doc });
    expect(rollups.map((rollup) => rollup.label)).toEqual(["forge", "unnamed region", "unnamed region"]);
  });

  it("one rollup per group, in document order", () => {
    const doc: CanvasDoc = {
      nodes: [
        group("b", 300, 0, 200, 200, "second"),
        node("n", 10, 10, "x"),
        group("a", 0, 0, 200, 200, "first"),
      ],
      edges: [],
    };
    const rollups = deriveRegionRollups({ doc });
    expect(rollups.map((rollup) => rollup.regionId)).toEqual(["b", "a"]);
  });

  it("nodes outside every region are ignored", () => {
    const doc: CanvasDoc = {
      nodes: [
        group("r", 0, 0, 200, 200, "ops"),
        node("inside", 10, 10, "in"),
        node("outside", 500, 500, "out", { flags: ["blocker"] }),
      ],
      edges: [],
    };
    const [rollup] = deriveRegionRollups({ doc });
    expect(rollup?.counts.total).toBe(1);
    expect(rollup?.severity).toBe("idle");
  });

  it("a node whose center leaves the rect is not a member, even if it overlaps", () => {
    const doc: CanvasDoc = {
      nodes: [
        group("r", 0, 0, 200, 200, "ops"),
        // 100x40 node at (180, 10): center x = 230 > 200 -> outside
        node("edge", 180, 10, "half out"),
      ],
      edges: [],
    };
    const [rollup] = deriveRegionRollups({ doc });
    expect(rollup?.counts.total).toBe(0);
  });

  it("groups never contain groups: a group rect inside a region is not a member and rolls up on its own", () => {
    const doc: CanvasDoc = {
      nodes: [
        group("outer", 0, 0, 500, 500, "outer"),
        group("inner", 20, 20, 200, 200, "inner"),
        node("n", 30, 30, "deep", { flags: ["attention"] }),
      ],
      edges: [],
    };
    const rollups = deriveRegionRollups({ doc });
    const outer = rollups.find((rollup) => rollup.regionId === "outer");
    const inner = rollups.find((rollup) => rollup.regionId === "inner");
    expect(outer?.members.map((member) => member.nodeId)).toEqual(["n"]);
    expect(inner?.members.map((member) => member.nodeId)).toEqual(["n"]);
    expect(rollups).toHaveLength(2);
  });

  it("member labels follow the titleOf convention: text first line, file basename, link url", () => {
    const doc: CanvasDoc = {
      nodes: [
        group("r", 0, 0, 500, 500, "ops"),
        node("t", 10, 10, "First line\nsecond line"),
        { id: "f", type: "file", file: "docs/deep/plan.md", x: 10, y: 100, width: 100, height: 40 },
        { id: "l", type: "link", url: "https://example.com/spec", x: 10, y: 200, width: 100, height: 40 },
      ],
      edges: [],
    };
    const [rollup] = deriveRegionRollups({ doc });
    expect(rollup?.members.map((member) => member.label)).toEqual(["First line", "plan.md", "https://example.com/spec"]);
  });
});

describe("deriveRegionRollups — member ordering", () => {
  it("sorts by severity, then kind (agent, project, rest), then document order", () => {
    const doc: CanvasDoc = {
      nodes: [
        group("r", 0, 0, 800, 800, "ops"),
        node("idle1", 10, 10, "idle one"),
        projectNode("working-project", 10, 100, "prism", "prism"),
        agentNode("working-agent", 10, 200, "MIRA", "remote-a:mira"),
        node("blocked-note", 10, 300, "on fire", { flags: ["blocker"] }),
        node("idle2", 10, 400, "idle two"),
      ],
      edges: [],
    };
    const glyphs: GlyphView = new Map([["prism", [glyphRow("committed")]]]);
    const [rollup] = deriveRegionRollups({
      doc,
      glyphs,
      terminalStatusByNodeId: new Map([["working-agent", { session: "running", harness: "working" }]]),
    });
    expect(rollup?.members.map((member) => member.nodeId)).toEqual([
      "blocked-note",
      "working-agent",
      "working-project",
      "idle1",
      "idle2",
    ]);
  });
});

describe("deriveRegionRollups — derivation edges", () => {
  it("flag:blocker and a graph block on the same actor union their reasons, no duplicates", () => {
    const doc: CanvasDoc = {
      nodes: [
        group("r", 0, 0, 500, 500, "ops"),
        taskNode("u", 10, 10, "Ops tasks", [a2aTask("i1", "ship", "input-required")]),
        {
          ...actorSeat("t", 10, 100, "Target"),
          ether: {
            ...actorSeat("t", 10, 100, "Target").ether,
            flags: ["blocker" as const],
          },
        },
      ],
      edges: [{ id: "e1", fromNode: "u", toNode: "t", ether: { criteria: { mode: "tasks" } } }],
    };
    const [rollup] = deriveRegionRollups({ doc });
    const target = rollup?.members.find((member) => member.nodeId === "t");
    expect(target?.severity).toBe("blocked");
    expect(target?.reasons).toEqual(["flag:blocker", "edge:1 need input · ship"]);
    expect(new Set(target?.reasons).size).toBe(target?.reasons.length);
  });

  it("an agent with a pending permission and a live session is attention, reasons in ladder order", () => {
    const doc: CanvasDoc = {
      nodes: [group("r", 0, 0, 500, 500, "ops"), agentNode("a", 10, 10, "MIRA", "remote-a:mira")],
      edges: [],
    };
    const [rollup] = deriveRegionRollups({
      doc,
      agentActivity: activityOf(["remote-a:mira", { permissionPending: true, sessionLive: true }]),
    });
    const agent = rollup?.members[0];
    expect(agent?.severity).toBe("attention");
    expect(agent?.reasons).toEqual(["permission:pending"]);
    expect(rollup?.counts).toEqual({ total: 1, blocked: 0, attention: 1, working: 0 });
  });

  it("a non-project node whose name collides with a glyph-view key does not become working", () => {
    const doc: CanvasDoc = {
      nodes: [
        group("r", 0, 0, 500, 500, "ops"),
        node("o", 10, 10, "forge", { entity: { kind: "orbit", name: "prism" } }),
        agentNode("a", 10, 110, "twin", "prism"),
      ],
      edges: [],
    };
    // The view knows "prism" and it is hot — but only kind "project" reads it.
    const glyphs: GlyphView = new Map([["prism", [glyphRow("building")]]]);
    const [rollup] = deriveRegionRollups({ doc, glyphs });
    expect(rollup?.members.every((member) => member.severity === "idle" && member.reasons.length === 0)).toBe(
      true,
    );
  });
});

describe("deriveRegionRollups — backend-neutral terminal status", () => {
  const herdrNode = (
    id: string,
    x: number,
    y: number,
    host: string,
    paneId: string,
  ): Node => ({
    id,
    type: "text",
    text: "herdr",
    x,
    y,
    width: 100,
    height: 40,
    ether: { entity: { kind: "herdr" }, herdr: { host, paneId } },
  });

  it("herdr working elevates the member and region", () => {
    const doc: CanvasDoc = {
      nodes: [group("r", 0, 0, 500, 500, "ops"), herdrNode("h1", 10, 10, "local", "p1")],
      edges: [],
    };
    const [rollup] = deriveRegionRollups({
      doc,
      terminalStatusByNodeId: new Map([["h1", { session: "running", harness: "working", source: "herdr" }]]),
    });
    expect(rollup?.severity).toBe("working");
    expect(rollup?.members[0]).toMatchObject({
      severity: "working",
      kind: "herdr",
      reasons: ["activity:working"],
    });
    expect(rollup?.counts).toEqual({ total: 1, blocked: 0, attention: 0, working: 1 });
  });

  it("herdr blocked and done map to blocked / attention", () => {
    const doc: CanvasDoc = {
      nodes: [
        group("r", 0, 0, 500, 500, "ops"),
        herdrNode("h1", 10, 10, "local", "p1"),
        herdrNode("h2", 10, 100, "local", "p2"),
      ],
      edges: [],
    };
    const [rollup] = deriveRegionRollups({
      doc,
      terminalStatusByNodeId: new Map([
        ["h1", { session: "running", harness: "blocked", source: "herdr" } as const],
        ["h2", { session: "running", harness: "attention", source: "herdr" } as const],
      ]),
    });
    expect(rollup?.severity).toBe("blocked");
    expect(rollup?.members.map((m) => m.severity)).toEqual(["blocked", "attention"]);
    expect(rollup?.counts).toEqual({ total: 2, blocked: 1, attention: 1, working: 0 });
  });

  it("missing herdr status invents nothing; idle herdr is not elevated", () => {
    const doc: CanvasDoc = {
      nodes: [group("r", 0, 0, 500, 500, "ops"), herdrNode("h1", 10, 10, "local", "p1")],
      edges: [],
    };
    expect(deriveRegionRollups({ doc })[0]?.severity).toBe("idle");
    expect(
      deriveRegionRollups({ doc, terminalStatusByNodeId: new Map([["h1", { session: "running", harness: "idle" }]]) })[0]?.severity,
    ).toBe("idle");
  });
});
