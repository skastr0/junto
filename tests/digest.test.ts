import { describe, expect, it } from "vitest";
import type { Canvas } from "../src/shared/model";
import type { SnapshotState } from "../src/shared/entities";
import {
  digestCanvas as digestCanvasWithActorRefs,
  type DigestLiveViews,
} from "../src/shared/digest";
import { executionContextForCanvas } from "./helpers/actor-ref-fixtures";
import { canvasOf, note, page, region, seat } from "./support/model-nodes";

type DigestFixtureViews = Omit<DigestLiveViews, "resolveActorRef" | "itemsOf">;

const digestCanvas = (
  name: string,
  canvas: Canvas,
  snapshots: SnapshotState,
  live: DigestFixtureViews = {},
): string =>
  digestCanvasWithActorRefs(canvas, snapshots, {
    ...live,
    itemsOf: () => [],
    resolveActorRef: executionContextForCanvas(canvas, name).resolveActorRef,
  });

const doc = canvasOf(
  [
    region("grp1", { x: 0, y: 0, width: 400, height: 200 }, { label: "team" as never }),
    note("m1", "Foo\nFoo does things", { x: 20, y: 20, width: 100, height: 50 }),
    note("m2", "Bar\nBar orbit", { x: 200, y: 20, width: 100, height: 50 }),
    seat("m3", {
      label: "Baz" as never,
      agentKey: "local:worker" as never,
      bindingId: "m3" as never,
      harness: "codex",
      x: 20,
      y: 300,
      width: 100,
      height: 50,
    }),
  ],
  [],
  "fixture",
);

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
edges :: 0

regions
team :: Foo, Bar

region rollups
team :: idle - 2 members

canvas physics
roles :: actors=1 sinks=0 schedulers=0 geography=3
edges :: 0

design
seats
  Baz :: empty
empty seats
  Baz :: empty

entities
team :: region
Foo :: note
Bar :: note
Baz :: agent
  hermes: stale

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
const doc2 = canvasOf(
  [
    region("g-ops", { x: 0, y: 0, width: 500, height: 350 }, { label: "ops" as never }),
    note("b1", "B1", { x: 10, y: 10, width: 100, height: 40 }),
    note("a1", "A1", { x: 120, y: 10, width: 100, height: 40 }),
    note("a2", "A2", { x: 230, y: 10, width: 100, height: 40 }),
    note("w1", "W1", { x: 10, y: 60, width: 100, height: 40 }),
    region("g-solo", { x: 0, y: 400, width: 300, height: 300 }, { label: "  solo  " as never }),
    note("solo1", "Lone", { x: 10, y: 410, width: 100, height: 40 }),
    region("g-empty", { x: 600, y: 400, width: 200, height: 200 }),
  ],
  [],
  "fixture2",
);

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
  "canvas physics",
  "roles :: actors=0 sinks=0 schedulers=0 geography=8",
  "edges :: 0",
  "",
  "entities",
  "ops :: region",
  "B1 :: note",
  "A1 :: note",
  "A2 :: note",
  "W1 :: note",
  "solo :: region",
  "Lone :: note",
  "unnamed region (g-empty) :: region",
  "",
].join("\n");

describe("digestCanvas — region rollups formatting", () => {
  it("pins singular counts, empty region, and the unnamed region fallback", () => {
    expect(digestCanvas("fixture2", doc2, { bundles: [] })).toBe(expected2);
  });
});

// I13: empty seats live under design only.
describe("digestCanvas — design (I13)", () => {
  const trustDoc = canvasOf(
    [
      seat("agent1", { label: "worker" as never, agentKey: "local:worker" as never, bindingId: "agent1" as never, harness: "codex", x: 0, y: 0, width: 100, height: 40 }),
      page("page1", { url: "https://docs.example.test", x: 200, y: 0, width: 100, height: 40 }),
      note("down1", "ship", { x: 400, y: 0, width: 100, height: 40 }),
    ],
    [],
    "trust",
  );

  it("empty-seat fixture appears under design", () => {
    const out = digestCanvas("trust", trustDoc, { bundles: [] }, {
      occupancy: new Map([["agent1", "empty"]]),
    });
    expect(out).toContain("design");
    expect(out).toContain("empty seats");
    expect(out).toMatch(/empty seats\n {2}worker :: empty/);
  });
});

it("reads explicit Work waits and authored verbs from model rows", async () => {
  const { Schema } = await import("effect");
  const { Node, asCanvasName, asWireId } = await import("../src/shared/model");
  const { ActorSeatId } = await import("../src/shared/actor-seat");
  const seatId = Schema.decodeUnknownSync(ActorSeatId)(`seat_${"b".repeat(64)}`);
  const worker = Schema.decodeUnknownSync(Node)({ kind: "agent", id: "worker", label: "Worker", agentKey: "local:worker", host: "local", bindingId: "worker", harness: "codex", overseer: false, onRemove: "detach", x: 0, y: 0, width: 100, height: 50, z: 0 });
  const queue = Schema.decodeUnknownSync(Node)({ kind: "task", id: "queue", name: "Queue", x: 200, y: 0, width: 100, height: 50, z: 1 });
  const id = asWireId("contribution");
  const canvas = { name: asCanvasName("factory"), seq: 7, nodes: new Map([worker, queue].map((node) => [node.id, node])), wires: new Map([[id, { id, from: worker.id, to: queue.id, verb: "contributes" as const }]]) };
  const live: DigestLiveViews = { resolveActorRef: (ref) => ref.nodeId === worker.id ? { canvasName: "factory", nodeId: worker.id, seatId } : undefined, itemsOf: (nodeId) => nodeId === queue.id ? [{ id: "waiting", state: "input-required", claimedBy: seatId, history: [] }] : [] };
  const text = digestCanvasWithActorRefs(canvas, { bundles: [] }, live);
  expect(text).toContain("edges :: 1");
  expect(text).toContain("Queue :: task");
  expect(text).toContain("blockers");
  expect(text).toContain("Worker --blocks(");
  const idle = digestCanvasWithActorRefs(canvas, { bundles: [] }, { ...live, itemsOf: () => [] });
  expect(idle).toContain("Worker --contributes--> Queue");
  expect(idle).not.toContain("blockers");
});
