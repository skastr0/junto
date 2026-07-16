import { describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import type { SnapshotState } from "../src/shared/entities";
import { digestCanvas } from "../src/shared/digest";

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
      ether: {
        entity: { kind: "project", name: "baz" },
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
        tasks: { items: [{ id: "i1", text: "ship", done: false }] },
      },
    },
  ],
  edges: [
    { id: "e1", fromNode: "m1", toNode: "m2" },
    { id: "e2", fromNode: "t1", toNode: "m3", ether: { criteria: { mode: "tasks" } } },
    { id: "e3", fromNode: "m3", toNode: "m1", label: "refs" },
    { id: "e4", fromNode: "m1", toNode: "m3" },
  ],
};

const snapshots: SnapshotState = {
  bundles: [
    {
      source: "tower",
      fetchedAt: "2026-01-01T00:00:00.000Z",
      ok: true,
      entities: [
        {
          source: "tower",
          key: "foo",
          kind: "project",
          stats: { b: "x", a: 1 },
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    },
    {
      source: "quasar",
      fetchedAt: "2026-01-01T00:00:00.000Z",
      ok: false,
      error: "timeout",
      entities: [],
    },
    {
      source: "booth",
      fetchedAt: "2026-01-01T00:00:00.000Z",
      ok: true,
      entities: [],
    },
  ],
};

const expected = `canvas :: fixture
nodes :: 5
edges :: 4

regions
team :: Foo, Bar

entities
Foo :: project
  tower: a=1 b=x
Bar :: orbit
Baz :: project
Ops :: task
  tasks: 0/1 done

edges
Foo --relates--> Bar
Ops --blocks(0/1 tasks done · open: ship)--> Baz
Baz --refs--> Foo
Foo --relates--> Baz

blockers
Bar
blocked closure :: 1 nodes
Baz · 0/1 tasks done · open: ship

seeds
Bar
Baz
Ops

sources
tower :: ok (1 entities)
quasar :: down (timeout)
booth :: ok (0 entities)
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
