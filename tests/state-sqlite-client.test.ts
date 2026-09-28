import { DatabaseSync } from "node:sqlite";
import { Deferred, Effect, Fiber, Layer, Result, Schema, Stream } from "effect";
import { Reactivity } from "effect/unstable/reactivity";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { describe, expect, test, vi } from "vitest";
import { makeSqliteClient } from "../src/main/junto/state/sqlite-client";

const layer = () => Layer.effect(SqlClient.SqlClient, Effect.gen(function* () {
  const db = yield* Effect.acquireRelease(
    Effect.sync(() => new DatabaseSync(":memory:")),
    (db) => Effect.sync(() => db.close()),
  );
  return yield* makeSqliteClient(db);
})).pipe(Layer.provide(Reactivity.layer));

const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(layer())));

describe("node:sqlite Effect client", () => {
  test("binds values, decodes rows, preserves order and returns write metadata", () => run(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT UNIQUE, payload BLOB, n REAL)`;
    const payload = new Uint8Array([0, 255, 19]);
    expect(yield* sql`INSERT INTO items VALUES (${7}, ${"b' ?"}, ${payload}, ${1.25})`.raw)
      .toEqual({ changes: 1, lastInsertRowid: 7 });
    yield* sql`INSERT INTO items VALUES (${2}, ${"a"}, ${null}, ${null})`;
    const find = SqlSchema.findAll({
      Request: Schema.Number,
      Result: Schema.Struct({ id: Schema.Number, name: Schema.String, n: Schema.NullOr(Schema.Number) }),
      execute: (min) => sql`SELECT id, name, n FROM items WHERE id >= ${min} ORDER BY id DESC`,
    });
    expect(yield* find(2)).toEqual([{ id: 7, name: "b' ?", n: 1.25 }, { id: 2, name: "a", n: null }]);
    expect(yield* sql`SELECT payload FROM items WHERE id = ${7}`).toEqual([{ payload }]);
    expect(yield* sql`SELECT id, name FROM items ORDER BY id`.values).toEqual([[2, "a"], [7, "b' ?"]]);
    expect(yield* sql`SELECT id, name FROM items ORDER BY id`).toEqual([{ id: 2, name: "a" }, { id: 7, name: "b' ?" }]);
    expect(yield* sql`SELECT id FROM items ORDER BY id DESC`.valuesUnprepared).toEqual([[7], [2]]);
    expect(yield* sql`SELECT id FROM items ORDER BY id`.unprepared).toEqual([{ id: 2 }, { id: 7 }]);
    expect(yield* sql`SELECT id FROM items ORDER BY id DESC`.stream.pipe(Stream.runCollect)).toEqual([{ id: 7 }, { id: 2 }]);
  })));

  test("caches prepared statements but not unprepared execution", async () => {
    const db = new DatabaseSync(":memory:");
    const prepare = vi.spyOn(db, "prepare");
    try {
      await Effect.runPromise(Effect.gen(function* () {
        const sql = yield* makeSqliteClient(db);
        for (const value of [3, 11]) expect(yield* sql`SELECT ${value} AS n`).toEqual([{ n: value }]);
        expect(prepare).toHaveBeenCalledTimes(1);
        yield* sql`SELECT ${13} AS n`.unprepared;
        yield* sql`SELECT ${17} AS n`.valuesUnprepared;
        expect(prepare).toHaveBeenCalledTimes(3);
      }).pipe(Effect.provide(Reactivity.layer)));
    } finally {
      db.close();
    }
  });

  test("safe integers are fiber-local even on a cached statement", () => run(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const query = sql`SELECT ${9_007_199_254_740_993n} AS n`;
    expect(yield* query.pipe(Effect.provideService(SqlClient.SafeIntegers, true)))
      .toEqual([{ n: 9_007_199_254_740_993n }]);
    expect(Result.isFailure(yield* Effect.result(query))).toBe(true);
    expect(yield* sql`SELECT ${23} AS n`).toEqual([{ n: 23 }]);
  })));

  test("maps native constraints and prepare/binding failures to typed SQL errors", () => run(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE)`;
    yield* sql`INSERT INTO items VALUES (1, 'first')`;
    const unique = yield* Effect.result(sql`INSERT INTO items VALUES (2, 'first')`);
    expect(unique).toMatchObject({ _tag: "Failure", failure: { _tag: "SqlError", reason: { _tag: "UniqueViolation" } } });
    const required = yield* Effect.result(sql`INSERT INTO items VALUES (2, NULL)`);
    expect(required).toMatchObject({ _tag: "Failure", failure: { _tag: "SqlError", reason: { _tag: "ConstraintError" } } });
    for (const query of [sql`SELECT missing FROM items`, sql`SELECT missing FROM items`.unprepared,
      sql`SELECT missing FROM items`.valuesUnprepared, sql.unsafe("SELECT ?", [undefined])]) {
      expect(yield* Effect.result(query)).toMatchObject({ _tag: "Failure", failure: { _tag: "SqlError" } });
    }
    const invalidRow = SqlSchema.findAll({
      Request: Schema.Void,
      Result: Schema.Struct({ name: Schema.Number }),
      execute: () => sql`SELECT name FROM items`,
    });
    expect(yield* Effect.result(invalidRow(undefined))).toMatchObject({ _tag: "Failure", failure: { _tag: "SchemaError" } });
  })));

  test("commits success, rolls back failures and isolates nested savepoints", () => run(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE items (id INTEGER PRIMARY KEY)`;
    yield* sql.withTransaction(Effect.gen(function* () {
      yield* sql`INSERT INTO items VALUES (1)`;
      yield* sql.withTransaction(sql`INSERT INTO items VALUES (2)`);
      const failed = yield* Effect.result(sql.withTransaction(Effect.gen(function* () {
        yield* sql`INSERT INTO items VALUES (3)`;
        yield* sql.withTransaction(sql`INSERT INTO items VALUES (4)`);
        return yield* Effect.fail("nested");
      })));
      expect(failed).toEqual(Result.fail("nested"));
      yield* sql.withTransaction(sql`INSERT INTO items VALUES (5)`);
    }));
    yield* Effect.result(sql.withTransaction(Effect.gen(function* () {
      yield* sql`INSERT INTO items VALUES (6)`;
      yield* sql.withTransaction(sql`INSERT INTO items VALUES (7)`);
      return yield* Effect.fail("outer");
    })));
    expect(yield* sql`SELECT id FROM items ORDER BY id`).toEqual([{ id: 1 }, { id: 2 }, { id: 5 }]);
  })));

  test("a yielding transaction cannot expose uncommitted rows to another fiber", () => run(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE items (id INTEGER PRIMARY KEY)`;
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const transaction = yield* sql.withTransaction(Effect.gen(function* () {
      yield* sql`INSERT INTO items VALUES (31)`;
      yield* Deferred.succeed(entered, undefined);
      yield* Deferred.await(release);
      return yield* Effect.fail("rollback");
    })).pipe(Effect.result, Effect.forkChild);
    yield* Deferred.await(entered);
    const read = yield* sql`SELECT id FROM items`.pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    expect(read.pollUnsafe()).toBeUndefined();
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(transaction);
    expect(yield* Fiber.join(read)).toEqual([]);
  })));

  test("interruption rolls back and releases the connection; waiting leases can be interrupted", () => run(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE items (id INTEGER PRIMARY KEY)`;
    const entered = yield* Deferred.make<void>();
    const transaction = yield* sql.withTransaction(Effect.gen(function* () {
      yield* sql`INSERT INTO items VALUES (41)`;
      yield* Deferred.succeed(entered, undefined);
      yield* Effect.never;
    })).pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    const waiting = yield* sql`SELECT id FROM items`.pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    yield* Fiber.interrupt(waiting);
    yield* Fiber.interrupt(transaction);
    expect(yield* sql`SELECT id FROM items`).toEqual([]);
    yield* sql.withTransaction(sql`INSERT INTO items VALUES (43)`);
    expect(yield* sql`SELECT id FROM items`).toEqual([{ id: 43 }]);
  })));

  test("reserve holds the permit until its scope closes, including failed statements", () => run(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* Effect.scoped(Effect.gen(function* () {
      const connection = yield* sql.reserve;
      expect(yield* connection.execute("SELECT ? AS n", [53], undefined)).toEqual([{ n: 53 }]);
      yield* Effect.result(connection.executeValues("SELECT ? AS n", [undefined]));
      expect(yield* connection.execute("SELECT ? AS n", [59], undefined)).toEqual([{ n: 59 }]);
    }));
    expect(yield* sql`SELECT ${61} AS n`).toEqual([{ n: 61 }]);
  })));
});
