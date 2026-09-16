/**
 * The budgeted, resumable tick.
 *
 * Every test here drives a MANUAL clock and a MANUAL timer. Nothing sleeps,
 * nothing races, and "4 ms" means an exact simulated 4 ms rather than whatever
 * the machine happened to be doing — a wall-clock budget test on a laptop
 * shared with other agents would pin load, not behaviour.
 */
import { describe, expect, it } from "vitest";

import {
  LANE_BUDGET_MS,
  LANE_FLOOR_MS,
  makeDirtyQueue,
  makeKernelTickScheduler,
  type LaneFailure,
  type LaneOverrun,
  type LaneProcess,
  type TickTimerCancel,
} from "../src/main/vellum-command/kernel/tick";

/**
 * A clock the test moves by hand, plus the timers armed against it.
 *
 * `step()` fires exactly ONE due timer — one lane slice — because every
 * assertion below is about what a single slice did. `settle()` runs slices
 * until nothing is due, bounded, so a lane that keeps producing work cannot
 * hang the suite.
 */
const makeTestClock = () => {
  let at = 1_000;
  let nextId = 1;
  const timers = new Map<number, { dueAt: number; run: () => void }>();

  const setTimer = (delayMs: number, run: () => void): TickTimerCancel => {
    const id = nextId;
    nextId += 1;
    timers.set(id, { dueAt: at + delayMs, run });
    return () => {
      timers.delete(id);
    };
  };

  /** Fire the earliest timer due at or before now. Exactly one slice. */
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
    setTimer,
    step,
    /** Run slices until nothing is due. Bounded: a hot lane never hangs. */
    settle: (maxSteps = 200): number => {
      let steps = 0;
      while (steps < maxSteps && step()) steps += 1;
      return steps;
    },
    /** Move the clock without running anything. */
    advance: (ms: number): void => {
      at += ms;
    },
    /** Spend simulated main-thread time inside a slice. */
    burn: (ms: number): void => {
      at += ms;
    },
    pendingTimers: () => timers.size,
  };
};

const idleLane = { process: (() => "done") as LaneProcess };

describe("dirty queue", () => {
  it("collapses a burst on one key into one unit of work", () => {
    const queue = makeDirtyQueue();
    for (let i = 0; i < 1_000; i += 1) queue.mark("sink-a");
    queue.mark("sink-b");

    expect(queue.size()).toBe(2);
    expect(queue.keys()).toEqual(["sink-a", "sink-b"]);
  });

  it("serves oldest first, and re-marking does not jump the line", () => {
    const queue = makeDirtyQueue();
    queue.mark("a");
    queue.mark("b");
    queue.mark("c");
    queue.mark("c");
    queue.mark("a");

    expect(queue.take()).toBe("a");
    expect(queue.take()).toBe("b");
    expect(queue.take()).toBe("c");
    expect(queue.take()).toBeUndefined();
    expect(queue.size()).toBe(0);
  });

  it("re-admits a key marked again after it was taken", () => {
    const queue = makeDirtyQueue();
    queue.mark("a");
    expect(queue.take()).toBe("a");
    expect(queue.has("a")).toBe(false);
    queue.mark("a");
    expect(queue.keys()).toEqual(["a"]);
  });

  it("stays bounded by key count across long churn, not by event count", () => {
    const queue = makeDirtyQueue();
    for (let round = 0; round < 500; round += 1) {
      queue.mark(`key-${round % 4}`);
      queue.mark(`key-${round % 4}`);
      if (round % 2 === 0) queue.take();
    }
    expect(queue.size()).toBeLessThanOrEqual(4);
    expect(queue.keys().length).toBe(queue.size());
  });
});

