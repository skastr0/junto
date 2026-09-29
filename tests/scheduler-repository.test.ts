import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, test } from "vitest";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import {
  makeSchedulerRepositoryLive,
  SchedulerRepository,
  type SchedulerRepositoryOptions,
} from "../src/main/junto/scheduler/repository";

const run = async <A, E>(
  program: Effect.Effect<A, E, SchedulerRepository | SqlClient.SqlClient>,
  options: SchedulerRepositoryOptions = {},
) => {
  const root = await mkdtemp(join(tmpdir(), "junto-scheduler-sql-"));
  const runtime = ManagedRuntime.make(makeSchedulerRepositoryLive({
    makeScheduleId: () => "schedule-a", ...options,
  }).pipe(Layer.provideMerge(makeStateEngineLive(join(root, "junto.db")))));
  try {
    return await runtime.runPromise(program);
  } finally {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
};

const interval = (home = "local", key = "timer-a", now = 1_000) => ({
  localStationId: home, homeStationIds: [home], timerKey: key, nowEpochMs: now, everyMinutes: 1,
});

test("interval claims coalesce once and reconciliation retains only active local cursors", () => run(Effect.gen(function* () {
  const repository = yield* SchedulerRepository;
  const sql = yield* SqlClient.SqlClient;
  expect(yield* repository.claimInterval(interval())).toMatchObject({
    _tag: "Initialized", state: { nextDueAtEpochMs: 61_000, nextDueSlot: "0" },
  });
  expect(yield* repository.claimInterval(interval("local", "timer-a", 60_999))).toMatchObject({ _tag: "NotDue" });
  const claims = yield* Effect.all([
    repository.claimInterval(interval("local", "timer-a", 181_002)),
    repository.claimInterval(interval("local", "timer-a", 181_002)),
  ], { concurrency: "unbounded" });
  expect(claims.map((claim) => claim._tag).sort()).toEqual(["Firing", "NotDue"]);
  expect(yield* repository.readIntervalState("local", "timer-a")).toEqual({
    version: 1, scheduleId: "schedule-a", intervalMilliseconds: 60_000, catchUpPolicy: "coalesce-latest",
    nextDueAtEpochMs: 241_000, nextDueSlot: "3", lastFiredSlot: "2",
  });
  expect(yield* sql`SELECT claim_slot, due_slot, scheduled_for_epoch_ms, observed_at_epoch_ms, coalesced_missed_slots
    FROM scheduler_interval_firings`.values).toEqual([["0", "2", 181_000, 181_002, "2"]]);
  yield* repository.claimInterval(interval("local", "timer-drop"));
  yield* repository.claimInterval(interval("remote", "timer-a"));
  expect(yield* repository.reconcileHome("local", ["timer-a"])).toBe(2);
  expect(yield* sql`SELECT home_station, timer_key FROM scheduler_interval_state`.values).toEqual([["local", "timer-a"]]);
  expect(yield* sql`SELECT count(*) FROM scheduler_interval_firings`.values).toEqual([[1]]);
})));

test("expression claims deduplicate the full identity without interval cursors", () => run(Effect.gen(function* () {
  const repository = yield* SchedulerRepository;
  const sql = yield* SqlClient.SqlClient;
  const input = {
    homeStation: "local", timerKey: "cron-a", scheduleId: "weekday", dueAtEpochMs: 100,
    nextDueAtEpochMs: 700, nowEpochMs: 113,
  };
  expect(yield* repository.claimExpression(input)).toEqual({ _tag: "Claimed", dueAtEpochMs: 100, nextDueAtEpochMs: 700 });
  expect(yield* repository.claimExpression(input)).toEqual({ _tag: "Duplicate" });
  expect(yield* repository.claimExpression({ ...input, homeStation: "remote" })).toMatchObject({ _tag: "Claimed" });
  expect(yield* repository.claimExpression({ ...input, scheduleId: "weekend" })).toMatchObject({ _tag: "Claimed" });
  expect(yield* repository.claimExpression({ ...input, nextDueAtEpochMs: 100 })).toEqual({
    _tag: "Ineligible", reason: "invalid-expression-claim",
  });
  expect(yield* sql`SELECT home_station, schedule_id, claim_slot, due_slot, coalesced_missed_slots
    FROM scheduler_interval_firings ORDER BY home_station, schedule_id`.values).toEqual([
    ["local", "weekday", "100", "100", "0"], ["local", "weekend", "100", "100", "0"],
    ["remote", "weekday", "100", "100", "0"],
  ]);
  expect(yield* repository.readIntervalState("local", "cron-a")).toBeUndefined();
})));

test("a failed cursor update rolls back its firing and invalid cursors stay typed failures", async () => {
  let timestampCalls = 0;
  await run(Effect.gen(function* () {
    const repository = yield* SchedulerRepository;
    const sql = yield* SqlClient.SqlClient;
    yield* repository.claimInterval(interval());
    expect(yield* Effect.result(repository.claimInterval(interval("local", "timer-a", 61_000)))).toMatchObject({
      _tag: "Failure", failure: { _tag: "SchedulerPersistenceError", operation: "claim-interval", message: "clock unavailable" },
    });
    expect(yield* sql`SELECT count(*) FROM scheduler_interval_firings`.values).toEqual([[0]]);
    expect(yield* repository.readIntervalState("local", "timer-a")).toMatchObject({ nextDueAtEpochMs: 61_000, nextDueSlot: "0" });
    expect(yield* repository.claimInterval(interval("local", "timer-a", 61_000))).toMatchObject({ _tag: "Firing" });
    yield* sql`UPDATE scheduler_interval_state SET next_due_slot = '7', last_fired_slot = '1'`;
    expect(yield* Effect.result(repository.readIntervalState("local", "timer-a"))).toMatchObject({
      _tag: "Failure", failure: { _tag: "SchedulerStateCorruptError", homeStation: "local", timerKey: "timer-a" },
    });
  }), { now: (epoch) => {
    if (++timestampCalls === 3) throw new Error("clock unavailable");
    return new Date(epoch).toISOString();
  } });
});
