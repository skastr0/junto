import { describe, expect, it } from "vitest";
import type { PreambleEvent } from "../src/shared/preamble";
import {
  FEED_TUNING,
  dismissSeat,
  feedPreamble,
  nextDeadline,
  tickFeed,
  type FeedState,
} from "../src/renderer/lib/preamble-feed";

const T0 = 1_000_000;
let n = 0;
const ev = (fields: Partial<PreambleEvent> = {}, at = T0): PreambleEvent => ({
  preambleId: `p${String((n += 1))}`,
  canvasName: "c",
  nodeId: "seat",
  text: "mail from planner",
  expiresAt: at + 6_000,
  provenance: "agent",
  action: "mail-in",
  ...fields,
});

const bubble = (state: FeedState, nodeId = "seat") => state.get(nodeId)?.bubble;

describe("preamble feed", () => {
  it("defaults an agent's own preamble to say, second tone", () => {
    const s = feedPreamble(new Map(), { ...ev(), provenance: undefined, action: undefined, tone: undefined }, T0);
    expect(bubble(s)?.current).toMatchObject({ provenance: "agent", action: "say", tone: "second" });
  });

  it("the same news again only keeps the showing note up", () => {
    let s: FeedState = new Map();
    s = feedPreamble(s, ev(), T0);
    const first = bubble(s)?.current;
    s = feedPreamble(s, ev({}, T0 + 500), T0 + 500);
    s = feedPreamble(s, ev({}, T0 + 900), T0 + 900);
    expect(bubble(s)?.current.id).toBe(first?.id);
    expect(bubble(s)?.current.expiresAt).toBe(T0 + 900 + 6_000);
    expect(bubble(s)?.previous).toBeUndefined();
  });

  it("news shown within the dedupe window is not news again, even after it expired", () => {
    let s: FeedState = new Map();
    s = feedPreamble(s, ev({ action: "state", provenance: "system", text: "waiting on you" }), T0);
    s = tickFeed(s, T0 + 6_000);
    expect(bubble(s)).toBeUndefined();
    const again = T0 + 20_000;
    s = feedPreamble(s, ev({ action: "state", provenance: "system", text: "Waiting on you" }, again), again);
    expect(bubble(s)).toBeUndefined();
    const later = T0 + FEED_TUNING.dedupeMs + 1;
    s = feedPreamble(s, ev({ action: "state", provenance: "system", text: "waiting on you" }, later), later);
    expect(bubble(s)?.current.text).toBe("waiting on you");
  });

  it("holds as-loud news until the current note has dwelt, then shows it with a trail", () => {
    let s: FeedState = new Map();
    s = feedPreamble(s, ev({ action: "say", text: "one" }), T0);
    s = feedPreamble(s, ev({ action: "say", text: "two" }, T0 + 100), T0 + 100);
    s = feedPreamble(s, ev({ action: "say", text: "three" }, T0 + 200), T0 + 200);
    expect(bubble(s)?.current.text).toBe("one");
    expect(nextDeadline(s)).toBe(T0 + FEED_TUNING.dwellMs);
    s = tickFeed(s, T0 + FEED_TUNING.dwellMs);
    // Only the newest waiting note is kept: the seat's words are paced, not queued.
    expect(bubble(s)?.current.text).toBe("three");
    expect(bubble(s)?.previous?.text).toBe("one");
  });

  it("louder news replaces at once: a signal over the agent's words", () => {
    let s: FeedState = new Map();
    s = feedPreamble(s, ev({ action: "state", provenance: "system", text: "done" }), T0);
    s = feedPreamble(s, ev({ action: "signal", tone: "crimson", text: "blocked: need a key" }, T0 + 50), T0 + 50);
    expect(bubble(s)?.current.action).toBe("signal");
    expect(bubble(s)?.previous?.text).toBe("done");
  });

  it("a waiting louder note is not displaced by a quieter one", () => {
    let s: FeedState = new Map();
    s = feedPreamble(s, ev({ action: "say", text: "one" }), T0);
    s = feedPreamble(s, ev({ action: "health", provenance: "ai", text: "stuck" }, T0 + 50), T0 + 50);
    s = feedPreamble(s, ev({ action: "state", provenance: "system", text: "done" }, T0 + 60), T0 + 60);
    s = feedPreamble(s, ev({ text: "mail from builder" }, T0 + 70), T0 + 70);
    s = tickFeed(s, T0 + FEED_TUNING.dwellMs);
    expect(bubble(s)?.current.text).toBe("done");
  });

  it("rate-limits quiet news per seat and drops the excess", () => {
    let s: FeedState = new Map();
    let t = T0;
    // A burst: every distinct note spends a token until the bucket is dry;
    // the newest admitted one waits its turn, the rest are dropped.
    for (let i = 0; i < FEED_TUNING.bucket + 3; i += 1) {
      s = feedPreamble(s, ev({ text: `mail ${String(i)}` }, t), t);
      t += 100;
    }
    expect(bubble(s)?.current.text).toBe("mail 0");
    s = tickFeed(s, T0 + FEED_TUNING.dwellMs);
    expect(bubble(s)?.current.text).toBe(`mail ${String(FEED_TUNING.bucket - 1)}`);
    // Another seat is unaffected by this one's bucket.
    s = feedPreamble(s, ev({ nodeId: "other", text: "fresh" }, t), t);
    expect(bubble(s, "other")?.current.text).toBe("fresh");
  });

  it("loud news is never rate-limited", () => {
    let s: FeedState = new Map();
    let t = T0;
    for (let i = 0; i < FEED_TUNING.bucket * 2; i += 1) {
      t += FEED_TUNING.dwellMs;
      s = tickFeed(s, t);
      s = feedPreamble(s, ev({ action: "state", provenance: "system", text: `state ${String(i)}` }, t), t);
    }
    expect(bubble(s)?.current.text).toBe(`state ${String(FEED_TUNING.bucket * 2 - 1)}`);
  });

  it("expires notes and trails, and forgets idle seats", () => {
    let s: FeedState = new Map();
    s = feedPreamble(s, ev(), T0);
    s = tickFeed(s, T0 + 6_000);
    expect(bubble(s)).toBeUndefined();
    // The seat is remembered only as long as its news could repeat.
    expect(nextDeadline(s)).toBe(T0 + FEED_TUNING.dedupeMs);
    s = tickFeed(s, T0 + FEED_TUNING.dedupeMs);
    expect(s.size).toBe(0);
    expect(nextDeadline(s)).toBeUndefined();
  });

  it("ignores already-expired events and stale dismiss ids", () => {
    let s: FeedState = new Map();
    s = feedPreamble(s, ev({ expiresAt: T0 - 1 }), T0);
    expect(s.size).toBe(0);
    s = feedPreamble(s, ev({ preambleId: "keep" }), T0);
    expect(dismissSeat(s, "seat", "other-id")).toBe(s);
    expect(bubble(dismissSeat(s, "seat", "keep"))).toBeUndefined();
  });
});
