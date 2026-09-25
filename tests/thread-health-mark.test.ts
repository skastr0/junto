import { describe, expect, it } from "vitest";
import { THREAD_HEALTH_TTL_MS, type ThreadHealthReading, type ThreadHealthValue } from "../src/shared/thread-health";
import {
  THREAD_HEALTH_STATUS_TONE,
  threadHealthFreshness,
  threadHealthMark,
  threadHealthSectionModel,
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
      value: "going_well",
      healthStale: false,
      label: "AI reads: going well",
      line: "going well",
    });
    expect(threadHealthMark(reading("stuck"), { now, freshness: "current" }).health).toBe("trouble");
    expect(threadHealthMark(undefined, { now, freshness: "current" }).health).toBeUndefined();
  });

  it("says how old a stale reading is and draws it quietly", () => {
    const mark = threadHealthMark(reading("thrashing"), { now: T0 + 7 * 60_000, freshness: "stale" });
    expect(mark).toEqual({
      health: "trouble",
      value: "thrashing",
      healthStale: true,
      label: "AI reads: thrashing, last observed 7m ago",
      line: "thrashing",
    });
  });

  it("does not echo or contradict a declared blocked or escalate signal", () => {
    for (const signal of ["blocked", "escalate"] as const) {
      expect(threadHealthMark(reading("waiting_on_operator"), { now, freshness: "current", signal }).health).toBeUndefined();
      const good = threadHealthMark(reading("succeeding"), { now, freshness: "current", signal });
      expect(good).toMatchObject({ health: "good", healthStale: true, line: undefined });
      // The label line belongs to the declared signal while it is open.
      expect(threadHealthMark(reading("confused"), { now, freshness: "current", signal }).line).toBeUndefined();
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

describe("threadHealthSectionModel", () => {
  it("shows the headline, every other accepted reading, and where it came from", () => {
    const mixed: ThreadHealthReading = {
      ...reading("confused"),
      confidence: 0.914,
      provenance: { ...reading("confused").provenance, model: "jev-1.13.0" },
      signals: [
        { value: "confused", probability: 0.914, questionId: "health.confused" },
        { value: "going_well", probability: 0.93, questionId: "health.going_well" },
      ],
    };
    const model = threadHealthSectionModel({
      reading: mixed,
      freshness: "current",
      label: "AI reads: confused",
      tone: "trouble",
      observedAgo: "2m ago",
    });
    expect(model).toEqual({
      tone: "amber",
      headline: "confused",
      confidence: "91%",
      alsoRead: [{ label: "going well", tone: "green", confidence: "93%" }],
      meta: undefined,
      provenance: "Jev's reading of the screen, observed 2m ago by jev-1.13.0. Not the agent's own claim.",
    });
  });

  it("puts the age in the header once the reading is stale", () => {
    const model = threadHealthSectionModel({
      reading: reading("steady"),
      freshness: "stale",
      label: "AI reads: steady, last observed 9m ago",
      tone: "steady",
      observedAgo: "9m ago",
    });
    expect(model.meta).toBe("last observed 9m ago");
    expect(model.tone).toBe("steel");
  });
});
