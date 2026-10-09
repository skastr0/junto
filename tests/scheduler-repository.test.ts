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
import { OTHER_MACHINE, THIS_MACHINE } from "./support/machines";

const run = async <A, E>(
  program: Effect.Effect<A, E, SchedulerRepository | SqlClient.SqlClient>,
  options: SchedulerRepositoryOptions = {},
) => {
  const root = await mkdtemp(join(tmpdir(), "junto-scheduler-sql-"));
  const runtime = ManagedRuntime.make(makeSchedulerRepositoryLive(options).pipe(Layer.provideMerge(makeStateEngineLive(join(root, "junto.db")))));
  try {
    return await runtime.runPromise(program);
  } finally {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
};

test("expression claims deduplicate the full identity", () => run(Effect.gen(function* () {
  const repository = yield* SchedulerRepository;
  const sql = yield* SqlClient.SqlClient;
  const input = {
    homeStation: THIS_MACHINE, timerKey: "cron-a", scheduleId: "weekday", dueAtEpochMs: 100,
    nextDueAtEpochMs: 700, nowEpochMs: 113,
  };
  expect(yield* repository.claimExpression(input)).toEqual({ _tag: "Claimed", dueAtEpochMs: 100, nextDueAtEpochMs: 700 });
  expect(yield* repository.claimExpression(input)).toEqual({ _tag: "Duplicate" });
  expect(yield* repository.claimExpression({ ...input, homeStation: OTHER_MACHINE })).toMatchObject({ _tag: "Claimed" });
  expect(yield* repository.claimExpression({ ...input, scheduleId: "weekend" })).toMatchObject({ _tag: "Claimed" });
  expect(yield* repository.claimExpression({ ...input, nextDueAtEpochMs: 100 })).toEqual({
    _tag: "Ineligible", reason: "invalid-expression-claim",
  });
  expect(yield* sql`SELECT home_station, schedule_id, claim_slot, due_slot, coalesced_missed_slots
    FROM scheduler_interval_firings ORDER BY home_station, schedule_id`.values).toEqual([
    [OTHER_MACHINE, "weekday", "100", "100", "0"],
    [THIS_MACHINE, "weekday", "100", "100", "0"], [THIS_MACHINE, "weekend", "100", "100", "0"],
  ]);
})));

test("a failed claim leaves no firing behind", async () => {
  await run(Effect.gen(function* () {
    const repository = yield* SchedulerRepository;
    const sql = yield* SqlClient.SqlClient;
    expect(yield* Effect.result(repository.claimExpression({
      homeStation: THIS_MACHINE, timerKey: "cron-a", scheduleId: "weekday", dueAtEpochMs: 100,
      nextDueAtEpochMs: 700, nowEpochMs: 113,
    }))).toMatchObject({
      _tag: "Failure", failure: { _tag: "SchedulerPersistenceError", operation: "claim-expression", message: "clock unavailable" },
    });
    expect(yield* sql`SELECT count(*) FROM scheduler_interval_firings`.values).toEqual([[0]]);
  }), { now: () => {
    throw new Error("clock unavailable");
  } });
});

test("reconciliation refuses an invalid home or timer key", () => run(Effect.gen(function* () {
  const repository = yield* SchedulerRepository;
  expect(yield* repository.reconcileHome(THIS_MACHINE, ["factory::cron-a"])).toBe(0);
  expect(yield* Effect.result(repository.reconcileHome(THIS_MACHINE, [""]))).toMatchObject({
    _tag: "Failure", failure: { _tag: "SchedulerInputError", operation: "reconcile-home" },
  });
})));
