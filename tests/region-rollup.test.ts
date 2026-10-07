import { describe, expect, it } from "vitest";
import { asNodeId, type Node, type Wire } from "../src/shared/model";
import { canvasOf, note, region, seat, terminal } from "./support/model-nodes";
import {
  deriveRegionRollups as deriveRegionRollupsWithContext,
  type AgentActivity,
  type RegionRollupInput,
} from "../src/shared/region-rollup";
import type { WorkSurfaceActivity } from "../src/shared/terminal";
import { actorRefFixture } from "./helpers/actor-ref-fixtures";

/** A canvas as a test writes it: its nodes in paint order, and its wires. */
type Fixture = { readonly nodes: ReadonlyArray<Node>; readonly edges: ReadonlyArray<Wire> };

type RegionRollupFixtureInput = Omit<
  RegionRollupInput,
  "canvasName" | "resolveActorRef" | "canvas" | "itemsOf"
> & { readonly doc: Fixture };

const deriveRegionRollups = (input: RegionRollupFixtureInput) => {
  const { doc, ...rest } = input;
  const refs = new Map(
    doc.nodes.filter((held) => held.kind === "agent").map((held) => [held.id as string, actorRefFixture(held.id, "factory")]),
  );
  return deriveRegionRollupsWithContext({
    ...rest,
    canvas: canvasOf(doc.nodes, doc.edges),
    // No canvas here holds work.
    itemsOf: () => [],
    canvasName: "factory",
    resolveActorRef: (ref) => refs.get(ref.nodeId),
  });
};

// Membership is center-containment, so fixtures place whole nodes inside the
// region rect (nodes are 100x40 unless overridden).
const at = (x: number, y: number) => ({ x, y, width: 100, height: 40 });

const node = (id: string, x: number, y: number, text: string): Node => note(id, text, at(x, y));

const group = (id: string, x: number, y: number, width: number, height: number, label?: string): Node =>
  region(id, { x, y, width, height }, label !== undefined ? { label } : {});

/** Furniture that carries a name an agent also has: activity never reaches it. */
const projectNode = (id: string, x: number, y: number, label: string, _name: string): Node =>
  node(id, x, y, label);

const agentNode = (id: string, x: number, y: number, label: string, agentKey: string): Node =>
  seat(id, { ...at(x, y), label, agentKey, harness: "hermes" });

/** A terminal work surface whose live harness state the rollup reads. */
const liveSurface = (id: string, x: number, y: number, label: string): Node =>
  terminal(id, { ...at(x, y), label });

const harnessOf = (
  ...entries: Array<[string, WorkSurfaceActivity["harness"]]>
): ReadonlyMap<string, WorkSurfaceActivity> =>
  new Map(entries.map(([id, harness]) => [id, { session: "running", harness }]));

const activityOf = (...entries: Array<[string, AgentActivity]>): ReadonlyMap<string, AgentActivity> =>
  new Map(entries);

