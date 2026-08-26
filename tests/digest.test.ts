import { describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import type { SnapshotState } from "../src/shared/entities";
import {
  digestCanvas as digestCanvasWithActorRefs,
  type DigestLiveViews,
} from "../src/shared/digest";
import {
  actorRefFixture,
  executionContextForDoc,
} from "./helpers/actor-ref-fixtures";

type DigestFixtureViews = Omit<DigestLiveViews, "resolveActorRef">;

const digestCanvas = (
  name: string,
  doc: CanvasDoc,
  snapshots: SnapshotState,
  live: DigestFixtureViews = {},
): string =>
  digestCanvasWithActorRefs(name, doc, snapshots, {
    ...live,
    resolveActorRef: executionContextForDoc(doc, name).resolveActorRef,
  });

const doc: CanvasDoc = {
  nodes: [
    { id: "grp1", type: "group", label: "team", x: 0, y: 0, width: 400, height: 200 },
    {
      id: "m1",
      type: "text",
      text: "Foo\nFoo does things",
      x: 20,
      y: 20,
      width: 100,
      height: 50,
      ether: {
        entity: { kind: "project", name: "foo" },
      },
    },
    {
      id: "m2",
      type: "text",
      text: "Bar\nBar orbit",
      x: 200,
      y: 20,
      width: 100,
      height: 50,
      ether: { entity: { kind: "orbit" }, flags: ["blocker"] },
    },
    {
      id: "m3",
      type: "text",
      text: "Baz\nOutside group",
      x: 20,
      y: 300,
      width: 100,
      height: 50,
      // Actor seat (the one actor kind) so task criteria can place it in the
      // blocked set. A raw `terminal` is geography and would not count as one.
      ether: {
        entity: { kind: "agent" },
      },
    },
    {
      id: "t1",
      type: "text",
      text: "Ops",
      x: 250,
      y: 300,
      width: 100,
      height: 50,
      ether: {
        entity: { kind: "task" },
        tasks: {
          items: [
            {
              id: "i1",
              state: "input-required",
              claimedBy: actorRefFixture("m3", "fixture").seatId,
              history: [
                {
                  messageId: "m1",
                  role: "user",
                  parts: [{ kind: "text", text: "ship" }],
                  taskId: "i1",
                },
              ],
            },
          ],
        },
      },
    },
  ],
  edges: [
    { id: "e1", fromNode: "m1", toNode: "m2" },
    { id: "e2", fromNode: "t1", toNode: "m3", ether: { verb: "works" } },
    { id: "e3", fromNode: "m3", toNode: "m1", label: "refs" },
    { id: "e4", fromNode: "m1", toNode: "m3" },
  ],
};

const snapshots: SnapshotState = {
  bundles: [
    {
      source: "hermes",
      fetchedAt: "2026-01-01T00:00:00.000Z",
      ok: true,
      entities: [
        {
          source: "hermes",
          key: "host:agent",
          kind: "agent",
          stats: { b: "x", a: 1 },
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    },
  ],
};

const expected = `canvas :: fixture
nodes :: 5
edges :: 4

regions
team :: Foo, Bar

region rollups
team :: idle - 2 members

factory physics
roles :: actors=1 sinks=1 schedulers=0 geography=3
edges :: 4

design
seats
  Baz :: empty
empty seats
  Baz :: empty
topology :: edges=4

entities
Foo :: project
Bar :: orbit
Baz :: agent
Ops :: task
  tasks: 0/1 settled

edges
Foo --relates--> Bar
Ops --blocks(1 need input - ship)--> Baz
Baz --refs--> Foo
Foo --relates--> Baz

blockers
Bar
blocked closure :: 1 nodes
Baz - 1 need input - ship

impact
1 task - stops 2
  seed: Ops
  settle: ship

seeds
Foo
Bar
Ops

sources
hermes :: ok (1 entities)
`;

describe("digestCanvas", () => {
  it("is deterministic across repeated calls", () => {
    const first = digestCanvas("fixture", doc, snapshots);
    const second = digestCanvas("fixture", doc, snapshots);
    expect(first).toBe(second);
  });

  it("matches the exact expected projection for the fixture", () => {
    expect(digestCanvas("fixture", doc, snapshots)).toBe(expected);
  });
});

// Formatting pins for the region rollups section: singular member counts, an
// empty region, a multi-bucket join, and attention/working member lines. The
// empty group also pins the "unnamed region" fallback in BOTH sections.
const doc2: CanvasDoc = {
  nodes: [
    { id: "g-ops", type: "group", label: "ops", x: 0, y: 0, width: 500, height: 350 },
    { id: "b1", type: "text", text: "B1", x: 10, y: 10, width: 100, height: 40, ether: { flags: ["blocker"] } },
    { id: "a1", type: "text", text: "A1", x: 120, y: 10, width: 100, height: 40, ether: { flags: ["attention"] } },
    { id: "a2", type: "text", text: "A2", x: 230, y: 10, width: 100, height: 40, ether: { flags: ["attention"] } },
    {
      id: "w1",
      type: "text",
      text: "W1",
      x: 10,
      y: 60,
      width: 100,
      height: 40,
      ether: { entity: { kind: "project", name: "prism" } },
    },
    { id: "g-solo", type: "group", label: "  solo  ", x: 0, y: 400, width: 300, height: 300 },
    { id: "solo1", type: "text", text: "Lone", x: 10, y: 410, width: 100, height: 40 },
    { id: "g-empty", type: "group", x: 600, y: 400, width: 200, height: 200 },
  ],
  edges: [],
};

// Array-of-lines (not a template literal) so the trailing separator space on
// the memberless regions line stays visible.
const expected2 = [
  "canvas :: fixture2",
  "nodes :: 8",
  "edges :: 0",
  "",
  "regions",
  "ops :: B1, A1, A2, W1",
  "solo :: Lone",
  "unnamed region :: ",
  "",
  "region rollups",
  "ops :: attention - 4 members (2 attention)",
  "  A1 :: attention - flag:attention",
  "  A2 :: attention - flag:attention",
  "solo :: idle - 1 member",
  "unnamed region :: idle - 0 members",
  "",
  "factory physics",
  "roles :: actors=0 sinks=0 schedulers=0 geography=8",
  "edges :: 0",
  "",
  "entities",
  "W1 :: project",
  "",
  "blockers",
  "B1",
  "blocked closure :: 0 nodes",
  "",
  "seeds",
  "W1",
  "",
].join("\n");

describe("digestCanvas — region rollups formatting", () => {
  it("pins singular counts, empty region, multi-bucket join, and member lines", () => {
    expect(digestCanvas("fixture2", doc2, { bundles: [] })).toBe(expected2);
  });
});

// Factory physics: roles derived from kind (roleOf/resolveSpec), never
// authorial ether.role; capabilities are criteria vs soft edge counts only.
// Headless — no PIDs / process-bind / occupancy in the projection.
const physicsDoc: CanvasDoc = {
  nodes: [
    { id: "g1", type: "group", label: "bay", x: 0, y: 0, width: 400, height: 300 },
    {
      id: "agent1",
      type: "text",
      text: "hermes",
      x: 10,
      y: 10,
      width: 100,
      height: 40,
      ether: { entity: { kind: "agent" } },
    },
    {
      id: "term1",
      type: "text",
      text: "tty",
      x: 120,
      y: 10,
      width: 100,
      height: 40,
      ether: { entity: { kind: "terminal" } },
    },
    {
      id: "task1",
      type: "text",
      text: "inbox",
      x: 10,
      y: 60,
      width: 100,
      height: 40,
      ether: { entity: { kind: "task" } },
    },
    {
      id: "page1",
      type: "text",
      text: "docs",
      x: 120,
      y: 60,
      width: 100,
      height: 40,
      ether: { entity: { kind: "page" } },
    },
    {
      id: "watch1",
      type: "text",
      text: "pulse",
      x: 230,
      y: 10,
      width: 100,
      height: 40,
      ether: { entity: { kind: "watcher" } },
    },
    {
      id: "timer1",
      type: "text",
      text: "tick",
      x: 230,
      y: 60,
      width: 100,
      height: 40,
      ether: { entity: { kind: "timer" } },
    },
    { id: "note1", type: "text", text: "sticky", x: 10, y: 120, width: 80, height: 30 },
  ],
  edges: [
    { id: "e-soft", fromNode: "agent1", toNode: "note1" },
    {
      id: "e-crit",
      fromNode: "agent1",
      toNode: "task1",
      ether: { verb: "contributes" },
    },
    { id: "e-crit2", fromNode: "term1", toNode: "page1" },
  ],
};

describe("digestCanvas — factory physics", () => {
  it("projects role counts via roleOf/resolveSpec and edge totals (no soft modes)", () => {
    const out = digestCanvas("physics", physicsDoc, { bundles: [] });
    expect(out).toContain("factory physics");
    // One actor kind: the `tty` node is a raw terminal, hence geography.
    expect(out).toMatch(/roles :: actors=1 sinks=\d+ schedulers=2 geography=\d+/);
    expect(out).toContain("edges :: 3");
    expect(out).not.toContain("soft=");
    expect(out).not.toContain("criteria=");
    // Never leaks live occupancy / process-bind identity.
    expect(out).not.toMatch(/\bpid\b/i);
    expect(out).not.toContain("process-bind");
    expect(out).not.toContain("occupancy");
  });

  it("always emits factory physics even on an empty board", () => {
    const out = digestCanvas("empty", { nodes: [], edges: [] }, { bundles: [] });
    expect(out).toBe(
      [
        "canvas :: empty",
        "nodes :: 0",
        "edges :: 0",
        "",
        "factory physics",
        "roles :: actors=0 sinks=0 schedulers=0 geography=0",
        "edges :: 0",
        "",
      ].join("\n"),
    );
  });
});

// I13: empty seats live under design only.
describe("digestCanvas — design (I13)", () => {
  const trustDoc: CanvasDoc = {
    nodes: [
      {
        id: "agent1",
        type: "text",
        text: "worker",
        x: 0,
        y: 0,
        width: 100,
        height: 40,
        ether: { entity: { kind: "agent", name: "local:worker" } },
      },
      {
        id: "sink1",
        type: "text",
        text: "artifacts",
        x: 200,
        y: 0,
        width: 100,
        height: 40,
        ether: { entity: { kind: "artifacts" }, artifacts: { items: [] } },
      },
      {
        id: "down1",
        type: "text",
        text: "ship",
        x: 400,
        y: 0,
        width: 100,
        height: 40,
        ether: { entity: { kind: "project", name: "ship" } },
      },
    ],
    edges: [
      {
        id: "e-soft",
        fromNode: "sink1",
        toNode: "down1",
      },
    ],
  };

  it("empty-seat fixture appears under design", () => {
    const out = digestCanvas("trust", trustDoc, { bundles: [] }, {
      occupancy: new Map([["agent1", "empty"]]),
    });
    expect(out).toContain("design");
    expect(out).toContain("empty seats");
    expect(out).toMatch(/empty seats\n {2}worker :: empty/);
  });
});

describe("digestCanvas — pad block", () => {
  it("emits one pad glance line under entities", () => {
    const padDoc: CanvasDoc = {
      nodes: [
        {
          id: "pad-1",
          type: "text",
          text: "sketch",
          x: 0,
          y: 0,
          width: 240,
          height: 120,
          ether: {
            entity: { kind: "pad" },
            pad: { revision: 3, shapeCount: 4, unreadPinCount: 1 },
          },
        },
      ],
      edges: [],
    };
    const out = digestCanvas("pad-fixture", padDoc, { bundles: [] });
    expect(out).toContain("sketch :: pad");
    expect(out).toContain("  pad: revision=3 shapes=4 unread=1");
  });
});
