/**
 * The budgeted, resumable tick — three lanes, one driver, one hard budget.
 *
 * WHAT THIS REPLACES. The kernel used to coalesce wakes with a boolean pair:
 * one cycle in flight, one bit remembering that something arrived while it
 * ran, and an IMMEDIATE re-run when the cycle finished. That is an unbounded
 * loop with no floor — a steady event stream re-arms the next pass before the
 * event loop is ever handed back, so the main thread runs a full-world pass
 * back to back forever, and nothing bounds how long any one pass may block.
 *
 * THE SHAPE. Work is named by a KEY, never by a closure. Re-marking a key that
 * is already queued is a no-op, so a burst of a thousand events on one entity
 * enqueues exactly one unit of work: the queue length is bounded by the
 * world's entity count rather than by the event rate. That is what makes
 * "deferred, never lost" both true and cheap.
 *
 *   tick(lane):
 *     deadline = now() + BUDGET[lane]
 *     while queue nonempty and now() < deadline: process(queue.take())
 *     if queue nonempty: schedule(lane)      // resumed next tick, never dropped
 *
 * THREE LANES, one synchronous slice at a time:
 *
 *   | lane         | floor  | budget | work                                    |
 *   |--------------|--------|--------|-----------------------------------------|
 *   | immediate    | 0 ms   | 4 ms   | the committed delta; operator-blocking  |
 *   | simulation   | 100 ms | 4 ms   | claim selection, delivery, seat wake    |
 *   | housekeeping | 1 s    | 4 ms   | drift audit, sweeps, repair             |
 *
 * The floor is a MINIMUM SPACING between two slices of the same lane, measured
 * from the last time that lane was served — not a delay added to a wake. A
 * lane that has been idle longer than its floor runs on the next turn of the
 * event loop, so an isolated event keeps today's latency; only a burst is
 * paced. That is the floor the old scheduler did not have.
 *
 * THE BUDGET IS THE 4 ms INVARIANT. No synchronous main-thread operation may
 * exceed 4 ms at any factory size. A slice stops taking new keys once the
 * budget is spent and resumes on the next tick. It cannot preempt a key that
 * is already running — nothing can preempt synchronous JavaScript — so a key
 * that overruns on its own is reported through `onOverrun`, which is exactly
 * the regression signal the budget exists to produce.
 *
 * FAIRNESS is two separate guarantees:
 *   - within a lane: FIFO over set members, so an early key is served before a
 *     later one and a hot key cannot jump the line by being re-marked.
 *   - across lanes: lanes are served in priority order, but a lane that is
 *     eligible and passed over `starvationTicks` times in a row is promoted
 *     ahead of every higher-priority lane. A hot immediate lane therefore
 *     cannot starve the housekeeping audit — the one piece of work whose whole
 *     purpose is to notice that something else is wrong.
 *
 * ASYNCHRONOUS WORK. A key whose processing is asynchronous returns
 * "suspended" and owns its lane until it calls `resume`. The lane's other keys
 * wait; the other lanes keep ticking. The scheduler never touches a Promise:
 * the caller supplies the completion (the kernel binds `resume` through
 * `Effect.ensuring`), so the factory control plane stays Effect-shaped exactly
 * as V4-PROGRAM requires.
 *
 * FAILURE. A key that throws is requeued once, at the back. A second failure
 * quarantines it and escalates through `onFailure` — the work stops burning
 * budget, and it stops silently. A later `mark` of a quarantined key re-admits
 * it: a fresh signal is new information, and losing work is worse than
 * repeating it.
 */

import { performance } from "node:perf_hooks";

/** Priority order. Index 0 is served first when nothing is starving. */
export const KERNEL_LANES = [
  "immediate",
  "simulation",
  "housekeeping",
] as const;

export type KernelLane = (typeof KERNEL_LANES)[number];

/**
 * The invariant, as one number: no synchronous main-thread operation may
 * exceed this at any factory size.
 */
export const LANE_BUDGET_MS = 4;

/** Minimum spacing between two slices of the same lane. */
export const LANE_FLOOR_MS: Readonly<Record<KernelLane, number>> = {
  immediate: 0,
  simulation: 100,
  housekeeping: 1_000,
};

/**
 * How many consecutive eligible-but-passed-over slices a lane tolerates before
 * it is promoted ahead of higher-priority lanes. `immediate` is first in
 * priority order and can never be passed over, so its value is inert.
 */
export const LANE_STARVATION_TICKS: Readonly<Record<KernelLane, number>> = {
  immediate: 1,
  simulation: 4,
  housekeeping: 8,
};