describe("deriveRegionRollups — member severity ladder", () => {
  it("attention via a pending permission on a live agent", () => {
    const doc: Fixture = {
      nodes: [
        group("r", 0, 0, 500, 500, "ops"),
        agentNode("a", 10, 100, "PROFILE-13", "remote-a:profile-13"),
      ],
      edges: [],
    };
    const [rollup] = deriveRegionRollups({
      doc,
      agentActivity: activityOf(["remote-a:profile-13", { permissionPending: true }]),
    });
    expect(rollup?.severity).toBe("attention");
    const agent = rollup?.members.find((member) => member.nodeId === "a");
    expect(agent).toMatchObject({ severity: "attention", reasons: ["permission:pending"] });
    expect(rollup?.counts).toEqual({ total: 1, blocked: 0, attention: 1, working: 0 , ready: 0 });
  });

  it("session liveness alone does not imply harness work", () => {
    const doc: Fixture = {
      nodes: [group("r", 0, 0, 500, 500, "ops"), agentNode("a", 10, 10, "PROFILE-13", "remote-a:profile-13")],
      edges: [],
    };
    const [rollup] = deriveRegionRollups({
      doc,
      agentActivity: activityOf(["remote-a:profile-13", { sessionLive: true }]),
    });
    expect(rollup?.members[0]).toMatchObject({ severity: "idle", reasons: [] });
    expect(rollup?.counts).toEqual({ total: 1, blocked: 0, attention: 0, working: 0, ready: 0 });
  });

  it("maps backend-neutral harness activity without knowing terminal backend", () => {
    const doc: Fixture = { nodes: [group("r", 0, 0, 500, 500, "ops"), liveSurface("term", 10, 10, "shell")], edges: [] };
    const activity: WorkSurfaceActivity = { session: "running", harness: "working", source: "native" };
    const [rollup] = deriveRegionRollups({ doc, terminalStatusByNodeId: new Map([["term", activity]]) });
    expect(rollup?.members[0]).toMatchObject({ severity: "working", reasons: ["activity:working"] });
  });

  it("ready: finished turn nobody has read yet, below working, above idle", () => {
    const doc: Fixture = { nodes: [group("r", 0, 0, 500, 500, "ops"), liveSurface("seat", 10, 10, "profile-13")], edges: [] };
    const activity: WorkSurfaceActivity = { session: "running", harness: "idle", ready: true, source: "native" };
    const [rollup] = deriveRegionRollups({ doc, terminalStatusByNodeId: new Map([["seat", activity]]) });
    expect(rollup?.severity).toBe("ready");
    expect(rollup?.members[0]).toMatchObject({ severity: "ready", reasons: ["activity:ready"] });
    expect(rollup?.counts).toEqual({ total: 1, blocked: 0, attention: 0, working: 0, ready: 1 });
  });

  it("ready never outranks a live harness state on the same seat", () => {
    const doc: Fixture = { nodes: [group("r", 0, 0, 500, 500, "ops"), liveSurface("seat", 10, 10, "profile-13")], edges: [] };
    const working: WorkSurfaceActivity = { session: "running", harness: "working", ready: true };
    const [rollup] = deriveRegionRollups({ doc, terminalStatusByNodeId: new Map([["seat", working]]) });
    expect(rollup?.members[0]).toMatchObject({ severity: "working" });
    expect(rollup?.counts.ready).toBe(0);
  });

  it("idle by default: unbound node with no live data", () => {
    const doc: Fixture = {
      nodes: [group("r", 0, 0, 500, 500, "ops"), node("n", 10, 10, "plain note")],
      edges: [],
    };
    const [rollup] = deriveRegionRollups({ doc });
    expect(rollup?.severity).toBe("idle");
    expect(rollup?.members[0]).toMatchObject({ severity: "idle", kind: "note", reasons: [] });
  });

  it("worst tier wins; reasons collect every match in ladder order; counts bucket the worst only", () => {
    const doc: Fixture = {
      nodes: [
        group("r", 0, 0, 500, 500, "ops"),
        agentNode("a", 10, 100, "PROFILE-13", "remote-a:profile-13"),
        node("n", 10, 200, "a note"),
      ],
      edges: [],
    };
    const [rollup] = deriveRegionRollups({
      doc,
      terminalStatusByNodeId: harnessOf(["a", "blocked"]),
      agentActivity: activityOf(["remote-a:profile-13", { sessionLive: true, permissionPending: true }]),
    });
    const member = rollup?.members.find((candidate) => candidate.nodeId === "a");
    expect(member?.severity).toBe("blocked");
    // the blocked harness first, then the lower-ladder live attention
    expect(member?.reasons).toEqual(["activity:blocked", "permission:pending"]);
    expect(rollup?.counts).toEqual({ total: 2, blocked: 1, attention: 0, working: 0, ready: 0 });
  });
});

