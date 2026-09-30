import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect, it } from "vitest";
import { makeStateEngineLive, StateEngine } from "../src/main/junto/state/engine";
import { StateTransactionOperation } from "../src/main/junto/state/service";
import { OverseerLiveExecution, type OverseerLiveExecutionConstraint } from "../src/main/junto/overseer/live/execution";

describe("Live execution at the sole StateEngine transaction", () => {
  const exercise = async (test: (runtime: ManagedRuntime.ManagedRuntime<StateEngine | SqlClient.SqlClient, unknown>) => Promise<void>) => {
    const root = await mkdtemp(join(tmpdir(), "command-live-fence-"));
    const runtime = ManagedRuntime.make(makeStateEngineLive(join(root, "state.db")));
    try { await test(runtime); } finally { await runtime.dispose(); await rm(root, { recursive: true, force: true }); }
  };
  const insert = Effect.flatMap(SqlClient.SqlClient, (sql) => sql.withTransaction(
    sql`INSERT INTO factory_pause_canvases VALUES ('test', 0, 0, 'now')`,
  )).pipe(Effect.provideService(StateTransactionOperation, "test.live.action"));
  const count = Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql`SELECT count(*) AS n FROM factory_pause_canvases`.pipe(Effect.map((rows) => Number(rows[0]!.n))));

  it("rejects a correction received while the operation is awaiting, before any write", async () => exercise(async (runtime) => {
    let current = true;
    const assertCurrent = () => { if (!current) throw new Error("intent superseded"); };
    const constraint: OverseerLiveExecutionConstraint = {
      assertCurrent,
      assertCurrentWithin: Effect.try({ try: assertCurrent, catch: (error) => error }),
    };
    const pending = Effect.gen(function* () {
      yield* Effect.sync(() => { current = false; });
      yield* Effect.yieldNow;
      yield* insert;
    }).pipe(Effect.provideService(OverseerLiveExecution, constraint));
    await expect(runtime.runPromise(pending)).rejects.toThrow("intent superseded");
    expect(await runtime.runPromise(count)).toBe(0);
  }));

  it("rolls back the owner mutation when its atomic receipt fails", async () => exercise(async (runtime) => {
    const sql = await runtime.runPromise(SqlClient.SqlClient);
    const constraint: OverseerLiveExecutionConstraint = {
      assertCurrent: () => undefined,
      assertCurrentWithin: Effect.gen(function* () {
        expect(yield* Effect.serviceOption(sql.transactionService)).toMatchObject({ _tag: "Some" });
      }),
      afterMutation: () => Effect.fail(new Error("receipt failed")),
    };
    await expect(runtime.runPromise(insert.pipe(Effect.provideService(OverseerLiveExecution, constraint)))).rejects.toThrow("receipt failed");
    expect(await runtime.runPromise(count)).toBe(0);
    await runtime.runPromise(insert);
    expect(await runtime.runPromise(count)).toBe(1);
  }));

  it("does not fabricate a receipt for a rejected or unchanged transaction", async () => exercise(async (runtime) => {
    let receipts = 0;
    const constraint: OverseerLiveExecutionConstraint = {
      assertCurrent: () => undefined,
      assertCurrentWithin: Effect.void,
      afterMutation: () => Effect.sync(() => { receipts += 1; }),
    };
    await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql.withTransaction(Effect.succeed({ ok: false })))
      .pipe(Effect.provideService(StateTransactionOperation, "test.noop"))
      .pipe(Effect.provideService(OverseerLiveExecution, constraint)));
    expect(receipts).toBe(0);
    await runtime.runPromise(insert.pipe(Effect.provideService(OverseerLiveExecution, constraint)));
    expect(receipts).toBe(1);
  }));
});