describe("the budget is respected", () => {
  it("stops taking keys once the budget is spent and resumes next slice", () => {
    const clock = makeTestClock();
    const served: Array<string> = [];
    const scheduler = makeKernelTickScheduler({
      now: clock.now,
      setTimer: clock.setTimer,
      lanes: {
        immediate: {
          process: (key) => {
            served.push(key);
            clock.burn(1.5);
            return "done";
          },
        },
        simulation: idleLane,
        housekeeping: idleLane,
      },
    });

    for (let i = 0; i < 10; i += 1) scheduler.mark("immediate", `k${i}`);
    clock.step();

    // 4 ms budget against 1.5 ms keys: the third starts at 3.0 ms (inside the
    // deadline) and the fourth is refused at 4.5 ms.
    expect(served).toEqual(["k0", "k1", "k2"]);
    expect(scheduler.stats().lanes.immediate.pending).toBe(7);

    clock.step();
    expect(served).toEqual(["k0", "k1", "k2", "k3", "k4", "k5"]);

    clock.step();
    clock.step();
    expect(served).toEqual([
      "k0",
      "k1",
      "k2",
      "k3",
      "k4",
      "k5",
      "k6",
      "k7",
      "k8",
      "k9",
    ]);
    // Ten keys, four slices, nothing dropped: deferred, never lost.
    expect(scheduler.stats().lanes.immediate.pending).toBe(0);
    expect(scheduler.stats().lanes.immediate.slices).toBe(4);
    expect(scheduler.stats().lanes.immediate.processed).toBe(10);
  });

  it("always takes one key, so an overrun cannot stall the lane", () => {
    const clock = makeTestClock();
    const overruns: Array<LaneOverrun> = [];
    const served: Array<string> = [];
    const scheduler = makeKernelTickScheduler({
      now: clock.now,
      setTimer: clock.setTimer,
      onOverrun: (overrun) => overruns.push(overrun),
      lanes: {
        immediate: {
          process: (key) => {
            served.push(key);
            // Nothing can preempt synchronous work. The budget's job here is
            // to NAME the offender, not to stop it mid-flight.
            clock.burn(40);
            return "done";
          },
        },
        simulation: idleLane,
        housekeeping: idleLane,
      },
    });

    scheduler.mark("immediate", "slow-a");
    scheduler.mark("immediate", "slow-b");
    clock.step();

    expect(served).toEqual(["slow-a"]);
    expect(overruns).toEqual([
      { lane: "immediate", key: "slow-a", ms: 40, budgetMs: LANE_BUDGET_MS },
    ]);

    clock.step();
    expect(served).toEqual(["slow-a", "slow-b"]);
    expect(scheduler.stats().lanes.immediate.overruns).toBe(2);
  });

  it("survives a reporter that throws on the overrun it is reporting", () => {
    const clock = makeTestClock();
    const served: Array<string> = [];
    const scheduler = makeKernelTickScheduler({
      now: clock.now,
      setTimer: clock.setTimer,
      // This is the DEFAULT reporter's behaviour under
      // JUNTO_BUDGET=strict, which is the mode a scale gate runs in.
      // The assertion is meant to name a slow key, not to stop the factory.
      onOverrun: (overrun) => {
        throw new Error(`budget: ${overrun.key} took ${overrun.ms}ms`);
      },
      lanes: {
        immediate: {
          process: (key) => {
            served.push(key);
            clock.burn(40);
            return "done";
          },
        },
        simulation: idleLane,
        housekeeping: idleLane,
      },
    });

    scheduler.mark("immediate", "slow-a");
    scheduler.mark("immediate", "slow-b");

    clock.step();
    clock.step();

    // The kernel keeps ticking: the second key is served, the lane drains, and
    // the throwing reporter has not requeued or quarantined anything.
    expect(served).toEqual(["slow-a", "slow-b"]);
    const stats = scheduler.stats().lanes.immediate;
    expect(stats.pending).toBe(0);
    expect(stats.overruns).toBe(2);
    expect(stats.requeued).toBe(0);
    expect(stats.quarantined).toBe(0);
  });

  it("paces a burst with the floor without delaying an idle lane", () => {
    const clock = makeTestClock();
    const served: Array<string> = [];
    const scheduler = makeKernelTickScheduler({
      now: clock.now,
      setTimer: clock.setTimer,
      lanes: {
        immediate: idleLane,
        simulation: {
          process: (key) => {
            served.push(key);
            return "done";
          },
        },
        housekeeping: idleLane,
      },
    });

    // A cold lane spends no floor: the first wake runs on the next turn of the
    // loop. This is the property that keeps today's latency for a lone event.
    scheduler.mark("simulation", "cycle");
    clock.step();
    expect(served).toEqual(["cycle"]);

    // A second wake inside the floor is deferred, not dropped.
    scheduler.mark("simulation", "cycle");
    expect(clock.step()).toBe(false);
    expect(served).toEqual(["cycle"]);

    clock.advance(LANE_FLOOR_MS.simulation - 1);
    expect(clock.step()).toBe(false);
    expect(served).toEqual(["cycle"]);

    clock.advance(1);
    expect(clock.step()).toBe(true);
    expect(served).toEqual(["cycle", "cycle"]);
  });
});

