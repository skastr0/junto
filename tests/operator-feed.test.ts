import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import type { AgentSignal } from "../src/shared/agent-signals";
import { canvasOf, region, seat } from "./support/model-nodes";
import { BindingId } from "../src/shared/terminal-session-domain";
import { initialSnapshot, reduceSeatSignals, type SeatSignal, type SignalSource } from "../src/shared/harness-domain";
import type { ThreadHealthReading } from "../src/shared/thread-health";
import {
  buildOperatorFeed,
  feedRegionForCanvas,
  feedKindCount,
  feedSeatsFromCanvas,
  feedStopOf,
  feedItemRank,
  needsOperatorCount,
  OperatorFeed,
  type FeedItemKind,
  type FeedSeatInput,
} from "../src/shared/operator-feed";

const NOW = 10 * 60_000;

const agent = (id: string, x: number, y: number) => seat(id, { label: id.toUpperCase(), x, y, width: 100, height: 60 });
const canvas = canvasOf([
  region("outer", { x: 0, y: 0, width: 1000, height: 1000 }, { label: "Build" }),
  region("inner", { x: 500, y: 500, width: 400, height: 400 }, { label: "Docs", color: "5" }),
  agent("a", 10, 10), agent("b", 600, 600), agent("c", 2000, 2000),
]);

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

const snapshotAfter = (...steps: ReadonlyArray<readonly [SignalSource, SeatSignal]>) =>
  reduceSeatSignals(
    initialSnapshot(Schema.decodeSync(BindingId)("bind"), 0),
    steps.map(([source, signal], index) => ({
      seat: Schema.decodeSync(BindingId)("bind"),
      at: 3_000 + index,
      source,
      fidelity: source === "screen" ? ("screen" as const) : ("native" as const),
      signal,
    })),
  );

const seats = (extra?: Partial<Record<string, Partial<FeedSeatInput>>>): ReadonlyArray<FeedSeatInput> =>
  feedSeatsFromCanvas(canvas).map((entry) => ({
    ...entry,
    ...(extra?.[entry.seat.nodeId] ?? {}),
  }));

