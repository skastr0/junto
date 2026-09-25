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
  text: "checking tasks",
  expiresAt: at + 6_000,
  provenance: "agent",
  action: "tool",
  ...fields,
});

const bubble = (state: FeedState, nodeId = "seat") => state.get(nodeId)?.bubble;

describe("preamble feed", () => {
  it("defaults an agent's own preamble to say, second tone", () => {
    const s = feedPreamble(new Map(), { ...ev(), provenance: undefined, action: undefined, tone: undefined }, T0);
    expect(bubble(s)?.current).toMatchObject({ provenance: "agent", action: "say", tone: "second" });
  });

  it("coalesces the same news in place and counts it", () => {
    let s: FeedState = new Map();
    s = feedPreamble(s, ev(), T0);
    s = feedPreamble(s, ev({}, T0 + 500), T0 + 500);
    s = feedPreamble(s, ev({}, T0 + 900), T0 + 900);
    expect(bubble(s)?.current.count).toBe(3);
    expect(bubble(s)?.previous).toBeUndefined();
  });

  it("holds quieter news until the current note has dwelt, then shows it with a trail", () => {
    let s: FeedState = new Map();
    s = feedPreamble(s, ev({ text: "claimed a task" }), T0);
    s = feedPreamble(s, ev({ text: "reading the pad" }, T0 + 100), T0 + 100);
    expect(bubble(s)?.current.text).toBe("claimed a task");
    expect(nextDeadline(s)).toBe(T0 + FEED_TUNING.dwellMs);
    s = tickFeed(s, T0 + FEED_TUNING.dwellMs);
    expect(bubble(s)?.current.text).toBe("reading the pad");
    expect(bubble(s)?.previous?.text).toBe("claimed a task");
  });

  it("louder news replaces at once: a signal over a tool call, new words over old", () => {
    let s: FeedState = new Map();
    s = feedPreamble(s, ev(), T0);
    s = feedPreamble(s, ev({ action: "signal", tone: "crimson", text: "blocked: need a key" }, T0 + 50), T0 + 50);
    expect(bubble(s)?.current.action).toBe("signal");
    s = feedPreamble(s, ev({ action: "say", text: "one" }, T0 + 60), T0 + 60);
    s = feedPreamble(s, ev({ action: "say", text: "two" }, T0 + 70), T0 + 70);
    expect(bubble(s)?.current.text).toBe("two");
  });

  it("rate-limits quiet news per seat and folds the excess into +N more", () => {
    let s: FeedState = new Map();
    let t = T0;
    // A burst: every distinct note spends a token until the bucket is dry.
    for (let i = 0; i < FEED_TUNING.bucket + 3; i += 1) {
      t += 200;
      s = feedPreamble(s, ev({ text: `op ${String(i)}` }, t), t);
    }
    expect(bubble(s)?.current.text).toBe("op 0");
    expect(bubble(s)?.current.more).toBe(3);
    // Another seat is unaffected by this one's bucket.
    s = feedPreamble(s, ev({ nodeId: "other", text: "fresh" }, t), t);
    expect(bubble(s, "other")?.current.text).toBe("fresh");
  });

  it("loud news is never rate-limited", () => {
    let s: FeedState = new Map();
    let t = T0;
    for (let i = 0; i < FEED_TUNING.bucket * 2; i += 1) {
      t += 10;
      s = feedPreamble(s, ev({ action: "state", provenance: "system", text: `state ${String(i)}` }, t), t);
    }
    expect(bubble(s)?.current.text).toBe(`state ${String(FEED_TUNING.bucket * 2 - 1)}`);
  });

  it("expires notes and trails, and forgets idle seats", () => {
    let s: FeedState = new Map();
    s = feedPreamble(s, ev(), T0);
    s = tickFeed(s, T0 + 6_000);
    expect(bubble(s)).toBeUndefined();
    s = tickFeed(s, T0 + 6_000 + FEED_TUNING.refillMs * FEED_TUNING.bucket);
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