describe("resumption", () => {
  it("never re-runs a suspended lane until its key resumes", () => {
    const clock = makeTestClock();
    const started: Array<string> = [];
    let resumeCurrent: (() => void) | undefined;
    const scheduler = makeKernelTickScheduler({
      now: clock.now,
      setTimer: clock.setTimer,
      lanes: {
        immediate: idleLane,
        simulation: {
          process: (key, resume) => {
            started.push(key);
            resumeCurrent = () => resume();
            return "suspended";
          },
        },
        housekeeping: idleLane,
      },
    });

    scheduler.mark("simulation", "cycle");
    clock.step();
    expect(started).toEqual(["cycle"]);

    // The whole burst that lands mid-pass collapses into ONE queued key — the
    // property the old boolean coalescer had, kept.
    for (let i = 0; i < 50; i += 1) scheduler.mark("simulation", "cycle");
    clock.advance(10_000);
    expect(clock.settle()).toBe(0);
    expect(started).toEqual(["cycle"]);
    expect(scheduler.stats().lanes.simulation.awaiting).toBe(true);

    resumeCurrent?.();
    clock.settle();
    expect(started).toEqual(["cycle", "cycle"]);

    // The second pass consumed the single queued key; it did not retain one
    // retry per event in the burst.
    resumeCurrent?.();
    clock.advance(10_000);
    clock.settle();
    expect(started).toEqual(["cycle", "cycle"]);
  });

  it("ignores a double resume, so two keys can never run at once", () => {
    const clock = makeTestClock();
    const started: Array<string> = [];
    const resumes: Array<() => void> = [];
    const scheduler = makeKernelTickScheduler({
      now: clock.now,
      setTimer: clock.setTimer,
      lanes: {
        immediate: {
          process: (key, resume) => {
            started.push(key);
            resumes.push(() => resume());
            return "suspended";
          },
        },
        simulation: idleLane,
        housekeeping: idleLane,
      },
    });

    scheduler.mark("immediate", "a");
    scheduler.mark("immediate", "b");
    scheduler.mark("immediate", "c");
    clock.step();
    expect(started).toEqual(["a"]);

    const first = resumes[0];
    first?.();
    first?.();
    first?.();
    clock.step();
    expect(started).toEqual(["a", "b"]);
    expect(scheduler.stats().lanes.immediate.pending).toBe(1);
  });

  it("keeps ticking the other lanes while one is suspended", () => {
    const clock = makeTestClock();
    const served: Array<string> = [];
    let resumeSimulation: (() => void) | undefined;
    const scheduler = makeKernelTickScheduler({
      now: clock.now,
      setTimer: clock.setTimer,
      lanes: {
        immediate: {
          process: (key) => {
            served.push(`imm:${key}`);
            clock.burn(1);
            return "done";
          },
        },
        simulation: {
          process: (key, resume) => {
            served.push(`sim:${key}`);
            resumeSimulation = () => resume();
            return "suspended";
          },
        },
        housekeeping: idleLane,
      },
    });

    scheduler.mark("simulation", "cycle");
    clock.step();
    expect(served).toEqual(["sim:cycle"]);

    scheduler.mark("immediate", "canvas:factory");
    clock.step();
    expect(served).toEqual(["sim:cycle", "imm:canvas:factory"]);
    expect(scheduler.stats().lanes.simulation.awaiting).toBe(true);

    // A wake that lands while the lane is suspended is queued, not dropped,
    // and runs once the suspended key resumes and the floor has passed.
    scheduler.mark("simulation", "cycle");
    resumeSimulation?.();
    clock.advance(LANE_FLOOR_MS.simulation);
    clock.step();
    expect(served).toEqual(["sim:cycle", "imm:canvas:factory", "sim:cycle"]);
  });
});

