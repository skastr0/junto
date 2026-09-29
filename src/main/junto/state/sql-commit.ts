import { Context, Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql";

type CommitCallbacks = Array<() => void>;
const SqlCommitCallbacks = Context.Reference<ReadonlyMap<
  SqlClient.SqlClient["transactionService"], CommitCallbacks
>>("@junto/SqlCommitCallbacks", { defaultValue: () => new Map() });

/** Publish now, or after the owning product transaction actually commits. */
export const afterSqlCommit = (
  sql: SqlClient.SqlClient,
  callback: () => void,
): Effect.Effect<void> => Effect.flatMap(SqlCommitCallbacks, (frames) => Effect.sync(() => {
  const callbacks = frames.get(sql.transactionService);
  if (callbacks) callbacks.push(callback);
  else callback();
}));

/** Installed once by the state owner, after its transaction guards. */
export const installSqlCommitCallbacks = (sql: SqlClient.SqlClient): void => {
  const transaction = sql.withTransaction;
  const withTransaction: SqlClient.SqlClient["withTransaction"] = (body) => Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
    const frames = yield* SqlCommitCallbacks;
    const parent = frames.get(sql.transactionService);
    const callbacks: CommitCallbacks = [];
    const result = yield* restore(transaction(body.pipe(Effect.provideService(
      SqlCommitCallbacks, new Map([...frames, [sql.transactionService, callbacks]]),
    ))));
    // Failure, interruption and failed COMMIT skip this point. A successful
    // savepoint contributes only to its parent's still-uncommitted queue.
    yield* Effect.sync(() => {
      if (parent) parent.push(...callbacks);
      else for (const callback of callbacks) callback();
    });
    return result;
  }));
  Object.assign(sql, { withTransaction });
};
