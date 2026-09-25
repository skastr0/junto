import { Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  THREAD_HEALTH_LABEL,
  THREAD_HEALTH_TONE,
  THREAD_HEALTH_VALUES,
  decodeThreadHealthReading,
} from "../src/shared/thread-health";

const reading = {
  bindingId: "bind-a",
  value: "going_well",
  confidence: 0.94,
  observedAt: 1_000,
  provenance: {
    source: "jev",
    assessmentId: "as-1",
    questionId: "health.going_well",
    packVersion: "awareness-pack/2",
  },
  signals: [{ value: "going_well", probability: 0.94, questionId: "health.going_well" }],
};

describe("thread health contract", () => {
  it("covers both ends of the spectrum, worst first", () => {
    expect(THREAD_HEALTH_TONE[THREAD_HEALTH_VALUES[0]]).toBe("trouble");
    expect(THREAD_HEALTH_TONE[THREAD_HEALTH_VALUES[THREAD_HEALTH_VALUES.length - 1]!]).toBe("good");
    for (const value of THREAD_HEALTH_VALUES) {
      expect(THREAD_HEALTH_LABEL[value].length).toBeGreaterThan(0);
      expect(THREAD_HEALTH_LABEL[value]).not.toContain("·");
    }
  });

  it("never borrows the declared-signal words", () => {
    for (const value of THREAD_HEALTH_VALUES) {
      expect(THREAD_HEALTH_LABEL[value]).not.toMatch(/\bblocked\b|waiting on you|escalat/iu);
    }
  });

  it("decodes a well-formed reading and refuses a malformed one", () => {
    expect(Option.isSome(decodeThreadHealthReading(reading))).toBe(true);
    expect(Option.isNone(decodeThreadHealthReading({ ...reading, value: "fine" }))).toBe(true);
    expect(
      Option.isNone(decodeThreadHealthReading({ ...reading, provenance: { ...reading.provenance, source: "agent" } })),
    ).toBe(true);
  });
});
