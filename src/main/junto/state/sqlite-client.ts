import type { DatabaseSync, StatementSync } from "node:sqlite";
import { type Context, Effect, Schema, Semaphore, Stream } from "effect";
import { SqlClient, SqlConnection, SqlError, Statement } from "effect/unstable/sql";

const sqliteError = (operation: string, cause: unknown): SqlError.SqlError => {
  // Node names SQLite's extended result code errcode; Effect expects errno.
  if (cause instanceof Error && "errcode" in cause) {
    Object.assign(cause, { errno: cause.errcode });
  }
  return new SqlError.SqlError({
    reason: SqlError.classifySqliteError(cause, {
      operation,
      message: cause instanceof Error ? cause.message : String(cause),
    }),
  });
};

const parameters = Schema.decodeUnknownSync(Schema.Array(Schema.Union([
  Schema.Null, Schema.String, Schema.Number, Schema.BigInt, Schema.Uint8Array,
])));

/**
 * Adapt the state owner's connection without opening or exporting another one.
 * The owner holds its lifetime; every statement/reservation holds the same
 * scoped permit, including across yielding transactions and stream consumers.
 */
export const makeSqliteClient = Effect.fn("state.makeSqliteClient")(function* (
  database: DatabaseSync,
  semaphore: Semaphore.Semaphore = Semaphore.makeUnsafe(1),
  beforeExecute?: (sql: string, params: ReadonlyArray<unknown>, context: Context.Context<never>) => void,
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
      beforeExecute?.(sql, params, fiber.context);
      const statement = prepare(sql, cached);
      statement.setReadBigInts(fiber.getRef(SqlClient.SafeIntegers));
      const values = parameters(params);
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
        beforeExecute?.(sql, params, fiber.context);
        const statement = prepare(sql, cached);
        statement.setReadBigInts(fiber.getRef(SqlClient.SafeIntegers));
        statement.setReturnArrays(true);
        try {
          const values = parameters(params);
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
        beforeExecute?.(sql, params, fiber.context);
        const statement = prepare(sql, true);
        statement.setReadBigInts(fiber.getRef(SqlClient.SafeIntegers));
        const values = parameters(params);
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
