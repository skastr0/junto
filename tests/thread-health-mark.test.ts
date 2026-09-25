import { describe, expect, it } from "vitest";
import { THREAD_HEALTH_TTL_MS, type ThreadHealthReading, type ThreadHealthValue } from "../src/shared/thread-health";
import {
  THREAD_HEALTH_STATUS_TONE,
  threadHealthFreshness,
  threadHealthMark,
} from "../src/renderer/lib/thread-health";

const T0 = 1_700_000_000_000;

const reading = (value: ThreadHealthValue): ThreadHealthReading => ({
  bindingId: "b1",
  value,
  confidence: 0.95,
  observedAt: T0,
  provenance: { source: "jev", assessmentId: "a1", questionId: `health.${value}`, packVersion: "awareness-pack/2" },
  signals: [{ value, probability: 0.95, questionId: `health.${value}` }],
});

describe("threadHealthFreshness", () => {
  it("is current inside the TTL, whatever the screen did", () => {
    expect(
      threadHealthFreshness(reading("steady"), { now: T0 + 1_000, evidenceDigest: "d1", liveDigest: "d2" }),
    ).toBe("current");
  });

  it("stays current past the TTL while the screen is the one observed", () => {
    // An idle seat that stopped to ask the operator does not change its screen;
    // its reading must not age out just because time passed.
    const late = T0 + THREAD_HEALTH_TTL_MS * 4;
    expect(
      threadHealthFreshness(reading("waiting_on_operator"), { now: late, evidenceDigest: "d1", liveDigest: "d1" }),
    ).toBe("current");
    expect(
      threadHealthFreshness(reading("waiting_on_operator"), { now: late, evidenceDigest: "d1", liveDigest: "d2" }),
    ).toBe("stale");
    expect(
      threadHealthFreshness(reading("waiting_on_operator"), { now: late, evidenceDigest: "d1", liveDigest: undefined }),
    ).toBe("stale");
  });
});

describe("threadHealthMark", () => {
  const now = T0 + 1_000;

  it("draws both ends of the spectrum, labelled as an AI reading", () => {
    expect(threadHealthMark(reading("going_well"), { now, freshness: "current" })).toEqual({
      health: "good",
      healthStale: false,
      label: "AI reads: going well",
    });
    expect(threadHealthMark(reading("stuck"), { now, freshness: "current" }).health).toBe("trouble");
    expect(threadHealthMark(undefined, { now, freshness: "current" }).health).toBeUndefined();
  });

  it("says how old a stale reading is and draws it quietly", () => {
    const mark = threadHealthMark(reading("thrashing"), { now: T0 + 7 * 60_000, freshness: "stale" });
    expect(mark).toEqual({
      health: "trouble",
      healthStale: true,
      label: "AI reads: thrashing, last observed 7m ago",
    });
  });

  it("does not echo or contradict a declared blocked or escalate signal", () => {
    for (const signal of ["blocked", "escalate"] as const) {
      expect(threadHealthMark(reading("waiting_on_operator"), { now, freshness: "current", signal }).health).toBeUndefined();
      const good = threadHealthMark(reading("succeeding"), { now, freshness: "current", signal });
      expect(good).toMatchObject({ health: "good", healthStale: true });
      // Trouble readings stay loud: they add information the declaration lacks.
      expect(threadHealthMark(reading("confused"), { now, freshness: "current", signal }).healthStale).toBe(false);
    }
    // Feedback is not a request to be unblocked, so nothing is muted.
    expect(
      threadHealthMark(reading("succeeding"), { now, freshness: "current", signal: "feedback" }).healthStale,
    ).toBe(false);
  });

  it("never paints health crimson", () => {
    expect(Object.values(THREAD_HEALTH_STATUS_TONE)).not.toContain("crimson");
  });
});
