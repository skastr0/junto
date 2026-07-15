import { describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import type { SnapshotState } from "../src/shared/entities";
import { digestCanvas } from "../src/shared/digest";

// Small fixture exercising every digest section: a region, a bound entity
// (one live binding, one stale binding), a seed (unbound entity + blocker
// flag), a plain node with no ether at all, edges of every label shape
// (ether.kind, edge.label, and the bare "relates" fallback), and a
// tower/quasar/booth source mix.
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
        entity: { kind: "project" },
        bindings: [
          { source: "tower", ref: { type: "project", key: "foo" } },
          { source: "quasar", ref: { type: "project", key: "bar" } },
        ],
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
        entity: { kind: "project" },
        bindings: [{ source: "tower", ref: { type: "project", key: "baz" } }],
      },
    },
  ],
  edges: [
    { id: "e1", fromNode: "m1", toNode: "m2", ether: { kind: "depends" } },
    { id: "e2", fromNode: "m2", toNode: "m3", ether: { kind: "blocks" } },
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
nodes :: 4
edges :: 4

regions
team :: Foo, Bar

entities
Foo :: project
  tower: a=1 b=x
  quasar: stale
Bar :: orbit
Baz :: project
  tower: stale

edges
Foo --depends--> Bar
Bar --blocks--> Baz
Baz --refs--> Foo
Foo --relates--> Baz

blockers
Bar
blocked closure :: 1 nodes
Baz · pinned blocks

seeds
Bar

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
