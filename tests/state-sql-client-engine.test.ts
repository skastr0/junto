import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deferred, Effect, Fiber, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, test, vi } from "vitest";
import { makeStateEngineLive, StateEngine } from "../src/main/junto/state/engine";
import { StateTransactionOperation } from "../src/main/junto/state/service";
import { OverseerLiveExecution } from "../src/main/junto/overseer/live/execution";
import { WorkMutationContext, unjournaledWorkMutationEffect } from "../src/main/junto/work/mutation-seam";

test("StateEngine publishes the same migrated, scoped connection as SqlClient", async () => {
  const root = await mkdtemp(join(tmpdir(), "junto-sql-engine-"));
  const runtime = ManagedRuntime.make(makeStateEngineLive(join(root, "junto.db")));
  try {
    const sql = await runtime.runPromise(SqlClient.SqlClient);
    await runtime.runPromise(Effect.gen(function* () {
      const engine = yield* StateEngine;
      expect(yield* sql`PRAGMA user_version`).toEqual([{ user_version: engine.info.schemaVersion }]);
      // TEMP state is connection-local: a second opener cannot see this table.
      yield* sql`CREATE TEMP TABLE connection_probe (n INTEGER)`;
      yield* sql`INSERT INTO connection_probe VALUES (17)`;
      expect(yield* engine.read("sql.connection", (reader) => reader.all("SELECT n FROM connection_probe")))
        .toEqual([{ n: 17 }]);
      yield* engine.transaction("sql.legacy", (writer) => writer.run("INSERT INTO connection_probe VALUES (29)"));
      expect(yield* sql`SELECT n FROM connection_probe ORDER BY n`).toEqual([{ n: 17 }, { n: 29 }]);
    }));
    await runtime.dispose();
    expect(await Effect.runPromise(Effect.result(sql`SELECT 1`)))
      .toMatchObject({ _tag: "Failure", failure: { _tag: "SqlError" } });
  } finally {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy reads, writes and backups wait for the SQL transaction lease", async () => {
  const root = await mkdtemp(join(tmpdir(), "junto-sql-engine-"));
  const runtime = ManagedRuntime.make(makeStateEngineLive(join(root, "junto.db")));
  try {
    await runtime.runPromise(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const engine = yield* StateEngine;
      yield* sql`CREATE TEMP TABLE connection_probe (n INTEGER)`;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const transaction = yield* sql.withTransaction(Effect.gen(function* () {
        yield* sql`INSERT INTO connection_probe VALUES (31)`;
        yield* Deferred.succeed(entered, undefined);
        yield* Deferred.await(release);
        return yield* Effect.fail("rollback");
      })).pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(entered);
      const read = yield* engine.read("sql.concurrent-read", (reader) => reader.all("SELECT n FROM connection_probe"))
        .pipe(Effect.forkChild);
      const write = yield* engine.transaction("sql.concurrent-write", (writer) => writer.run("INSERT INTO connection_probe VALUES (43)"))
        .pipe(Effect.forkChild);
      const backup = yield* engine.backup().pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      expect(read.pollUnsafe()).toBeUndefined();
      expect(write.pollUnsafe()).toBeUndefined();
      expect(backup.pollUnsafe()).toBeUndefined();
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(transaction);
      expect(yield* Fiber.join(read)).toEqual([]);
      yield* Fiber.join(write);
      expect((yield* Fiber.join(backup)).schemaVersion).toBe(engine.info.schemaVersion);
      expect(yield* sql`SELECT n FROM connection_probe`).toEqual([{ n: 43 }]);
    }));
  } finally {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("SQL transactions retain journal admission across yields and savepoints", async () => {
  const root = await mkdtemp(join(tmpdir(), "junto-sql-engine-"));
  const runtime = ManagedRuntime.make(makeStateEngineLive(join(root, "junto.db")));
  try {
    await runtime.runPromise(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const mutation = sql`DELETE FROM work_tasks WHERE 0`;
      expect(yield* Effect.result(mutation)).toMatchObject({ _tag: "Failure" });
      yield* sql.withTransaction(Effect.gen(function* () {
        yield* Effect.yieldNow;
        expect(yield* Effect.result(mutation)).toMatchObject({ _tag: "Failure" });
        const outer = yield* WorkMutationContext;
        expect(outer?.journaled).toBe(false);
        yield* Effect.result(sql.withTransaction(Effect.gen(function* () {
          const inner = yield* WorkMutationContext;
          // Simulate a journal admission without manufacturing a product fact.
          inner!.journaled = true;
          yield* mutation;
          return yield* Effect.fail("rollback savepoint");
        })));
        expect(outer?.journaled).toBe(false);
        expect(yield* Effect.result(mutation)).toMatchObject({ _tag: "Failure" });
        yield* sql.withTransaction(Effect.gen(function* () {
          (yield* WorkMutationContext)!.journaled = true;
          yield* Effect.yieldNow;
        }));
        expect(outer?.journaled).toBe(true);
        yield* mutation;
      }));
      expect(yield* Effect.result(mutation)).toMatchObject({ _tag: "Failure" });
    }));
  } finally {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("caught journal-free failures retain journal admission without leaking the exception", async () => {
  const root = await mkdtemp(join(tmpdir(), "junto-sql-engine-"));
  const runtime = ManagedRuntime.make(makeStateEngineLive(join(root, "junto.db")));
  try {
    await runtime.runPromise(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.withTransaction(Effect.gen(function* () {
        const parent = yield* WorkMutationContext;
        yield* Effect.result(unjournaledWorkMutationEffect("test.fixture-seed", Effect.gen(function* () {
          const scope = yield* WorkMutationContext;
          scope!.journaled = true;
          return yield* Effect.fail("caught after append");
        })));
        expect(parent?.journaled).toBe(true);
        expect(parent?.unjournaled).toBeUndefined();
        yield* sql`DELETE FROM work_tasks WHERE 0`;
      }));
      expect(yield* Effect.result(sql`DELETE FROM work_tasks WHERE 0`))
        .toMatchObject({ _tag: "Failure" });
    }));
  } finally {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["SQL", "legacy"])("%s transactions fence live execution and commit its receipt atomically", async (owner) => {
  const root = await mkdtemp(join(tmpdir(), "junto-sql-engine-"));
  const runtime = ManagedRuntime.make(makeStateEngineLive(join(root, "junto.db")));
  try {
    await runtime.runPromise(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TEMP TABLE connection_probe (n INTEGER)`;
      const assertCurrent = vi.fn();
      const assertCurrentWithin = vi.fn((): Effect.Effect<void, unknown> => Effect.void);
      const afterMutation = vi.fn((operation: string): Effect.Effect<void, unknown> => Effect.gen(function* () {
        expect(operation).toBe("test.receipt");
        yield* Effect.yieldNow;
        yield* sql`INSERT INTO connection_probe VALUES (73)`;
      }));
      const engine = yield* StateEngine;
      const ownerWrite: Effect.Effect<unknown, unknown> = owner === "SQL" ? sql.withTransaction(sql`INSERT INTO connection_probe VALUES (67)`) :
        engine.transaction("test.receipt", (writer) => writer.run("INSERT INTO connection_probe VALUES (67)"));
      const write = ownerWrite.pipe(
        Effect.provideService(OverseerLiveExecution, { assertCurrent,
          assertCurrentWithin: Effect.suspend(assertCurrentWithin), afterMutation }),
        Effect.provideService(StateTransactionOperation, "test.receipt"),
      );
      yield* write;
      expect(assertCurrent).not.toHaveBeenCalled();
      expect(assertCurrentWithin).toHaveBeenCalledTimes(1);
      expect(afterMutation).toHaveBeenCalledTimes(1);
      expect(yield* sql`SELECT n FROM connection_probe ORDER BY n`).toEqual([{ n: 67 }, { n: 73 }]);
      afterMutation.mockImplementationOnce(() => Effect.gen(function* () {
        yield* sql`INSERT INTO connection_probe VALUES (79)`;
        return yield* Effect.fail(new Error("receipt refused"));
      }));
      expect(yield* Effect.result(write)).toMatchObject({ _tag: "Failure", failure: { message: "receipt refused" } });
      assertCurrentWithin.mockImplementationOnce(() => Effect.fail(new Error("intent revoked")));
      expect(yield* Effect.result(write)).toMatchObject({ _tag: "Failure", failure: { message: "intent revoked" } });
      expect(yield* sql`SELECT n FROM connection_probe ORDER BY n`).toEqual([{ n: 67 }, { n: 73 }]);
      expect(afterMutation).toHaveBeenCalledTimes(2);
      if (owner === "legacy") {
        const rejected = new Error("raw body rejected");
        expect(yield* Effect.result(engine.transaction("test.raw-error", () => { throw rejected; })))
          .toMatchObject({ _tag: "Failure", failure: { cause: rejected, message: rejected.message } });
      }
    }));
  } finally {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