/**
 * An insertion-ordered dirty set. `mark` of a member already queued is a
 * no-op, so queue length is bounded by entity count, never by event rate.
 *
 * Backed by an array plus a membership set rather than iterating a `Set`, so
 * `take` is O(1) with no dependence on how a runtime compacts deleted slots.
 */
export type DirtyQueue = {
  /** Enqueue. Returns false when the key was already pending. */
  readonly mark: (key: string) => boolean;
  /** Oldest pending key, removed. Undefined when empty. */
  readonly take: () => string | undefined;
  readonly has: (key: string) => boolean;
  readonly size: () => number;
  /** Pending keys, oldest first. */
  readonly keys: () => ReadonlyArray<string>;
};

/** Compact the backing array once the consumed prefix dominates it. */
const QUEUE_COMPACT_FLOOR = 32;

export const makeDirtyQueue = (): DirtyQueue => {
  let order: Array<string> = [];
  let head = 0;
  const members = new Set<string>();

  const mark = (key: string): boolean => {
    if (members.has(key)) return false;
    members.add(key);
    order.push(key);
    return true;
  };

  const take = (): string | undefined => {
    if (head >= order.length) return undefined;
    const key = order[head];
    head += 1;
    if (key !== undefined) members.delete(key);
    if (head >= QUEUE_COMPACT_FLOOR && head * 2 >= order.length) {
      order = order.slice(head);
      head = 0;
    }
    return key;
  };

  return {
    mark,
    take,
    has: (key) => members.has(key),
    size: () => order.length - head,
    keys: () => order.slice(head),
  };
};

/**
 * What a lane's processor reports about the key it was handed.
 *
 * - `done` — the key was processed to completion inside this synchronous
 *   slice. The lane continues with the next key while budget remains.
 * - `suspended` — the key started asynchronous work that owns the lane. No
 *   further key on this lane is served until `resume` is called.
 */
export type LaneOutcome = "done" | "suspended";

/**
 * Reopen a suspended lane. Idempotent: a second call is ignored, so a double
 * completion cannot let two keys run at once. Passing an error routes the key
 * through the same requeue-once-then-quarantine path a synchronous throw takes.
 */
export type LaneResume = (error?: unknown) => void;

export type LaneProcess = (key: string, resume: LaneResume) => LaneOutcome;

export type LaneDefinition = {
  readonly process: LaneProcess;
  readonly budgetMs?: number;
  readonly floorMs?: number;
  readonly starvationTicks?: number;
};

export type LaneFailure = {
  readonly lane: KernelLane;
  readonly key: string;
  readonly error: unknown;
  readonly attempts: number;
  readonly disposition: "requeued" | "quarantined";
};

/** A single key held the main thread past its lane's budget. */
export type LaneOverrun = {
  readonly lane: KernelLane;
  readonly key: string;
  readonly ms: number;
  readonly budgetMs: number;
};

export type LaneStats = {
  readonly pending: number;
  readonly processed: number;
  readonly slices: number;
  readonly overruns: number;
  readonly requeued: number;
  readonly quarantined: number;
  /** Consecutive eligible slices this lane was passed over. */
  readonly waitedTicks: number;
  /** True while a suspended key owns the lane. */
  readonly awaiting: boolean;
};

export type TickStats = {
  readonly slices: number;
  readonly lanes: Readonly<Record<KernelLane, LaneStats>>;
};

/** Cancels a pending timer. */
export type TickTimerCancel = () => void;

export type TickSchedulerOptions = {
  readonly lanes: Readonly<Record<KernelLane, LaneDefinition>>;
  readonly now?: () => number;
  /** Timer seam. Tests drive a manual clock through this. */
  readonly setTimer?: (delayMs: number, run: () => void) => TickTimerCancel;
  readonly onFailure?: (failure: LaneFailure) => void;
  readonly onOverrun?: (overrun: LaneOverrun) => void;
};

export type KernelTickScheduler = {
  /** Enqueue a key. Marking a pending key is a no-op. */
  readonly mark: (lane: KernelLane, key: string) => void;
  /** Pending keys on a lane, oldest first. */
  readonly pending: (lane: KernelLane) => ReadonlyArray<string>;
  readonly quarantined: (lane: KernelLane) => ReadonlyArray<string>;
  readonly stats: () => TickStats;
  /**
   * Stop the driver. Queues are retained but no further slice runs; the kernel
   * calls this from its monotonic suspend, which has no resume path.
   */
  readonly stop: () => void;
};

type LaneState = {
  readonly definition: LaneDefinition;
  readonly budgetMs: number;
  readonly floorMs: number;
  readonly starvationTicks: number;
  readonly queue: DirtyQueue;
  readonly attempts: Map<string, number>;
  readonly quarantined: Set<string>;
  servedAt: number;
  waitedTicks: number;
  awaiting: boolean;
  processed: number;
  slices: number;
  overruns: number;
  requeued: number;
  quarantineCount: number;
};

