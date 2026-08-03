import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import type { AgentSeatStateEvent } from "../src/shared/agent-seat-state";
import {
  kernelCycleNeededForSeatEvent,
  makeCoalescedKernelCycleScheduler,
  subscribeKernelPauseWake,
  subscribeKernelSeatWake,
} from "../src/main/vellum/kernel/service";

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

  it("coalesces any lifecycle burst during a cycle into one repair pass", async () => {
    let releaseFirst!: () => void;
    let reportSecondStarted!: () => void;
    const firstCycle = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const secondCycleStarted = new Promise<void>((resolve) => {
      reportSecondStarted = resolve;
    });
    let runs = 0;

    // V4-PROGRAM: cycle is Effect; host fork is the only Promise bridge.
    const schedule = makeCoalescedKernelCycleScheduler(
      Effect.gen(function* () {
        runs += 1;
        if (runs === 1) yield* Effect.promise(() => firstCycle);
        if (runs === 2) reportSecondStarted();
      }),
      (effect) => {
        void Effect.runPromise(effect as Effect.Effect<unknown, unknown>);
      },
    );

    schedule();
    schedule();
    schedule();
    expect(runs).toBe(1);

    releaseFirst();
    await secondCycleStarted;
    expect(runs).toBe(2);

    // The second pass consumed the single queued bit; it did not retain one
    // retry per event in the burst.
    await Promise.resolve();
    expect(runs).toBe(2);
  });
});
