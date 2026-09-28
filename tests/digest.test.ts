import { describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import type { SnapshotState } from "../src/shared/entities";
import {
  digestCanvas as digestCanvasWithActorRefs,
  type DigestLiveViews,
} from "../src/shared/digest";
import { executionContextForDoc } from "./helpers/actor-ref-fixtures";

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
      ether: { entity: { kind: "orbit" } },
    },
    {
      id: "m3",
      type: "text",
      text: "Baz\nOutside group",
      x: 20,
      y: 300,
      width: 100,
      height: 50,
      ether: {
        entity: { kind: "agent" },
      },
    },
  ],
  edges: [
    { id: "e1", fromNode: "m1", toNode: "m2" },
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
nodes :: 4
edges :: 3

regions
team :: Foo, Bar

region rollups
team :: idle - 2 members

factory physics
roles :: actors=1 sinks=0 schedulers=0 geography=3
edges :: 3

design
seats
  Baz :: empty
empty seats
  Baz :: empty
topology :: edges=3

entities
Foo :: project
Bar :: orbit
Baz :: agent

edges
Foo --relates--> Bar
Baz --refs--> Foo
Foo --relates--> Baz

seeds
Foo
Bar

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

// Formatting pins for the region rollups section: singular member counts and
// an empty region. The empty group also pins the "unnamed region" fallback in
// BOTH sections.
const doc2: CanvasDoc = {
  nodes: [
    { id: "g-ops", type: "group", label: "ops", x: 0, y: 0, width: 500, height: 350 },
    { id: "b1", type: "text", text: "B1", x: 10, y: 10, width: 100, height: 40 },
    { id: "a1", type: "text", text: "A1", x: 120, y: 10, width: 100, height: 40 },
    { id: "a2", type: "text", text: "A2", x: 230, y: 10, width: 100, height: 40 },
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
  "ops :: idle - 4 members",
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
  "seeds",
  "W1",
  "",
].join("\n");

describe("digestCanvas — region rollups formatting", () => {
  it("pins singular counts, empty region, and the unnamed region fallback", () => {
    expect(digestCanvas("fixture2", doc2, { bundles: [] })).toBe(expected2);
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
        id: "page1",
        type: "text",
        text: "docs",
        x: 200,
        y: 0,
        width: 100,
        height: 40,
        ether: { entity: { kind: "page" } },
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
        fromNode: "page1",
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