describe("feed regions", () => {
  it("uses the innermost containing region with the outer-to-inner path and its colour", () => {
    expect(feedRegionForCanvas(canvas, "b")).toEqual({ regionId: "inner", label: "Docs", path: ["Build", "Docs"], color: "5" });
    expect(feedRegionForCanvas(canvas, "a")).toEqual({ regionId: "outer", label: "Build", path: ["Build"] });
    expect(feedRegionForCanvas(canvas, "c").regionId).toBeNull();
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

  it("carries a signal's suggested replies onto its feed item", () => {
    const feed = buildOperatorFeed({
      canvasName: "main",
      nowMs: NOW,
      seats: seats(),
      signals: [
        signal({ signalId: "s1", nodeId: "a", kind: "blocked", suggestions: ["Use sqlite", "Keep JSON"] }),
        signal({ signalId: "s2", nodeId: "a", kind: "escalate" }),
      ],
    });
    const blocked = feed.sections.flatMap((s) => s.items).find((i) => i.signalId === "s1");
    const plain = feed.sections.flatMap((s) => s.items).find((i) => i.signalId === "s2");
    expect(blocked?.suggestions).toEqual(["Use sqlite", "Keep JSON"]);
    expect(plain).not.toHaveProperty("suggestions");
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

  it("lists held mail as one item per seat that says how many, how long and why, with nothing to answer", () => {
    const feed = buildOperatorFeed({
      canvasName: "main",
      nowMs: 3 * 3_600_000,
      seats: seats({
        a: { mailWait: { count: 3, heldSince: 3 * 3_600_000 - 2 * 3_600_000 - 59 * 60_000, hold: "draft" } },
        b: { mailWait: { count: 1, heldSince: 3 * 3_600_000 - 45 * 60_000, hold: "dialog" } },
        c: { mailWait: { count: 0, heldSince: 0, hold: "unreadable" } },
      }),
      signals: [],
    });
    const items = feed.sections.flatMap((section) => section.items);
    expect(items.map((item) => item.itemId).sort()).toEqual(["mail-waiting:a", "mail-waiting:b"]);
    expect(items.find((item) => item.seat.nodeId === "a")).toMatchObject({
      kind: "attention",
      text: "3 mails have waited 2 h: the box reads as your draft",
      since: 3 * 3_600_000 - 2 * 3_600_000 - 59 * 60_000,
    });
    expect(items.find((item) => item.seat.nodeId === "b")?.text).toBe("1 mail has waited 45 min: the seat is showing a dialog");
    expect(items.every((item) => item.signalId === undefined)).toBe(true);
    expect(feed.count).toBe(2);
  });

  it("reads held mail off the seat map, and a count of none lists nothing", () => {
    const resolved = feedSeatsFromCanvas(canvas, {
      mailWaitByNodeId: new Map([
        ["a", { count: 2, heldSince: 1_000, hold: "unreadable" as const }],
        ["b", { count: 0, heldSince: 1_000, hold: "draft" as const }],
      ]),
    });
    expect(resolved.find((entry) => entry.seat.nodeId === "a")?.mailWait).toEqual({ count: 2, heldSince: 1_000, hold: "unreadable" });
    expect(resolved.find((entry) => entry.seat.nodeId === "b")).not.toHaveProperty("mailWait");
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
    expect(feed.sections[0]?.items[0]).toMatchObject({ kind: "feedback", urgency: feedItemRank("feedback"), health: { value: "stuck", tone: "trouble" } });
  });

  it("keeps a signal whose seat left the canvas, in the open field", () => {
    const feed = buildOperatorFeed({ canvasName: "main", nowMs: NOW, seats: [], signals: [signal({ signalId: "s", nodeId: "gone" })] });
    expect(feed.sections[0]?.items[0]?.seat.name).toBe("removed seat");
    expect(feed.sections[0]?.region.regionId).toBeNull();
  });

  it("is an empty, valid feed when nobody needs the operator", () => {
    const feed = buildOperatorFeed({ canvasName: "main", nowMs: NOW, seats: seats(), signals: [] });
    expect(feed).toEqual({ version: 3, canvasName: "main", generatedAt: NOW, count: 0, sections: [] });
  });

  it("counts what needs the operator: canvas needs count, an AI reading does not", () => {
    const feed = buildOperatorFeed({
      canvasName: "main",
      nowMs: NOW,
      seats: seats({ a: { health: reading("waiting_on_operator", NOW - 60_000) } }),
      signals: [signal({ signalId: "s", nodeId: "b" })],
      canvasNeeds: [
        {
          itemId: "stoppage:sink",
          kind: "blocked",
          seat: { nodeId: "sink", name: "Ship it", portraitIdentity: "sink" },
          region: { regionId: null, label: "open field", path: [] },
          text: "holding up 2 others",
          since: 4_000,
        },
      ],
    });
    const items = feed.sections.flatMap((s) => s.items);
    expect(items.map((i) => `${i.seat.nodeId}:${i.kind}`).sort()).toEqual(["a:health", "b:feedback", "sink:blocked"]);
    expect(feed.count).toBe(2);
    expect(needsOperatorCount(items)).toBe(feed.count);
    expect(items.find((i) => i.seat.nodeId === "sink")).toMatchObject({ canvas: true, since: 4_000, urgency: feedItemRank("blocked") });
  });

  it("adds a canvas need only where nothing listed for that node is as urgent", () => {
    const need = (nodeId: string, kind: "blocked" | "attention", since: number) => ({
      itemId: `${kind}:${nodeId}`,
      kind,
      seat: { nodeId, name: nodeId, portraitIdentity: nodeId },
      region: { regionId: null, label: "open field", path: [] },
      text: "from the canvas",
      since,
    });
    const feed = buildOperatorFeed({
      canvasName: "main",
      nowMs: NOW,
      seats: seats({ a: { attention: { reason: "permission prompt", at: 5_000 }, health: reading("waiting_on_operator", NOW) } }),
      signals: [signal({ signalId: "s", nodeId: "b", kind: "feedback" })],
      canvasNeeds: [need("a", "attention", 1), need("b", "blocked", 2), need("c", "blocked", 3)],
    });
    const items = feed.sections.flatMap((s) => s.items);
    // a: its proven attention is as urgent, so the canvas need stays out, and
    // the AI reading stays out because the seat is already listed.
    expect(items.filter((i) => i.seat.nodeId === "a").map((i) => i.itemId)).toEqual(["attention:a"]);
    // b: blocked outranks its feedback, so both show; the seat's region is kept.
    expect(items.filter((i) => i.seat.nodeId === "b").map((i) => i.kind)).toEqual(["blocked", "feedback"]);
    expect(items.find((i) => i.itemId === "blocked:b")?.region.regionId).toBe("inner");
    expect(feed.count).toBe(4);
  });

  it("lists a stopped seat once, between a block and an escalation, and counts it", () => {
    const limited = snapshotAfter(
      ["screen", { _tag: "TurnStarted" }],
      ["screen", { _tag: "UsageLimitHit", scope: "weekly", message: "You've hit your limit" }],
    );
    const feed = buildOperatorFeed({
      canvasName: "main",
      nowMs: NOW,
      seats: seats({ a: { snapshot: limited } }),
      signals: [
        signal({ signalId: "esc", nodeId: "a", kind: "escalate", createdAt: 1_000 }),
        signal({ signalId: "blk", nodeId: "a", kind: "blocked", createdAt: 2_000 }),
      ],
    });
    const items = feed.sections.flatMap((s) => s.items);
    expect(items.map((i) => i.kind)).toEqual(["blocked", "stopped", "escalate"]);
    expect(items[1]).toMatchObject({ itemId: "stopped:a", text: "hit a usage limit", urgency: feedItemRank("stopped"), since: 3_001 });
    expect(feed.count).toBe(3);
  });

  it("says what stopped a seat, with the harness's words in the detail", () => {
    const resets = new Date(2026, 9, 17, 15, 0).getTime();
    const now = new Date(2026, 9, 17, 12, 0).getTime();
    const stop = (...steps: ReadonlyArray<readonly [SignalSource, SeatSignal]>) => feedStopOf(snapshotAfter(...steps), now);
    expect(stop(["screen", { _tag: "UsageLimitHit", scope: "5h", resetsAt: resets, message: "limit" }])?.text).toBe(
      "hit a usage limit, resets 15:00",
    );
    expect(stop(["transcript", { _tag: "ErrorRaised", kind: "auth", message: "authentication_failed" }])).toMatchObject({
      text: "stopped on a sign-in error",
      detail: "authentication_failed",
    });
    expect(stop(["transcript", { _tag: "ErrorRaised", kind: "crash", message: "panic" }])).toMatchObject({ text: "stopped on an error" });
    expect(stop(["process", { _tag: "ProcessExited", code: 137, expected: false }])).toEqual({
      text: "exited unexpectedly",
      detail: "Exit code 137.",
      since: 3_000,
    });
    expect(stop(["process", { _tag: "ProcessExited", code: 0, expected: true }])).toBeUndefined();
    expect(stop(["screen", { _tag: "TurnStarted" }])).toBeUndefined();
  });

  it("ranks on the one ladder: blocked, stopped, a proven dialog, then an escalation, which an AI waiting reading ties, then review", () => {
    const order: FeedItemKind[] = ["blocked", "stopped", "attention", "escalate", "feedback"];
    for (const [index, kind] of order.entries()) {
      if (index > 0) expect(feedItemRank(kind)).toBeLessThan(feedItemRank(order[index - 1]!));
    }
    expect(feedItemRank("health")).toBe(feedItemRank("escalate"));
    expect([feedItemRank("blocked"), feedItemRank("feedback")]).toEqual([9, 5]);
  });

  it("says a count in the label table's words, agreeing with the number", () => {
    expect(feedKindCount("attention", 1)).toBe("1 needs input");
    expect(feedKindCount("attention", 2)).toBe("2 need input");
    expect(feedKindCount("blocked", 3)).toBe("3 blocked");
    expect(feedKindCount("feedback", 2)).toBe("2 ready for review");
    expect(feedKindCount("health", 1)).toBe("1 AI read");
    expect(feedKindCount("health", 2)).toBe("2 AI reads");
  });

  it("orders by urgency, then oldest first", () => {
    const feed = buildOperatorFeed({
      canvasName: "main",
      nowMs: NOW,
      seats: [],
      signals: [
        signal({ signalId: "new-fb", nodeId: "x", kind: "feedback", createdAt: 9_000 }),
        signal({ signalId: "old-fb", nodeId: "y", kind: "feedback", createdAt: 1_000 }),
        signal({ signalId: "new-block", nodeId: "z", kind: "blocked", createdAt: 8_000 }),
        signal({ signalId: "old-block", nodeId: "w", kind: "blocked", createdAt: 2_000 }),
      ],
    });
    expect(feed.sections[0]?.items.map((i) => i.signalId)).toEqual(["old-block", "new-block", "old-fb", "new-fb"]);
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
