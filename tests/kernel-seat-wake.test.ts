import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import type { AgentSeatStateEvent } from "../src/shared/agent-seat-state";
import {
  KERNEL_CYCLE_KEY,
  KERNEL_SAFETY_KEY,
  kernelCycleNeededForSeatEvent,
  kernelResyncKey,
  makeKernelLaneScheduler,
  subscribeKernelPauseWake,
  subscribeKernelSeatWake,
} from "../src/main/vellum-command/kernel/service";
import {
  LANE_FLOOR_MS,
  type TickTimerCancel,
} from "../src/main/vellum-command/kernel/tick";

/** Manual clock + timers: the floor is asserted exactly, never slept through. */
const makeTestClock = () => {
  let at = 1_000;
  let nextId = 1;
  const timers = new Map<number, { dueAt: number; run: () => void }>();
  const step = (): boolean => {
    let dueId: number | undefined;
    let dueAt = Number.POSITIVE_INFINITY;
    let run: (() => void) | undefined;
    for (const [id, timer] of timers) {
      if (timer.dueAt > at || timer.dueAt >= dueAt) continue;
      dueId = id;
      dueAt = timer.dueAt;
      run = timer.run;
    }
    if (dueId === undefined || run === undefined) return false;
    timers.delete(dueId);
    run();
    return true;
  };
  return {
    now: () => at,
    setTimer: (delayMs: number, run: () => void): TickTimerCancel => {
      const id = nextId;
      nextId += 1;
      timers.set(id, { dueAt: at + delayMs, run });
      return () => {
        timers.delete(id);
      };
    },
    step,
    settle: (maxSteps = 100): number => {
      let steps = 0;
      while (steps < maxSteps && step()) steps += 1;
      return steps;
    },
    advance: (ms: number): void => {
      at += ms;
    },
  };
};

const seatEvent = (
  state: AgentSeatStateEvent["state"],
  reason: string,
): AgentSeatStateEvent => ({
  bindingId: "agent-seat",
  epoch: "generation-1",
  state,
  reason,
  confidence: "high",
  at: 1,
  harness: "codex",
});