const defaultTimer = (
  delayMs: number,
  run: () => void,
): TickTimerCancel => {
  const timer = setTimeout(run, delayMs);
  timer.unref?.();
  return () => clearTimeout(timer);
};

/** A failure is escalated, never swallowed — an unreported lane is a lie. */
const defaultFailure = (failure: LaneFailure): void => {
  console.error(
    `[kernel-tick] ${failure.lane} lane ${failure.disposition} "${failure.key}" after ${failure.attempts} failure(s):`,
    failure.error,
  );
};

export const makeKernelTickScheduler = (
  options: TickSchedulerOptions,
): KernelTickScheduler => {
  // performance.now(), not Date.now(): a 4 ms budget cannot be measured with
  // 1 ms granularity, and a monotonic clock cannot be moved by an NTP step.
  const now = options.now ?? (() => performance.now());
  const setTimer = options.setTimer ?? defaultTimer;
  const onFailure = options.onFailure ?? defaultFailure;
  const onOverrun = options.onOverrun;

  const lanes = {} as Record<KernelLane, LaneState>;
  for (const lane of KERNEL_LANES) {
    const definition = options.lanes[lane];
    lanes[lane] = {
      definition,
      budgetMs: definition.budgetMs ?? LANE_BUDGET_MS,
      floorMs: definition.floorMs ?? LANE_FLOOR_MS[lane],
      starvationTicks:
        definition.starvationTicks ?? LANE_STARVATION_TICKS[lane],
      queue: makeDirtyQueue(),
      attempts: new Map(),
      quarantined: new Set(),
      // Never served: the first mark on a cold lane must run immediately
      // rather than wait out a floor it never spent.
      servedAt: Number.NEGATIVE_INFINITY,
      waitedTicks: 0,
      awaiting: false,
      processed: 0,
      slices: 0,
      overruns: 0,
      requeued: 0,
      quarantineCount: 0,
    };
  }

  let slices = 0;
  let stopped = false;
  let cancelTimer: TickTimerCancel | undefined;
  let timerDueAt = Number.POSITIVE_INFINITY;

  /** A lane holds work it is allowed to start. */
  const laneReady = (state: LaneState): boolean =>
    !state.awaiting && state.queue.size() > 0;

  /** The earliest moment a ready lane may take its next slice. */
  const eligibleAt = (state: LaneState): number =>
    state.servedAt === Number.NEGATIVE_INFINITY
      ? Number.NEGATIVE_INFINITY
      : state.servedAt + state.floorMs;

  const clearTimer = (): void => {
    cancelTimer?.();
    cancelTimer = undefined;
    timerDueAt = Number.POSITIVE_INFINITY;
  };

  const wake = (): void => {
    if (stopped) return;
    let earliest = Number.POSITIVE_INFINITY;
    for (const lane of KERNEL_LANES) {
      const state = lanes[lane];
      if (!laneReady(state)) continue;
      earliest = Math.min(earliest, eligibleAt(state));
    }
    if (earliest === Number.POSITIVE_INFINITY) {
      clearTimer();
      return;
    }
    const at = now();
    const delayMs = Math.max(0, earliest - at);
    const dueAt = at + delayMs;
    // An already-armed timer that fires no later than this one is the timer we
    // want; re-arming on every mark would turn a burst into timer churn.
    if (cancelTimer !== undefined && timerDueAt <= dueAt) return;
    clearTimer();
    timerDueAt = dueAt;
    cancelTimer = setTimer(delayMs, fire);
  };

  /**
   * Priority order, except that a lane starved past its tolerance is promoted
   * ahead of every higher-priority lane. Ties break on who waited longest,
   * then on priority.
   */
  const pickLane = (at: number): KernelLane | undefined => {
    let chosen: KernelLane | undefined;
    let chosenWaited = -1;
    for (const lane of KERNEL_LANES) {
      const state = lanes[lane];
      if (!laneReady(state) || eligibleAt(state) > at) continue;
      const starving = state.waitedTicks >= state.starvationTicks;
      if (!starving) {
        if (chosen === undefined) chosen = lane;
        continue;
      }
      if (state.waitedTicks > chosenWaited) {
        chosen = lane;
        chosenWaited = state.waitedTicks;
      }
    }
    return chosen;
  };

  const settleFailure = (
    lane: KernelLane,
    state: LaneState,
    key: string,
    error: unknown,
  ): void => {
    const attempts = (state.attempts.get(key) ?? 0) + 1;
    if (attempts >= 2) {
      state.attempts.delete(key);
      state.quarantined.add(key);
      state.quarantineCount += 1;
      onFailure({ lane, key, error, attempts, disposition: "quarantined" });
      return;
    }
    state.attempts.set(key, attempts);
    state.requeued += 1;
    state.queue.mark(key);
    onFailure({ lane, key, error, attempts, disposition: "requeued" });
    wake();
  };

  const runLane = (lane: KernelLane): void => {
    const state = lanes[lane];
    const startedAt = now();
    state.servedAt = startedAt;
    state.waitedTicks = 0;
    state.slices += 1;
    slices += 1;
    const deadline = startedAt + state.budgetMs;
    let processed = 0;

    while (state.queue.size() > 0) {
      // Always take one key: a slice that took nothing would spin forever
      // whenever a previous key already spent the budget.
      if (processed > 0 && now() >= deadline) break;
      const key = state.queue.take();
      if (key === undefined) break;

      const keyStartedAt = now();
      let outcome: LaneOutcome = "done";
      let resumed = false;
      let returned = false;
      let threw = false;

      const resume: LaneResume = (error) => {
        if (resumed) return;
        resumed = true;
        if (error !== undefined) settleFailure(lane, state, key, error);
        else state.attempts.delete(key);
        // Reopen the lane only when it was actually suspended. A processor
        // that resumed before returning never suspended it.
        if (returned && outcome === "suspended") {
          state.awaiting = false;
          wake();
        }
      };

      try {
        outcome = state.definition.process(key, resume);
      } catch (error) {
        threw = true;
        outcome = "done";
        settleFailure(lane, state, key, error);
      } finally {
        returned = true;
      }

      const ms = now() - keyStartedAt;
      state.processed += 1;
      processed += 1;
      const overran = ms > state.budgetMs;
      if (overran) state.overruns += 1;

      // Settle the key BEFORE anything observational runs, so no reporter can
      // leave the lane holding a half-retired key.
      const suspended = outcome === "suspended";
      if (suspended && !resumed) state.awaiting = true;
      else if (!suspended && !threw && !resumed) state.attempts.delete(key);

      // Reporting an overrun must never kill the driver. The default reporter
      // is `noteSyncSpan`, which THROWS under VELLUM_COMMAND_BUDGET=strict --
      // exactly the mode a scale gate or regression hunt runs in. An escape
      // here would skip the trailing wake() in fire() and the kernel would
      // stop ticking, silently, on the first slow key. The violation is
      // recorded and reported before that throw, so nothing is lost.
      if (overran) {
        try {
          onOverrun?.({ lane, key, ms, budgetMs: state.budgetMs });
        } catch {
          // An observer must never break the operation it is watching.
        }
      }

      if (suspended) {
        if (resumed) continue;
        break;
      }
    }
  };

  function fire(): void {
    cancelTimer = undefined;
    timerDueAt = Number.POSITIVE_INFINITY;
    if (stopped) return;
    const at = now();
    const lane = pickLane(at);
    try {
      if (lane !== undefined) {
        for (const other of KERNEL_LANES) {
          const state = lanes[other];
          if (other === lane) continue;
          // Only an ELIGIBLE lane is starving. A lane still inside its floor
          // is waiting by cadence, and counting that would break its cadence.
          if (laneReady(state) && eligibleAt(state) <= at) {
            state.waitedTicks += 1;
          }
        }
        runLane(lane);
      }
    } finally {
      // The driver re-arms whatever happened inside the slice. A throw still
      // escapes to the host -- it is a real bug and must stay loud -- but it
      // costs one slice, not every slice after it.
      wake();
    }
  }

  return {
    mark: (lane, key) => {
      const state = lanes[lane];
      // A fresh signal re-admits a quarantined key. Repeating work is cheap;
      // losing it is not.
      state.quarantined.delete(key);
      if (!state.queue.mark(key)) return;
      wake();
    },
    pending: (lane) => lanes[lane].queue.keys(),
    quarantined: (lane) => [...lanes[lane].quarantined],
    stats: () => {
      const byLane = {} as Record<KernelLane, LaneStats>;
      for (const lane of KERNEL_LANES) {
        const state = lanes[lane];
        byLane[lane] = {
          pending: state.queue.size(),
          processed: state.processed,
          slices: state.slices,
          overruns: state.overruns,
          requeued: state.requeued,
          quarantined: state.quarantineCount,
          waitedTicks: state.waitedTicks,
          awaiting: state.awaiting,
        };
      }
      return { slices, lanes: byLane };
    },
    stop: () => {
      stopped = true;
      clearTimer();
    },
  };
};
