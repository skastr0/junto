import { Either, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  evaluateIntervalTimer,
  initializeIntervalTimer,
  IntervalTimerState,
  type IntervalTimerEvaluation,
} from "../src/shared/scheduler-policy";

const initializedState = (
  nowEpochMs = 1_000_000,
  everyMinutes = 1,
) => {
  const result = initializeIntervalTimer({
    scheduleId: "schedule-a",
    nowEpochMs,
    everyMinutes,
  });
  if (result._tag !== "Initialized") {
    throw new Error(`expected initialization, got ${result.reason}`);
  }
  return result.state;
};

const evaluate = (
  overrides: Partial<Parameters<typeof evaluateIntervalTimer>[0]> = {},
): IntervalTimerEvaluation =>
  evaluateIntervalTimer({
    timerKey: "canvas-a/timer-a",
    localStationId: "mini",
    homeStationIds: ["mini"],
    nowEpochMs: 1_060_000,
    everyMinutes: 1,
    state: initializedState(),
    ...overrides,
  });

describe("interval timer initialization", () => {
  it("persists the first slot one full interval after discovery", () => {
    const result = initializeIntervalTimer({
      scheduleId: "schedule-a",
      nowEpochMs: 1_000_000,
      everyMinutes: 0.5,
    });

    expect(result).toEqual({
      _tag: "Initialized",
      state: {
        version: 1,
        scheduleId: "schedule-a",
        intervalMilliseconds: 30_000,
        nextDueAtEpochMs: 1_030_000,
        nextDueSlot: "0",
      },
    });
  });

  it("fails closed for invalid clocks, intervals, identities, and overflow", () => {
    expect(
      initializeIntervalTimer({
        scheduleId: "",
        nowEpochMs: 1_000,
        everyMinutes: 1,
      }),
    ).toEqual({ _tag: "Ineligible", reason: "invalid-state" });
    expect(
      initializeIntervalTimer({
        scheduleId: "s",
        nowEpochMs: Number.NaN,
        everyMinutes: 1,
      }),
    ).toEqual({ _tag: "Ineligible", reason: "invalid-clock" });
    expect(
      initializeIntervalTimer({
        scheduleId: "s",
        nowEpochMs: 1_000,
        everyMinutes: 0,
      }),
    ).toEqual({ _tag: "Ineligible", reason: "invalid-interval" });
    expect(
      initializeIntervalTimer({
        scheduleId: "s",
        nowEpochMs: Number.MAX_SAFE_INTEGER - 1,
        everyMinutes: 1,
      }),
    ).toEqual({ _tag: "Ineligible", reason: "schedule-overflow" });
  });
});

describe("single-home admission", () => {
  it.each([
    {
      label: "an invalid local station",
      overrides: { localStationId: "-bad" },
      reason: "invalid-local-station",
    },
    {
      label: "no assigned home",
      overrides: { homeStationIds: [] },
      reason: "unhomed",
    },
    {
      label: "more than one candidate, including duplicate candidates",
      overrides: { homeStationIds: ["mini", "mini"] },
      reason: "ambiguous-home",
    },
    {
      label: "an invalid home",
      overrides: { homeStationIds: ["-bad"] },
      reason: "invalid-home",
    },
    {
      label: "a foreign home",
      overrides: { homeStationIds: ["studio"] },
      reason: "foreign-home",
    },
  ])("does not schedule $label", ({ overrides, reason }) => {
    expect(evaluate(overrides)).toEqual({
      _tag: "Ineligible",
      reason,
    });
  });
});