describe("Kernel managed-seat wake scheduling", () => {
  it("wakes immediately on play and pause transitions", () => {
    let listener: ((canvasName: string) => void) | undefined;
    let wakes = 0;
    const unsubscribe = subscribeKernelPauseWake(
      (next) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
      () => {
        wakes += 1;
      },
    );

    listener?.("factory");
    listener?.("factory");
    expect(wakes).toBe(2);
    unsubscribe();
    expect(listener).toBeUndefined();
  });

  it("wakes for deliverable and generation lifecycle events only", () => {
    expect(kernelCycleNeededForSeatEvent(seatEvent("idle", "prompt"))).toBe(
      true,
    );
    expect(
      kernelCycleNeededForSeatEvent(
        seatEvent("unknown", "generation_bound"),
      ),
    ).toBe(true);
    expect(
      kernelCycleNeededForSeatEvent(
        seatEvent("unknown", "generation_replaced"),
      ),
    ).toBe(true);
    expect(
      kernelCycleNeededForSeatEvent(
        seatEvent("unknown", "binding_reconfigured"),
      ),
    ).toBe(true);
    expect(
      kernelCycleNeededForSeatEvent(seatEvent("gone", "generation_exited")),
    ).toBe(true);

    expect(
      kernelCycleNeededForSeatEvent(seatEvent("working", "turn_started")),
    ).toBe(false);
    expect(
      kernelCycleNeededForSeatEvent(
        seatEvent("attention", "permission_required"),
      ),
    ).toBe(false);
    expect(
      kernelCycleNeededForSeatEvent(seatEvent("unknown", "screen_unknown")),
    ).toBe(false);
  });

  it("subscribes once and stops waking after unsubscribe", () => {
    let listener: ((event: AgentSeatStateEvent) => void) | undefined;
    let wakes = 0;
    const unsubscribe = subscribeKernelSeatWake(
      (next) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
      () => {
        wakes += 1;
      },
    );

    listener?.(seatEvent("working", "turn_started"));
    listener?.(seatEvent("idle", "prompt"));
    listener?.(seatEvent("gone", "generation_exited"));
    expect(wakes).toBe(2);

    unsubscribe();
    listener?.(seatEvent("idle", "prompt"));
    expect(wakes).toBe(2);
  });

  /**
   * The invariant the old boolean-pair coalescer held, re-pinned against the
   * lane scheduler that replaced it: a burst of lifecycle events during a pass
   * retains exactly ONE repair pass, never one retry per event.
   *
   * What the old scheduler did NOT hold, and this now does: the next pass
   * waits out the simulation lane's floor instead of re-running the instant
   * the previous one finished.
   */
  it("collapses a lifecycle burst into one repair pass, then paces it", async () => {
    const clock = makeTestClock();
    const forked: Array<Effect.Effect<unknown, unknown>> = [];
    let cycles = 0;

    const scheduler = makeKernelLaneScheduler(
      {
        runCycle: Effect.sync(() => {
          cycles += 1;
        }),
        resyncCanvas: () => Effect.void,
        fork: (effect) => {
          forked.push(effect as Effect.Effect<unknown, unknown>);
        },
      },
      { now: clock.now, setTimer: clock.setTimer },
    );

    const runForked = async (): Promise<void> => {
      const effect = forked.shift();
      if (effect !== undefined) await Effect.runPromise(effect);
    };

    scheduler.mark("simulation", KERNEL_CYCLE_KEY);
    clock.step();
    expect(forked).toHaveLength(1);
    expect(cycles).toBe(0);

    // Fifty wakes land while the pass is in flight.
    for (let i = 0; i < 50; i += 1) scheduler.mark("simulation", KERNEL_CYCLE_KEY);
    expect(scheduler.pending("simulation")).toEqual([KERNEL_CYCLE_KEY]);

    await runForked();
    expect(cycles).toBe(1);

    // One queued key, not fifty — and it waits out the floor.
    clock.step();
    expect(forked).toHaveLength(0);
    clock.advance(LANE_FLOOR_MS.simulation);
    clock.step();
    expect(forked).toHaveLength(1);

    await runForked();
    expect(cycles).toBe(2);

    // The burst is spent: nothing re-arms on its own.
    clock.advance(10_000);
    clock.settle();
    expect(forked).toHaveLength(0);
  });

  it("re-reads a canvas once for a burst of commits on it", async () => {
    const clock = makeTestClock();
    const forked: Array<Effect.Effect<unknown, unknown>> = [];
    const resynced: Array<string> = [];

    const scheduler = makeKernelLaneScheduler(
      {
        runCycle: Effect.void,
        resyncCanvas: (canvasName) =>
          Effect.sync(() => {
            resynced.push(canvasName);
          }),
        fork: (effect) => {
          forked.push(effect as Effect.Effect<unknown, unknown>);
        },
      },
      { now: clock.now, setTimer: clock.setTimer },
    );

    for (let i = 0; i < 20; i += 1) {
      scheduler.mark("immediate", kernelResyncKey("factory"));
    }
    scheduler.mark("immediate", kernelResyncKey("scratch"));
    expect(scheduler.pending("immediate")).toEqual([
      "canvas:factory",
      "canvas:scratch",
    ]);

    clock.step();
    await Effect.runPromise(forked.shift() as Effect.Effect<unknown, unknown>);
    clock.step();
    await Effect.runPromise(forked.shift() as Effect.Effect<unknown, unknown>);

    expect(resynced).toEqual(["factory", "scratch"]);
  });

  it("routes the safety sweep through housekeeping into one cycle", () => {
    const clock = makeTestClock();
    const forked: Array<Effect.Effect<unknown, unknown>> = [];

    const scheduler = makeKernelLaneScheduler(
      {
        runCycle: Effect.void,
        resyncCanvas: () => Effect.void,
        fork: (effect) => {
          forked.push(effect as Effect.Effect<unknown, unknown>);
        },
      },
      { now: clock.now, setTimer: clock.setTimer },
    );

    scheduler.mark("housekeeping", KERNEL_SAFETY_KEY);
    clock.step();
    expect(scheduler.pending("simulation")).toEqual([KERNEL_CYCLE_KEY]);
    expect(forked).toHaveLength(0);

    clock.step();
    expect(forked).toHaveLength(1);
  });
});
