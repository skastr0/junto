import { describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import type { SnapshotState } from "../src/shared/entities";
import type { GlyphView } from "../src/shared/execution-graph";
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
        tasks: {
          items: [
            {
              id: "i1",
              state: "submitted",
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

region rollups
team :: blocked · 2 members (1 blocked)
  Bar :: blocked · flag:blocker

entities
Foo :: project
  tower: a=1 b=x
Bar :: orbit
Baz :: project
Ops :: task
  tasks: 0/1 settled

edges
Foo --relates--> Bar
Ops --blocks(0/1 tasks settled · open: ship)--> Baz
Baz --refs--> Foo
Foo --relates--> Baz

blockers
Bar
blocked closure :: 1 nodes
Baz · 0/1 tasks settled · open: ship

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

const glyphs2: GlyphView = new Map([
  ["prism", [{ glyphId: "g-1", orbit: "forge", title: "work", state: "building" }]],
]);

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
  "ops :: blocked · 4 members (1 blocked, 2 attention, 1 working)",
  "  B1 :: blocked · flag:blocker",
  "  A1 :: attention · flag:attention",
  "  A2 :: attention · flag:attention",
  "  W1 :: working · glyph:wip:building",
  "solo :: idle · 1 member",
  "unnamed region :: idle · 0 members",
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
    expect(digestCanvas("fixture2", doc2, { bundles: [] }, glyphs2)).toBe(expected2);
  });
});