describe("interval catch-up", () => {
  it("is not due one millisecond before the boundary", () => {
    const state = initializedState();
    expect(evaluate({ nowEpochMs: 1_059_999, state })).toEqual({
      _tag: "NotDue",
      state,
      dueSlot: "0",
      dueAtEpochMs: 1_060_000,
    });
  });

  it("fires exactly once on the boundary and advances contiguously", () => {
    expect(evaluate()).toEqual({
      _tag: "Firing",
      identity: {
        homeStationId: "mini",
        timerKey: "canvas-a/timer-a",
        scheduleId: "schedule-a",
        claimSlot: "0",
      },
      dueSlot: "0",
      scheduledForEpochMs: 1_060_000,
      observedAtEpochMs: 1_060_000,
      coalescedMissedSlots: "0",
      nextState: {
        version: 1,
        scheduleId: "schedule-a",
        intervalMilliseconds: 60_000,
        nextDueAtEpochMs: 1_120_000,
        nextDueSlot: "1",
        lastFiredSlot: "0",
      },
    });
  });

  it("coalesces every missed interval into one latest-slot firing", () => {
    const result = evaluate({ nowEpochMs: 1_250_000 });

    expect(result._tag).toBe("Firing");
    if (result._tag !== "Firing") return;
    expect(result.dueSlot).toBe("3");
    expect(result.scheduledForEpochMs).toBe(1_240_000);
    expect(result.coalescedMissedSlots).toBe("3");
    expect(result.nextState).toMatchObject({
      nextDueAtEpochMs: 1_300_000,
      nextDueSlot: "4",
      lastFiredSlot: "3",
    });
  });

  it("derives one stable dedupe identity from the persisted claim slot", () => {
    const persisted = initializedState();
    const first = evaluate({ nowEpochMs: 1_250_000, state: persisted });
    const concurrentAcrossBoundary = evaluate({
      nowEpochMs: 1_310_000,
      state: persisted,
    });

    expect(first._tag).toBe("Firing");
    expect(concurrentAcrossBoundary._tag).toBe("Firing");
    if (
      first._tag !== "Firing" ||
      concurrentAcrossBoundary._tag !== "Firing"
    ) {
      return;
    }
    expect(concurrentAcrossBoundary.identity).toEqual(first.identity);
    expect(first.identity.claimSlot).toBe("0");
    expect(first.dueSlot).toBe("3");
    expect(concurrentAcrossBoundary.dueSlot).toBe("4");
  });

  it("continues from persisted nextState after restart without replay", () => {
    const first = evaluate({ nowEpochMs: 1_250_000 });
    expect(first._tag).toBe("Firing");
    if (first._tag !== "Firing") return;

    const restarted = evaluate({
      nowEpochMs: 1_250_000,
      state: first.nextState,
    });
    expect(restarted).toEqual({
      _tag: "NotDue",
      state: first.nextState,
      dueSlot: "4",
      dueAtEpochMs: 1_300_000,
    });
  });

  it("a backwards wall-clock step stays not-due and cannot replay", () => {
    const first = evaluate();
    expect(first._tag).toBe("Firing");
    if (first._tag !== "Firing") return;

    const skewed = evaluate({
      nowEpochMs: 1_010_000,
      state: first.nextState,
    });
    expect(skewed._tag).toBe("NotDue");
  });

  it("keeps slot arithmetic exact beyond Number.MAX_SAFE_INTEGER", () => {
    const state = {
      ...initializedState(),
      nextDueSlot: "90071992547409931234567890",
      lastFiredSlot: "90071992547409931234567889",
    };

    const result = evaluate({ nowEpochMs: 1_180_000, state });
    expect(result._tag).toBe("Firing");
    if (result._tag !== "Firing") return;
    expect(result.identity.claimSlot).toBe("90071992547409931234567890");
    expect(result.dueSlot).toBe("90071992547409931234567892");
    expect(result.nextState.nextDueSlot).toBe(
      "90071992547409931234567893",
    );
  });

  it("fails closed when advancing the persisted due time would overflow", () => {
    const state = {
      ...initializedState(),
      nextDueAtEpochMs: Number.MAX_SAFE_INTEGER - 30_000,
    };

    expect(
      evaluate({
        nowEpochMs: Number.MAX_SAFE_INTEGER - 30_000,
        state,
      }),
    ).toEqual({ _tag: "Ineligible", reason: "schedule-overflow" });
  });
});

describe("persisted timer-state boundary", () => {
  it("round-trips the persisted cursor through its encoded JSON shape", () => {
    const state = initializedState();
    const encoded = Schema.encodeSync(IntervalTimerState)(state);
    const decoded = Schema.decodeUnknownSync(IntervalTimerState)(
      JSON.parse(JSON.stringify(encoded)),
    );

    expect(decoded).toEqual(state);
  });

  it("rejects partial/corrupt cursors instead of repairing them", () => {
    const decode = Schema.decodeUnknownEither(IntervalTimerState);
    const corrupt = {
      ...initializedState(),
      nextDueSlot: "9",
      lastFiredSlot: "4",
    };

    expect(Either.isLeft(decode(corrupt))).toBe(true);
    expect(evaluate({ state: corrupt })).toEqual({
      _tag: "Ineligible",
      reason: "invalid-state",
    });
  });

  it("requires an explicit reset when the authored interval changes", () => {
    expect(evaluate({ everyMinutes: 2 })).toEqual({
      _tag: "Ineligible",
      reason: "interval-mismatch",
    });
  });
});
