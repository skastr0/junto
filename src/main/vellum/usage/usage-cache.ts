import { Context, Effect, Either, Layer, Schema } from "effect";
import {
  hasUsageQuotas,
  UsageSnapshot,
  type UsageState as UsageStateValue,
} from "@shared/usage";
import {
  StateEngine,
  type StateEngineError,
  type StateReader,
} from "../state/service";

export { USAGE_STATE_SCHEMA_SQL } from "./state-schema";

export class UsageCacheError extends Schema.TaggedError<UsageCacheError>()(
  "UsageCacheError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.Defect,
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

const fromStateError = (
  operation: string,
  error: StateEngineError,
): UsageCacheError => usageCacheError(operation, error);

/**
 * Durable usage is deliberately narrower than live usage state: only a
 * paint-worthy last-good snapshot is persisted. Failure envelopes and
 * `lastError` remain session state and therefore cannot erase good quota data.
 */
/**
 * effect-foundation **S4-rest-main** (staged, not half-migrated):
 * - Canonical id: `@vellum/UsageCache` — single definition; no dual path.
 * - Substrate: effect@3.21 → `Context.Tag` (`Context.Service` unavailable).
 * - V4 target:
 *   `class UsageCache extends Context.Service<UsageCache, UsageCache>()("@vellum/UsageCache") {}`
 * - Layer today: UsageCacheLive / makeUsageCacheLive — V4 rename candidate UsageCache.layer
 *   Do not dual-export Live + `.layer` names.
 */
export class UsageCache extends Context.Tag("@vellum/UsageCache")<
  UsageCache,
  {
    readonly loadLastGood: Effect.Effect<
      UsageStateValue | undefined,
      UsageCacheError
    >;
    readonly saveLastGood: (
      state: UsageStateValue,
    ) => Effect.Effect<void, UsageCacheError>;
  }
>() {}

type UsageStateRow = {
  readonly snapshots_json: string;
  readonly last_live_at: string;
};

const selectUsageState = (
  reader: StateReader,
): UsageStateRow | undefined =>
  reader.get<UsageStateRow>(
    `SELECT snapshots_json, last_live_at
       FROM usage_state
      WHERE singleton = 1`,
  );

const decodeSnapshots = (
  operation: string,
  encoded: string,
): Effect.Effect<ReadonlyArray<typeof UsageSnapshot.Type>, UsageCacheError> =>
  Effect.try({
    try: () => JSON.parse(encoded) as unknown,
    catch: (error) => usageCacheError(operation, error),
  }).pipe(
    Effect.flatMap((parsed) => {
      const decoded = Schema.decodeUnknownEither(
        Schema.Array(UsageSnapshot),
        { onExcessProperty: "error" },
      )(parsed);
      return Either.isRight(decoded)
        ? Effect.succeed(decoded.right)
        : Effect.fail(usageCacheError(operation, decoded.left));
    }),
  );

const decodeRow = (
  row: UsageStateRow | undefined,
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
  StateEngine
> =>
  Layer.effect(
    UsageCache,
    Effect.gen(function* () {
      const engine = yield* StateEngine;

      const loadLastGood = engine
        .read("usage.load", selectUsageState)
        .pipe(
          Effect.flatMap(decodeRow),
          Effect.mapError((error) =>
            error instanceof UsageCacheError
              ? error
              : fromStateError("load", error),
          ),
          Effect.withSpan("usage-cache.load-last-good"),
        );

      const saveLastGood = (
        state: UsageStateValue,
      ): Effect.Effect<void, UsageCacheError> => {
        // Failure envelopes are never durable and, critically, never overwrite
        // the prior row.
        if (!hasUsageQuotas(state)) return Effect.void;
        const now = new Date().toISOString();
        return engine
          .transaction("usage.save-last-good", (writer) => {
            writer.run(
              `INSERT INTO usage_state(
                 singleton,
                 snapshots_json,
                 last_live_at,
                 updated_at
               ) VALUES (1, ?, ?, ?)
               ON CONFLICT(singleton) DO UPDATE SET
                 snapshots_json = excluded.snapshots_json,
                 last_live_at = excluded.last_live_at,
                 updated_at = excluded.updated_at`,
              [
                JSON.stringify(state.snapshots),
                state.lastLiveAt ?? now,
                now,
              ],
            );
          })
          .pipe(
            Effect.asVoid,
            Effect.mapError((error) =>
              fromStateError("save-last-good", error),
            ),
            Effect.withSpan("usage-cache.save-last-good"),
          );
      };

      return UsageCache.of({
        loadLastGood,
        saveLastGood,
      });
    }),
  );

export const UsageCacheLive = makeUsageCacheLive();
