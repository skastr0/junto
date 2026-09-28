import type { DatabaseSync, SQLInputValue, StatementSync } from "node:sqlite";
import { Effect, Semaphore, Stream } from "effect";
import { SqlClient, SqlConnection, SqlError, Statement } from "effect/unstable/sql";

const sqliteError = (operation: string, cause: unknown): SqlError.SqlError => {
  // Node names SQLite's extended result code errcode; Effect expects errno.
  if (cause instanceof Error && "errcode" in cause) {
    Object.assign(cause, { errno: cause.errcode });
  }
  return new SqlError.SqlError({
    reason: SqlError.classifySqliteError(cause, { operation }),
  });
};

const parameter = (value: unknown): SQLInputValue => {
  if (value === null || typeof value === "string" || typeof value === "number" ||
    typeof value === "bigint" || value instanceof Uint8Array) return value;
  throw new TypeError("Unsupported SQLite parameter");
};

/**
 * Adapt the state owner's connection without opening or exporting another one.
 * The owner holds its lifetime; every statement/reservation holds the same
 * scoped permit, including across yielding transactions and stream consumers.
 */
export const makeSqliteClient = Effect.fn("state.makeSqliteClient")(function* (
  database: DatabaseSync,
  semaphore: Semaphore.Semaphore = Semaphore.makeUnsafe(1),
) {
  const statements = new Map<string, StatementSync>();
  const prepare = (sql: string, cached: boolean): StatementSync => {
    const existing = cached ? statements.get(sql) : undefined;
    if (existing) return existing;
    const statement = database.prepare(sql);
    if (cached) statements.set(sql, statement);
    return statement;
  };

  const execute = (
    sql: string,
    params: ReadonlyArray<unknown>,
    transformRows: Parameters<SqlConnection.Connection["execute"]>[2],
    cached = true,
  ) => Effect.withFiber((fiber) => Effect.try({
    try: () => {
      const statement = prepare(sql, cached);
      statement.setReadBigInts(fiber.getRef(SqlClient.SafeIntegers));
      const values = params.map(parameter);
      if (statement.columns().length === 0) {
        statement.run(...values);
        return [];
      }
      const rows = statement.all(...values);
      return transformRows ? transformRows(rows) : rows;
    },
    catch: (cause) => sqliteError("execute", cause),
  }));

  const executeValues = (sql: string, params: ReadonlyArray<unknown>, cached = true) =>
    Effect.withFiber((fiber) => Effect.try({
      try: () => {
        const statement = prepare(sql, cached);
        statement.setReadBigInts(fiber.getRef(SqlClient.SafeIntegers));
        statement.setReturnArrays(true);
        try {
          const values = params.map(parameter);
          if (statement.columns().length === 0) {
            statement.run(...values);
            return [];
          }
          // node:sqlite's declarations do not reflect setReturnArrays.
          return statement.all(...values) as unknown as ReadonlyArray<ReadonlyArray<unknown>>;
        } finally {
          statement.setReturnArrays(false);
        }
      },
      catch: (cause) => sqliteError("executeValues", cause),
    }));

  const connection: SqlConnection.Connection = {
    execute,
    executeUnprepared: (sql, params, transform) => execute(sql, params, transform, false),
    executeValues,
    executeValuesUnprepared: (sql, params) => executeValues(sql, params, false),
    executeRaw: (sql, params) => Effect.withFiber((fiber) => Effect.try({
      try: () => {
        const statement = prepare(sql, true);
        statement.setReadBigInts(fiber.getRef(SqlClient.SafeIntegers));
        const values = params.map(parameter);
        return statement.columns().length > 0
          ? statement.all(...values)
          : statement.run(...values);
      },
      catch: (cause) => sqliteError("executeRaw", cause),
    })),
    // SQLite is synchronous. Buffer the result before yielding to a consumer,
    // so an interrupted stream cannot leave a native cursor open.
    executeStream: (sql, params, transform) =>
      Stream.fromIterableEffect(execute(sql, params, transform)),
  };

  const acquirer = Effect.acquireRelease(
    Effect.as(semaphore.take(1), connection),
    () => semaphore.release(1),
    { interruptible: true },
  );
  return yield* SqlClient.make({
    acquirer,
    compiler: Statement.makeCompilerSqlite(),
    beginTransaction: "BEGIN IMMEDIATE",
    spanAttributes: [["db.system", "sqlite"]],
  });
});
