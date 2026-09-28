import { Context, Effect, Result, Layer, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import {
  hasUsageQuotas,
  UsageSnapshot,
  type UsageState as UsageStateValue,
} from "@shared/usage";
import { StateTransactionOperation } from "../state/service";

export { USAGE_STATE_SCHEMA_SQL } from "./state-schema";

export class UsageCacheError extends Schema.TaggedError<UsageCacheError>()(
  "UsageCacheError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.Unknown,
  },
) {}

const usageCacheError = (
  operation: string,
  cause: unknown,
): UsageCacheError =>
  UsageCacheError.make({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });

/**
 * Durable usage is deliberately narrower than live usage state: only a
 * paint-worthy last-good snapshot is persisted. Failure envelopes and
 * `lastError` remain session state and therefore cannot erase good quota data.
 */
/**
 * effect-foundation **S4-rest-main** (staged, not half-migrated):
 * - Canonical id: `@junto/UsageCache` — single definition; no dual path.
 * - Service id: Context.Service (Effect V4 live).
 * - Shape:
 *   `class UsageCache extends Context.Service<UsageCache, UsageCache>()("@junto/UsageCache") {}`
 * - Layer today: UsageCacheLive / makeUsageCacheLive — V4 rename candidate UsageCache.layer
 *   Do not dual-export Live + `.layer` names.
 */
export class UsageCache extends Context.Service<UsageCache,
  {
    readonly loadLastGood: Effect.Effect<
      UsageStateValue | undefined,
      UsageCacheError
    >;
    readonly saveLastGood: (
      state: UsageStateValue,
    ) => Effect.Effect<void, UsageCacheError>;
  }>()("@junto/UsageCache") {}

const UsageStateRow = Schema.Struct({
  snapshots_json: Schema.String,
  last_live_at: Schema.String,
});

const decodeSnapshots = (
  operation: string,
  encoded: string,
): Effect.Effect<ReadonlyArray<typeof UsageSnapshot.Type>, UsageCacheError> =>
  Effect.try({
    try: () => JSON.parse(encoded) as unknown,
    catch: (error) => usageCacheError(operation, error),
  }).pipe(
    Effect.flatMap((parsed) => {
      const decoded = Schema.decodeUnknownResult(
        Schema.Array(UsageSnapshot),
        { onExcessProperty: "error" },
      )(parsed);
      return Result.isSuccess(decoded)
        ? Effect.succeed(decoded.success)
        : Effect.fail(usageCacheError(operation, decoded.failure));
    }),
  );

const decodeRow = (
  row: typeof UsageStateRow.Type | undefined,
): Effect.Effect<UsageStateValue | undefined, UsageCacheError> => {
  if (row === undefined) return Effect.succeed(undefined);
  return decodeSnapshots("load.decode", row.snapshots_json).pipe(
    Effect.flatMap((snapshots) => {
      const state: UsageStateValue = {
        snapshots: [...snapshots],
        stale: true,
        lastLiveAt: row.last_live_at,
      };
      return hasUsageQuotas(state)
        ? Effect.succeed(state)
        : Effect.fail(
            usageCacheError(
              "load.decode",
              new Error("persisted usage state has no last-good quota rows"),
            ),
          );
    }),
  );
};

export const makeUsageCacheLive = (): Layer.Layer<
  UsageCache,
  never,
  SqlClient.SqlClient
> =>
  Layer.effect(
    UsageCache,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const selectUsageState = SqlSchema.findOneOption({
        Request: Schema.Void,
        Result: UsageStateRow,
        execute: () => sql`SELECT snapshots_json, last_live_at FROM usage_state WHERE singleton = 1`,
      });

      const loadLastGood = Effect.fn("usage-cache.load-last-good")(function* () {
        const row = yield* selectUsageState(undefined);
        return yield* decodeRow(row._tag === "Some" ? row.value : undefined);
      }, Effect.mapError((error) => error instanceof UsageCacheError ? error : usageCacheError("load", error)))();

      const writeLastGood = Effect.fn("usage-cache.save-last-good")(function* (state: UsageStateValue) {
        const now = new Date().toISOString();
        yield* sql`INSERT INTO usage_state(singleton, snapshots_json, last_live_at, updated_at)
          VALUES (1, ${JSON.stringify(state.snapshots)}, ${state.lastLiveAt ?? now}, ${now})
          ON CONFLICT(singleton) DO UPDATE SET
            snapshots_json = excluded.snapshots_json,
            last_live_at = excluded.last_live_at,
            updated_at = excluded.updated_at`;
      }, sql.withTransaction, Effect.provideService(StateTransactionOperation, "usage.save-last-good"),
      Effect.mapError((error) => usageCacheError("save-last-good", error)));

      // Failure envelopes are never durable and never overwrite good data.
      const saveLastGood = (state: UsageStateValue): Effect.Effect<void, UsageCacheError> =>
        hasUsageQuotas(state) ? writeLastGood(state) : Effect.void;

      return UsageCache.of({
        loadLastGood,
        saveLastGood,
      });
    }),
  );

export const UsageCacheLive = makeUsageCacheLive();
