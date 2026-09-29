import { DatabaseSync } from "node:sqlite";
import { Deferred, Effect, Fiber } from "effect";
import { Reactivity } from "effect/unstable/reactivity";
import { expect, test } from "vitest";
import { makeSqliteClient } from "../src/main/junto/state/sqlite-client";
import { afterSqlCommit, installSqlCommitCallbacks } from "../src/main/junto/state/sql-commit";

const client = Effect.gen(function* () {
  const database = yield* Effect.acquireRelease(
    Effect.sync(() => new DatabaseSync(":memory:")),
    (database) => Effect.sync(() => database.close()),
  );
  const sql = yield* makeSqliteClient(database);
  installSqlCommitCallbacks(sql);
  yield* sql`CREATE TABLE entries (id INTEGER PRIMARY KEY)`;
  return { sql, database };
});

test("publishes committed callbacks in order and discards rolled-back savepoints", () => Effect.runPromise(
  Effect.scoped(Effect.gen(function* () {
    const { sql, database } = yield* client;
    const seen: string[] = [];
    const publish = (name: string) => afterSqlCommit(sql, () => {
      expect(database.isTransaction).toBe(false);
      seen.push(name);
    });
    yield* publish("outside");
    yield* sql.withTransaction(Effect.gen(function* () {
      yield* sql`INSERT INTO entries VALUES (11)`;
      yield* publish("outer-first");
      yield* sql.withTransaction(Effect.gen(function* () {
        yield* sql`INSERT INTO entries VALUES (23)`;
        yield* publish("nested");
      }));
      yield* sql.withTransaction(Effect.gen(function* () {
        yield* sql`INSERT INTO entries VALUES (37)`;
        yield* publish("discarded");
        return yield* Effect.fail("rollback savepoint");
      })).pipe(Effect.result);
      yield* publish("outer-last");
      expect(seen).toEqual(["outside"]);
    }));
    expect(seen).toEqual(["outside", "outer-first", "nested", "outer-last"]);
    expect(yield* sql`SELECT id FROM entries ORDER BY id`).toEqual([{ id: 11 }, { id: 23 }]);
    yield* sql.withTransaction(Effect.gen(function* () {
      yield* sql.withTransaction(publish("rolled-back-parent"));
      return yield* Effect.fail("rollback outer");
    })).pipe(Effect.result);
    expect(seen).toEqual(["outside", "outer-first", "nested", "outer-last"]);
  })).pipe(Effect.provide(Reactivity.layer)),
));

test("interruption discards callbacks and does not poison the next transaction", () => Effect.runPromise(
  Effect.scoped(Effect.gen(function* () {
    const { sql } = yield* client;
    const seen: number[] = [];
    const entered = yield* Deferred.make<void>();
    const interrupted = yield* sql.withTransaction(Effect.gen(function* () {
      yield* sql`INSERT INTO entries VALUES (41)`;
      yield* afterSqlCommit(sql, () => { seen.push(41); });
      yield* Deferred.succeed(entered, undefined);
      yield* Effect.never;
    })).pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    yield* Fiber.interrupt(interrupted);
    yield* sql.withTransaction(Effect.gen(function* () {
      yield* sql`INSERT INTO entries VALUES (53)`;
      yield* afterSqlCommit(sql, () => { seen.push(53); });
    }));
    expect(seen).toEqual([53]);
    expect(yield* sql`SELECT id FROM entries`).toEqual([{ id: 53 }]);
  })).pipe(Effect.provide(Reactivity.layer)),
));

test("different clients commit independently within the same fiber", () => Effect.runPromise(
  Effect.scoped(Effect.gen(function* () {
    const first = yield* client;
    const second = yield* client;
    const seen: string[] = [];
    yield* first.sql.withTransaction(Effect.gen(function* () {
      yield* afterSqlCommit(first.sql, () => { seen.push("first"); });
      yield* second.sql.withTransaction(afterSqlCommit(second.sql, () => { seen.push("second"); }));
      expect(seen).toEqual(["second"]);
      return yield* Effect.fail("first fails");
    })).pipe(Effect.result);
    expect(seen).toEqual(["second"]);
  })).pipe(Effect.provide(Reactivity.layer)),
));
