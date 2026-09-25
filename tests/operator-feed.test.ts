import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import type { AgentSignal } from "../src/shared/agent-signals";
import type { CanvasDoc } from "../src/shared/canvas";
import type { ThreadHealthReading } from "../src/shared/thread-health";
import {
  buildOperatorFeed,
  feedRegionFor,
  feedSeatsFromDoc,
  OperatorFeed,
  type FeedSeatInput,
} from "../src/shared/operator-feed";

const NOW = 10 * 60_000;

const agent = (id: string, x: number, y: number): CanvasDoc["nodes"][number] => ({
  id,
  type: "text",
  text: id.toUpperCase(),
  x,
  y,
  width: 100,
  height: 60,
  ether: { entity: { kind: "agent", name: `local:${id}` }, terminal: { harness: "claude" } } as never,
});

const doc: CanvasDoc = {
  nodes: [
    { id: "outer", type: "group", label: "Build", x: 0, y: 0, width: 1000, height: 1000 },
    { id: "inner", type: "group", label: "Docs", x: 500, y: 500, width: 400, height: 400 },
    agent("a", 10, 10),
    agent("b", 600, 600),
    agent("c", 2000, 2000),
  ],
  edges: [],
};

const signal = (over: Partial<AgentSignal> & Pick<AgentSignal, "signalId" | "nodeId">): AgentSignal => ({
  canvasName: "main",
  kind: "feedback",
  text: "Review this",
  createdAt: 1_000,
  state: "open",
  ...over,
});

const reading = (value: ThreadHealthReading["value"], observedAt: number): ThreadHealthReading => ({
  bindingId: "bind",
  value,
  confidence: 0.8,
  observedAt,
  provenance: { source: "jev", assessmentId: "as1", questionId: "q", packVersion: "1" },
  signals: [],
});

const seats = (extra?: Partial<Record<string, Partial<FeedSeatInput>>>): ReadonlyArray<FeedSeatInput> =>
  feedSeatsFromDoc(doc, { nameOf: (node) => (node.type === "text" ? node.text : node.id) }).map((entry) => ({
    ...entry,
    ...(extra?.[entry.seat.nodeId] ?? {}),
  }));

describe("feed regions", () => {
  it("uses the innermost containing region with the outer-to-inner path", () => {
    expect(feedRegionFor(doc, "b")).toEqual({ regionId: "inner", label: "Docs", path: ["Build", "Docs"] });
    expect(feedRegionFor(doc, "a")).toEqual({ regionId: "outer", label: "Build", path: ["Build"] });
    expect(feedRegionFor(doc, "c").regionId).toBeNull();
  });

  it("resolves only agent seats with identity and harness", () => {
    const resolved = seats();
    expect(resolved.map((entry) => entry.seat)).toEqual([
      { nodeId: "a", name: "A", portraitIdentity: "a", harness: "claude" },
      { nodeId: "b", name: "B", portraitIdentity: "b", harness: "claude" },
      { nodeId: "c", name: "C", portraitIdentity: "c", harness: "claude" },
    ]);
  });
});