describe("work is never lost", () => {
  it("re-enqueues a key marked while it is being processed", () => {
    const clock = makeTestClock();
    const served: Array<string> = [];
    const scheduler = makeKernelTickScheduler({
      now: clock.now,
      setTimer: clock.setTimer,
      lanes: {
        immediate: {
          process: (key) => {
            served.push(key);
            clock.burn(1);
            // A commit lands on the very canvas being re-read.
            if (served.length === 1) scheduler.mark("immediate", key);
            return "done";
          },
        },
        simulation: idleLane,
        housekeeping: idleLane,
      },
    });

    scheduler.mark("immediate", "canvas:factory");
    clock.settle();

    expect(served).toEqual(["canvas:factory", "canvas:factory"]);
    expect(scheduler.stats().lanes.immediate.pending).toBe(0);
  });

  it("requeues a throwing key once, then quarantines and escalates it", () => {
    const clock = makeTestClock();
    const failures: Array<LaneFailure> = [];
    const attempts: Array<string> = [];
    const scheduler = makeKernelTickScheduler({
      now: clock.now,
      setTimer: clock.setTimer,
      onFailure: (failure) => failures.push(failure),
      lanes: {
        immediate: {
          process: (key) => {
            attempts.push(key);
            clock.burn(3);
            if (key === "broken") throw new Error("boom");
            return "done";
          },
        },
        simulation: idleLane,
        housekeeping: idleLane,
      },
    });

    scheduler.mark("immediate", "broken");
    scheduler.mark("immediate", "healthy");
    clock.step();

    // Requeued at the BACK: the healthy key is not held up by the broken one.
    expect(attempts).toEqual(["broken", "healthy"]);
    expect(failures.map((failure) => failure.disposition)).toEqual([
      "requeued",
    ]);

    clock.step();
    expect(attempts).toEqual(["broken", "healthy", "broken"]);
    expect(failures.map((failure) => failure.disposition)).toEqual([
      "requeued",
      "quarantined",
    ]);
    expect(failures[1]?.key).toBe("broken");
    expect(failures[1]?.attempts).toBe(2);
    // Quarantine stops the key from burning budget forever.
    expect(scheduler.quarantined("immediate")).toEqual(["broken"]);
    expect(scheduler.stats().lanes.immediate.pending).toBe(0);
    expect(clock.step()).toBe(false);

    // A fresh signal re-admits it: repeating work is cheaper than losing it.
    // The streak starts over — requeued once, then quarantined again.
    scheduler.mark("immediate", "broken");
    expect(scheduler.quarantined("immediate")).toEqual([]);
    clock.step();
    expect(attempts.filter((key) => key === "broken")).toHaveLength(4);
    expect(scheduler.quarantined("immediate")).toEqual(["broken"]);
  });

  it("routes an asynchronous failure through the same requeue path", () => {
    const clock = makeTestClock();
    const failures: Array<LaneFailure> = [];
    const attempts: Array<string> = [];
    let resumeCurrent: ((error?: unknown) => void) | undefined;
    const scheduler = makeKernelTickScheduler({
      now: clock.now,
      setTimer: clock.setTimer,
      onFailure: (failure) => failures.push(failure),
      lanes: {
        immediate: idleLane,
        simulation: {
          process: (key, resume) => {
            attempts.push(key);
            resumeCurrent = resume;
            return "suspended";
          },
        },
        housekeeping: idleLane,
      },
    });

    scheduler.mark("simulation", "cycle");
    clock.step();
    expect(attempts).toEqual(["cycle"]);

    resumeCurrent?.(new Error("cycle failed"));
    expect(failures[0]?.disposition).toBe("requeued");
    expect(scheduler.stats().lanes.simulation.awaiting).toBe(false);

    clock.advance(LANE_FLOOR_MS.simulation);
    clock.step();
    expect(attempts).toEqual(["cycle", "cycle"]);
  });

  it("keeps every queued key when the driver is stopped", () => {
    const clock = makeTestClock();
    const served: Array<string> = [];
    const scheduler = makeKernelTickScheduler({
      now: clock.now,
      setTimer: clock.setTimer,
      lanes: {
        immediate: {
          process: (key) => {
            served.push(key);
            return "done";
          },
        },
        simulation: idleLane,
        housekeeping: idleLane,
      },
    });

    scheduler.mark("immediate", "a");
    scheduler.mark("immediate", "b");
    scheduler.stop();
    clock.advance(10_000);
    expect(clock.settle()).toBe(0);

    expect(served).toEqual([]);
    expect(scheduler.pending("immediate")).toEqual(["a", "b"]);
    expect(clock.pendingTimers()).toBe(0);
  });
});

