import {
  evaluateIntervalTimer,
  initializeIntervalTimer,
  type IntervalTimerState,
} from "../../src/shared/scheduler-policy";
import type {
  SchedulerClaimInput,
  SchedulerClaimResult,
} from "../../src/main/vellum/scheduler/repository";
import type { TimerSchedulerDeps } from "../../src/main/vellum/kernel/cycle";

/**
 * Test-only scheduler driver. Production always binds the SQLite repository;
 * cycle unit tests use this deterministic in-memory implementation so they
 * exercise the same pure policy without opening a second app database.
 */
export const makeInMemoryTimerScheduler = (): TimerSchedulerDeps => {
  const states = new Map<string, IntervalTimerState>();
  let schedule = 0;

  const claimInterval = async (
    input: SchedulerClaimInput,
  ): Promise<SchedulerClaimResult> => {
    const home =
      input.homeStationIds.length === 1 &&
      typeof input.homeStationIds[0] === "string"
        ? input.homeStationIds[0]
        : "";
    const timerKey =
      typeof input.timerKey === "string" ? input.timerKey : "";
    const key = `${home}\u0000${timerKey}`;
    let state = states.get(key);
    const requestedInterval =
      typeof input.everyMinutes === "number"
        ? input.everyMinutes * 60_000
        : Number.NaN;

    if (
      state === undefined ||
      state.intervalMilliseconds !== requestedInterval
    ) {
      const initialized = initializeIntervalTimer({
        scheduleId: `test-schedule-${++schedule}`,
        nowEpochMs: input.nowEpochMs,
        everyMinutes: input.everyMinutes,
      });
      if (initialized._tag === "Ineligible") return initialized;
      const admitted = evaluateIntervalTimer({
        ...input,
        state: initialized.state,
      });
      if (admitted._tag === "Ineligible") return admitted;
      states.set(key, initialized.state);
      return {
        _tag: "Initialized",
        state: initialized.state,
      };
    }

    const evaluated = evaluateIntervalTimer({ ...input, state });
    if (evaluated._tag === "Firing") {
      states.set(key, evaluated.nextState);
    }
    return evaluated;
  };

  return {
    claimInterval,
    reconcileHome: async (homeStation, activeTimerKeys) => {
      const active = new Set(
        activeTimerKeys.map((timerKey) => `${homeStation}\u0000${timerKey}`),
      );
      let removed = 0;
      for (const key of [...states.keys()]) {
        if (active.has(key)) continue;
        states.delete(key);
        removed += 1;
      }
      return removed;
    },
  };
};