describe("buildOperatorFeed", () => {
  it("lists open signals and proven attention, grouped by region, urgent sections first", () => {
    const feed = buildOperatorFeed({
      canvasName: "main",
      nowMs: NOW,
      seats: seats({ c: { attention: { reason: "permission prompt", at: 5_000 } } }),
      signals: [
        signal({ signalId: "s1", nodeId: "a", kind: "feedback", createdAt: 2_000 }),
        signal({ signalId: "s2", nodeId: "a", kind: "escalate", createdAt: 4_000, detail: "## why" }),
        signal({ signalId: "s3", nodeId: "b", kind: "blocked", createdAt: 3_000 }),
        signal({ signalId: "closed", nodeId: "b", kind: "blocked", state: "answered" }),
        signal({ signalId: "other", nodeId: "a", canvasName: "elsewhere", kind: "blocked" }),
      ],
    });
    expect(feed.count).toBe(4);
    expect(feed.sections.map((s) => s.region.label)).toEqual(["Docs", "open field", "Build"]);
    expect(feed.sections[0]?.items.map((i) => i.kind)).toEqual(["blocked"]);
    expect(feed.sections[1]?.items[0]).toMatchObject({ kind: "attention", text: "wants your input", since: 5_000 });
    expect(feed.sections[2]?.items.map((i) => i.itemId)).toEqual(["signal:s2", "signal:s1"]);
    expect(feed.sections[2]?.items[0]).toMatchObject({ detail: "## why", signalId: "s2", ageMs: NOW - 4_000 });
  });

  it("orders same-urgency items oldest first", () => {
    const feed = buildOperatorFeed({
      canvasName: "main",
      nowMs: NOW,
      seats: seats(),
      signals: [
        signal({ signalId: "new", nodeId: "a", createdAt: 9_000 }),
        signal({ signalId: "old", nodeId: "a", createdAt: 1_000 }),
      ],
    });
    expect(feed.sections[0]?.items.map((i) => i.signalId)).toEqual(["old", "new"]);
  });

  it("adds a fresh AI waiting reading only for a seat nothing else lists", () => {
    const feed = buildOperatorFeed({
      canvasName: "main",
      nowMs: NOW,
      seats: seats({
        a: { health: reading("waiting_on_operator", NOW - 60_000) },
        b: { health: reading("waiting_on_operator", NOW - 60_000) },
        c: { health: reading("waiting_on_operator", NOW - 6 * 60_000) },
      }),
      signals: [signal({ signalId: "s", nodeId: "b" })],
    });
    const kinds = feed.sections.flatMap((s) => s.items.map((i) => `${i.seat.nodeId}:${i.kind}`));
    expect(kinds.sort()).toEqual(["a:health", "b:feedback"]);
    const bItem = feed.sections.flatMap((s) => s.items).find((i) => i.seat.nodeId === "b");
    expect(bItem?.health).toMatchObject({ value: "waiting_on_operator", tone: "waiting", stale: false });
  });

  it("lets the producer's freshness judgment override the TTL", () => {
    const old = reading("waiting_on_operator", NOW - 9 * 60_000);
    const feed = buildOperatorFeed({
      canvasName: "main",
      nowMs: NOW,
      seats: seats({ a: { health: old, healthFresh: true }, b: { health: reading("waiting_on_operator", NOW), healthFresh: false } }),
      signals: [],
    });
    expect(feed.sections.flatMap((s) => s.items.map((i) => i.seat.nodeId))).toEqual(["a"]);
  });

  it("never lets health change a declared item's kind or urgency", () => {
    const feed = buildOperatorFeed({
      canvasName: "main",
      nowMs: NOW,
      seats: seats({ a: { health: reading("stuck", NOW) } }),
      signals: [signal({ signalId: "s", nodeId: "a", kind: "feedback" })],
    });
    expect(feed.sections[0]?.items[0]).toMatchObject({ kind: "feedback", urgency: 2, health: { value: "stuck", tone: "trouble" } });
  });

  it("keeps a signal whose seat left the canvas, in the open field", () => {
    const feed = buildOperatorFeed({ canvasName: "main", nowMs: NOW, seats: [], signals: [signal({ signalId: "s", nodeId: "gone" })] });
    expect(feed.sections[0]?.items[0]?.seat.name).toBe("removed seat");
    expect(feed.sections[0]?.region.regionId).toBeNull();
  });

  it("is an empty, valid feed when nobody needs the operator", () => {
    const feed = buildOperatorFeed({ canvasName: "main", nowMs: NOW, seats: seats(), signals: [] });
    expect(feed).toEqual({ version: 1, canvasName: "main", generatedAt: NOW, count: 0, sections: [] });
  });

  it("round-trips through JSON and decodes against its schema", () => {
    const feed = buildOperatorFeed({
      canvasName: "main",
      nowMs: NOW,
      seats: seats({ a: { health: reading("going_well", NOW) } }),
      signals: [signal({ signalId: "s", nodeId: "a", detail: "more" })],
    });
    const wire: unknown = JSON.parse(JSON.stringify(feed));
    expect(Schema.decodeUnknownSync(OperatorFeed)(wire)).toEqual(feed);
  });
});
