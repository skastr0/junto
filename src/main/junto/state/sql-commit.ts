import { Context, Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql";

type CommitCallbacks = Array<() => void>;
type TransactionFrame = {
  callbacks: CommitCallbacks;
  locals: Map<symbol, unknown>;
};
const SqlCommitCallbacks = Context.Reference<
  ReadonlyMap<SqlClient.SqlClient["transactionService"], TransactionFrame>
>("@junto/SqlCommitCallbacks", { defaultValue: () => new Map() });

/** Publish now, or after the owning product transaction actually commits. */
export const afterSqlCommit = (
  sql: SqlClient.SqlClient,
  callback: () => void,
): Effect.Effect<void> =>
  Effect.flatMap(SqlCommitCallbacks, (frames) =>
    Effect.sync(() => {
      const callbacks = frames.get(sql.transactionService);
      if (callbacks) callbacks.callbacks.push(callback);
      else callback();
    }),
  );

/** Installed once by the state owner, after its transaction guards. */
export const installSqlCommitCallbacks = (sql: SqlClient.SqlClient): void => {
  const transaction = sql.withTransaction;
  const withTransaction: SqlClient.SqlClient["withTransaction"] = (body) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const frames = yield* SqlCommitCallbacks;
        const parent = frames.get(sql.transactionService);
        const frame: TransactionFrame = {
          callbacks: [],
          locals: new Map(parent?.locals),
        };
        const result = yield* restore(
          transaction(
            body.pipe(
              Effect.provideService(
                SqlCommitCallbacks,
                new Map([...frames, [sql.transactionService, frame]]),
              ),
            ),
          ),
        );
        // Failure, interruption and failed COMMIT skip this point. A successful
        // savepoint contributes only to its parent's still-uncommitted queue.
        yield* Effect.sync(() => {
          if (parent) {
            parent.callbacks.push(...frame.callbacks);
            parent.locals = frame.locals;
          } else for (const callback of frame.callbacks) callback();
        });
        return result;
      }),
    );
  Object.assign(sql, { withTransaction });
};

/** Immutable values staged in a savepoint, merged only on its success. */
export const sqlTransactionLocal = <A>(
  sql: SqlClient.SqlClient,
  key: symbol,
): Effect.Effect<A | undefined> =>
  Effect.map(
    SqlCommitCallbacks,
    (frames) =>
      frames.get(sql.transactionService)?.locals.get(key) as A | undefined,
  );

export const setSqlTransactionLocal = <A>(
  sql: SqlClient.SqlClient,
  key: symbol,
  value: A,
): Effect.Effect<void> =>
  Effect.flatMap(SqlCommitCallbacks, (frames) =>
    Effect.sync(() => {
      const frame = frames.get(sql.transactionService);
      if (!frame)
        throw new Error(
          "transaction-local state requires a product transaction",
        );
      frame.locals.set(key, value);
    }),
  );

/**
 * Run `effect` holding back every after-commit callback it registers, its
 * own and its transactions', and hand them back unrun, for a caller that
 * makes the effect's writes durable by other means and runs them then: the
 * canvas authority judges a batch in a savepoint it rolls back, and its
 * writes land when the judged entries apply (0.11/06 F2).
 */
export const holdSqlCommitCallbacks = <A, E, R>(
  sql: SqlClient.SqlClient,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<readonly [A, ReadonlyArray<() => void>], E, R> =>
  Effect.flatMap(SqlCommitCallbacks, (frames) => {
    const frame: TransactionFrame = {
      callbacks: [],
      locals: new Map(frames.get(sql.transactionService)?.locals),
    };
    return effect.pipe(
      Effect.provideService(SqlCommitCallbacks, new Map([...frames, [sql.transactionService, frame]])),
      Effect.map((value) => [value, frame.callbacks] as const),
    );
  });
