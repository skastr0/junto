/**
 * Cycle-rate probe for the kernel scheduler. GATE_PROBE=1 guarded so a normal
 * `bun run test` skips it.
 *
 * The defect this measures: the OLD coalescer re-ran a full world pass the
 * instant the previous one finished whenever any event had arrived during it.
 * Under a steady event stream that is a continuous loop with no floor — the
 * cycle rate is set by how long a cycle takes, not by anything anyone chose.
 *
 * Both schedulers run here against the same synthetic load, on REAL timers,
 * with a cycle that holds the main thread for a fixed span. What is reported is
 * cycles started, main-thread duty, and the longest gap the event loop got.
 *
 *   GATE_PROBE=1 npx vitest run tests/__probe/kernel-tick-rate.test.ts
 *   TICK_CYCLE_MS=20 TICK_EVENT_MS=5 TICK_RUN_MS=2000  (defaults shown)
 */
import { describe, expect, it } from "vitest";
import { Cause, Effect } from "effect";

import {
  KERNEL_CYCLE_KEY,
  makeKernelLaneScheduler,
} from "../../src/main/vellum-command/kernel/service";

const CYCLE_MS = Number(process.env.TICK_CYCLE_MS ?? 20);
const EVENT_MS = Number(process.env.TICK_EVENT_MS ?? 5);
const RUN_MS = Number(process.env.TICK_RUN_MS ?? 2_000);

/** Hold the thread the way a real world pass does. */
const block = (ms: number): void => {
  const startedAt = performance.now();
  while (performance.now() - startedAt < ms) {
    // spin
  }
};

/**
 * The scheduler this change replaced, verbatim from commit 10ac58cf, so the
 * comparison is against the shipped code rather than a paraphrase of it.
 */
const makeOldCoalescer = (
  runCycle: Effect.Effect<void, unknown>,
  fork: <A, E>(effect: Effect.Effect<A, E>) => void,
): (() => void) => {
  let cycleInFlight = false;
  let cycleQueued = false;
  const scheduleCycle = (): void => {
    if (cycleInFlight) {
      cycleQueued = true;
      return;
    }
    cycleInFlight = true;
    fork(
      runCycle.pipe(
        Effect.catchCause((cause) => {
          console.error("[kernel] cycle failed:", Cause.squash(cause));
          return Effect.void;
        }),
        Effect.ensuring(
          Effect.sync(() => {
            cycleInFlight = false;
            if (cycleQueued) {
              cycleQueued = false;
              scheduleCycle();
            }
          }),
        ),
      ),
    );
  };
  return scheduleCycle;
};

type Run = {
  readonly label: string;
  readonly cycles: number;
  readonly cyclesPerSec: number;
  readonly dutyPct: number;
  readonly longestIdleGapMs: number;
  readonly events: number;
};

const drive = async (
  label: string,
  makeSchedule: (runCycle: Effect.Effect<void, unknown>) => () => void,
): Promise<Run> => {
  let cycles = 0;
  let busyMs = 0;
  let lastEndedAt = performance.now();
  let longestIdleGapMs = 0;
  let events = 0;

  // A world pass is not one synchronous block: it awaits SQLite, IPC and the
  // work plane. Two spans with a yield between them is the honest shape.
  const runCycle: Effect.Effect<void, unknown> = Effect.gen(function* () {
    yield* Effect.sync(() => {
      const idle = performance.now() - lastEndedAt;
      if (idle > longestIdleGapMs) longestIdleGapMs = idle;
      cycles += 1;
      block(CYCLE_MS / 2);
      busyMs += CYCLE_MS / 2;
    });
    yield* Effect.promise(
      () => new Promise((resolve) => setImmediate(resolve)),
    );
    yield* Effect.sync(() => {
      block(CYCLE_MS / 2);
      busyMs += CYCLE_MS / 2;
      lastEndedAt = performance.now();
    });
  });

  const schedule = makeSchedule(runCycle);
  const startedAt = performance.now();
  lastEndedAt = startedAt;
  await new Promise<void>((resolve) => {
    const stream = setInterval(() => {
      events += 1;
      schedule();
      if (performance.now() - startedAt >= RUN_MS) {
        clearInterval(stream);
        resolve();
      }
    }, EVENT_MS);
  });
  const observedMs = performance.now() - startedAt;

  return {
    label,
    cycles,
    cyclesPerSec: Number(((cycles * 1000) / observedMs).toFixed(2)),
    dutyPct: Number(((busyMs / observedMs) * 100).toFixed(1)),
    longestIdleGapMs: Number(longestIdleGapMs.toFixed(2)),
    events,
  };
};

describe.skipIf(process.env.GATE_PROBE !== "1")("kernel cycle rate", () => {
  it("compares the replaced coalescer against the lane scheduler", async () => {
    const fork = <A, E>(effect: Effect.Effect<A, E>): void => {
      void Effect.runPromise(effect as Effect.Effect<unknown, unknown>);
    };

    const before = await drive("old coalescer", (runCycle) =>
      makeOldCoalescer(runCycle, fork),
    );

    const after = await drive("lane scheduler", (runCycle) => {
      const scheduler = makeKernelLaneScheduler({
        runCycle,
        resyncCanvas: () => Effect.void,
        fork,
      });
      return () => scheduler.mark("simulation", KERNEL_CYCLE_KEY);
    });

    console.log(JSON.stringify({ kind: "tick.rate", before, after }));
    // The floor is the whole point: the same event stream must no longer be
    // able to drive the cycle as fast as a cycle happens to take.
    expect(after.cycles).toBeLessThan(before.cycles);
    expect(after.longestIdleGapMs).toBeGreaterThan(before.longestIdleGapMs);
  });
});