describe("deriveRegionRollups — absent activity inputs", () => {
  const doc: Fixture = {
    nodes: [
      group("r", 0, 0, 500, 500, "ops"),
      projectNode("p", 10, 10, "prism", "prism"),
      agentNode("a", 10, 100, "PROFILE-13", "remote-a:profile-13"),
      projectNode("q", 10, 200, "quasar", "quasar"),
    ],
    edges: [],
  };

  it("missing activity invents nothing: every member idle", () => {
    const [rollup] = deriveRegionRollups({ doc });
    expect(rollup?.severity).toBe("idle");
    expect(rollup?.counts).toEqual({ total: 3, blocked: 0, attention: 0, working: 0 , ready: 0 });
    expect(rollup?.members.every((member) => member.severity === "idle" && member.reasons.length === 0)).toBe(true);
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
    const doc: Fixture = { nodes: [group("r", 0, 0, 500, 500, "ops")], edges: [] };
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
    const doc: Fixture = { nodes: [node("n", 0, 0, "solo")], edges: [] };
    expect(deriveRegionRollups({ doc })).toEqual([]);
  });

  it("region label is trimmed; blank or absent label falls back to 'unnamed region'", () => {
    const doc: Fixture = {
      nodes: [group("a", 0, 0, 100, 100, "  forge  "), group("b", 200, 0, 100, 100), group("c", 400, 0, 100, 100, "   ")],
      edges: [],
    };
    const rollups = deriveRegionRollups({ doc });
    expect(rollups.map((rollup) => rollup.label)).toEqual(["forge", "unnamed region", "unnamed region"]);
  });

  it("one rollup per group, in document order", () => {
    const doc: Fixture = {
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
    const doc: Fixture = {
      nodes: [
        group("r", 0, 0, 200, 200, "ops"),
        node("inside", 10, 10, "in"),
        node("outside", 500, 500, "out"),
      ],
      edges: [],
    };
    const [rollup] = deriveRegionRollups({ doc });
    expect(rollup?.counts.total).toBe(1);
    expect(rollup?.severity).toBe("idle");
  });

  it("a node whose center leaves the rect is not a member, even if it overlaps", () => {
    const doc: Fixture = {
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
    const doc: Fixture = {
      nodes: [
        group("outer", 0, 0, 500, 500, "outer"),
        group("inner", 20, 20, 200, 200, "inner"),
        node("n", 30, 30, "deep"),
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

  it("member labels follow the titleOf convention: text first line, file basename, link site", () => {
    const doc: Fixture = {
      nodes: [
        group("r", 0, 0, 500, 500, "ops"),
        node("t", 10, 10, "First line\nsecond line"),
        { kind: "file", id: asNodeId("f"), path: "docs/deep/plan.md", ...at(10, 100), z: 0 },
        { kind: "link", id: asNodeId("l"), url: "https://example.com/spec", ...at(10, 200), z: 0 },
      ],
      edges: [],
    };
    const [rollup] = deriveRegionRollups({ doc });
    expect(rollup?.members.map((member) => member.label)).toEqual(["First line", "plan.md", "example.com"]);
  });
});

describe("deriveRegionRollups — region nesting", () => {
  it("three-deep nesting: a blocked seat in the innermost region bubbles into every ancestor rollup", () => {
    const doc: Fixture = {
      nodes: [
        group("outer", 0, 0, 1000, 1000, "outer"),
        group("mid", 50, 50, 500, 500, "mid"),
        group("inner", 100, 100, 200, 200, "inner"),
        liveSurface("hot", 120, 120, "hot"),
      ],
      edges: [],
    };
    const rollups = deriveRegionRollups({ doc, terminalStatusByNodeId: harnessOf(["hot", "blocked"]) });
    expect(rollups.map((rollup) => rollup.regionId)).toEqual(["outer", "mid", "inner"]);
    for (const rollup of rollups) {
      expect(rollup.severity).toBe("blocked");
      expect(rollup.counts).toEqual({ total: 1, blocked: 1, attention: 0, working: 0 , ready: 0 });
      expect(rollup.members.map((member) => member.nodeId)).toEqual(["hot"]);
    }
  });

  it("nesting aggregation: an inner member and an outer-only member both roll up to the outer region", () => {
    const doc: Fixture = {
      nodes: [
        group("outer", 0, 0, 1000, 1000, "outer"),
        group("inner", 100, 100, 300, 300, "inner"),
        liveSurface("deep", 120, 120, "deep"),
        node("shallow", 600, 600, "shallow"),
      ],
      edges: [],
    };
    const rollups = deriveRegionRollups({ doc, terminalStatusByNodeId: harnessOf(["deep", "attention"]) });
    const outer = rollups.find((rollup) => rollup.regionId === "outer");
    const inner = rollups.find((rollup) => rollup.regionId === "inner");
    expect(outer?.severity).toBe("attention");
    expect(outer?.counts).toEqual({ total: 2, blocked: 0, attention: 1, working: 0 , ready: 0 });
    expect(inner?.severity).toBe("attention");
    expect(inner?.members.map((member) => member.nodeId)).toEqual(["deep"]);
  });

  it("overlapping regions: a node inside both counts in both rollups", () => {
    const doc: Fixture = {
      nodes: [
        group("gA", 0, 0, 400, 300, "left"),
        group("gB", 100, 0, 400, 300, "right"),
        liveSurface("both", 150, 50, "shared"),
      ],
      edges: [],
    };
    const rollups = deriveRegionRollups({ doc, terminalStatusByNodeId: harnessOf(["both", "attention"]) });
    for (const rollup of rollups) {
      expect(rollup.severity).toBe("attention");
      expect(rollup.members.map((member) => member.nodeId)).toEqual(["both"]);
    }
    expect(rollups).toHaveLength(2);
  });
});

describe("deriveRegionRollups — member ordering", () => {
  it("sorts by severity, then kind (agents first), then document order", () => {
    const doc: Fixture = {
      nodes: [
        group("r", 0, 0, 800, 800, "ops"),
        node("idle1", 10, 10, "idle one"),
        projectNode("note-project", 10, 100, "prism", "prism"),
        agentNode("working-agent", 10, 200, "PROFILE-13", "remote-a:profile-13"),
        liveSurface("blocked-seat", 10, 300, "on fire"),
        node("idle2", 10, 400, "idle two"),
      ],
      edges: [],
    };
    const [rollup] = deriveRegionRollups({
      doc,
      terminalStatusByNodeId: harnessOf(["working-agent", "working"], ["blocked-seat", "blocked"]),
    });
    // blocked (seat) > working (agent) > idle furniture notes in document order
    expect(rollup?.members.map((member) => member.nodeId)).toEqual([
      "blocked-seat",
      "working-agent",
      "idle1",
      "note-project",
      "idle2",
    ]);
  });
});

describe("deriveRegionRollups — derivation edges", () => {
  it("an agent with a pending permission and a live session is attention, reasons in ladder order", () => {
    const doc: Fixture = {
      nodes: [group("r", 0, 0, 500, 500, "ops"), agentNode("a", 10, 10, "PROFILE-13", "remote-a:profile-13")],
      edges: [],
    };
    const [rollup] = deriveRegionRollups({
      doc,
      agentActivity: activityOf(["remote-a:profile-13", { permissionPending: true, sessionLive: true }]),
    });
    const agent = rollup?.members[0];
    expect(agent?.severity).toBe("attention");
    expect(agent?.reasons).toEqual(["permission:pending"]);
    expect(rollup?.counts).toEqual({ total: 1, blocked: 0, attention: 1, working: 0 , ready: 0 });
  });

  it("a note and an agent stay idle with no activity reported", () => {
    const doc: Fixture = {
      nodes: [
        group("r", 0, 0, 500, 500, "ops"),
        node("o", 10, 10, "forge"),
        agentNode("a", 10, 110, "twin", "prism"),
      ],
      edges: [],
    };
    const [rollup] = deriveRegionRollups({ doc });
    expect(rollup?.members.every((member) => member.severity === "idle" && member.reasons.length === 0)).toBe(
      true,
    );
  });
});