describe("fairness", () => {
  it("serves lanes in priority order when nothing is starving", () => {
    const clock = makeTestClock();
    const served: Array<string> = [];
    const record =
      (label: string): LaneProcess =>
      (key) => {
        served.push(`${label}:${key}`);
        clock.burn(1);
        return "done";
      };
    const scheduler = makeKernelTickScheduler({
      now: clock.now,
      setTimer: clock.setTimer,
      lanes: {
        immediate: { process: record("imm") },
        simulation: { process: record("sim") },
        housekeeping: { process: record("hk") },
      },
    });

    scheduler.mark("housekeeping", "sweep");
    scheduler.mark("simulation", "cycle");
    scheduler.mark("immediate", "canvas:factory");
    clock.step();

    expect(served).toEqual(["imm:canvas:factory"]);
  });

  it("bounds how long a hot immediate lane may starve housekeeping", () => {
    const clock = makeTestClock();
    const served: Array<string> = [];
    const scheduler = makeKernelTickScheduler({
      now: clock.now,
      setTimer: clock.setTimer,
      lanes: {
        // An immediate lane that always has more work waiting.
        // One key spends the whole budget, so one entry below is one slice.
        immediate: {
          process: (key) => {
            served.push("immediate");
            clock.burn(LANE_BUDGET_MS);
            scheduler.mark("immediate", `${key}!`);
            return "done";
          },
        },
        simulation: idleLane,
        // Floor removed so this test measures starvation and nothing else.
        housekeeping: {
          process: (key) => {
            served.push("housekeeping");
            clock.burn(LANE_BUDGET_MS);
            scheduler.mark("housekeeping", key);
            return "done";
          },
          floorMs: 0,
          starvationTicks: 3,
        },
      },
    });

    scheduler.mark("immediate", "hot");
    scheduler.mark("housekeeping", "audit");
    for (let i = 0; i < 40; i += 1) clock.step();

    // The drift audit — the one job whose purpose is to notice that something
    // else is wrong — is served despite a lane that never empties.
    expect(served).toContain("housekeeping");
    expect(served).toContain("immediate");

    let gap = 0;
    let worstGap = 0;
    for (const lane of served) {
      if (lane === "housekeeping") {
        worstGap = Math.max(worstGap, gap);
        gap = 0;
        continue;
      }
      gap += 1;
    }
    expect(worstGap).toBeLessThanOrEqual(3);
    expect(served.filter((lane) => lane === "housekeeping").length)
      .toBeGreaterThanOrEqual(8);
  });

  it("does not count a lane inside its floor as starving", () => {
    const clock = makeTestClock();
    const served: Array<string> = [];
    const scheduler = makeKernelTickScheduler({
      now: clock.now,
      setTimer: clock.setTimer,
      lanes: {
        immediate: {
          process: (key) => {
            served.push("immediate");
            clock.burn(0.2);
            scheduler.mark("immediate", `${key}!`);
            return "done";
          },
        },
        simulation: {
          process: () => {
            served.push("simulation");
            clock.burn(0.2);
            return "done";
          },
        },
        housekeeping: idleLane,
      },
    });

    scheduler.mark("immediate", "hot");
    scheduler.mark("simulation", "cycle");
    // Promotion serves the simulation lane despite the hot immediate lane.
    for (let i = 0; i < 6; i += 1) clock.step();
    const simulationSlices = () =>
      served.filter((lane) => lane === "simulation").length;
    expect(simulationSlices()).toBe(1);

    // Now it must WAIT OUT ITS CADENCE. Ten slices of ~4 ms is well under the
    // 100 ms floor, and starvation must not promote it inside that window.
    scheduler.mark("simulation", "cycle");
    for (let i = 0; i < 10; i += 1) clock.step();
    expect(simulationSlices()).toBe(1);
    expect(clock.now()).toBeLessThan(1_000 + LANE_FLOOR_MS.simulation);

    clock.advance(LANE_FLOOR_MS.simulation);
    for (let i = 0; i < 6; i += 1) clock.step();
    expect(simulationSlices()).toBe(2);
  });
});
