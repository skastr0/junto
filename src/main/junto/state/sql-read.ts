import { Context, Effect, Option } from "effect";
import type { SqlClient, SqlError } from "effect/unstable/sql";

/** Driver-private lease identities; no connection is exposed to repositories. */
export const SqlReadLeases = Context.Reference<ReadonlySet<SqlClient.SqlClient["transactionService"]>>(
  "@junto/SqlReadLeases",
  { defaultValue: () => new Set() },
);

/**
 * Preserve StateEngine.read's single connection lease without introducing BEGIN.
 * Nested reads and transaction participants reuse the caller's connection.
 */
export const withSqlRead = <A, E, R>(
  sql: SqlClient.SqlClient,
  body: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | SqlError.SqlError, R> => Effect.scoped(Effect.gen(function* () {
  const leases = yield* SqlReadLeases;
  if (leases.has(sql.transactionService) || Option.isSome(yield* Effect.serviceOption(sql.transactionService))) {
    return yield* body;
  }
  yield* sql.reserve;
  return yield* body.pipe(Effect.provideService(SqlReadLeases, new Set([...leases, sql.transactionService])));
}));
