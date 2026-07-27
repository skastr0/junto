import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Context, Effect, Either, Layer, Schema } from "effect";
import {
  hasUsageQuotas,
  UsageSnapshot,
  UsageState,
  type UsageState as UsageStateValue,
} from "@shared/usage";
import {
  StateEngine,
  type StateEngineError,
  type StateReader,
} from "../state/service";
import { USAGE_STATE_SCHEMA_SQL } from "./state-schema";

export { USAGE_STATE_SCHEMA_SQL } from "./state-schema";

export const legacyUsageCachePath = (): string =>
  resolve(join(homedir(), ".vellum", "cache", "usage-state.json"));

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
  readonly snapshots_json: string | null;
  readonly last_live_at: string | null;
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
      const decoded = Schema.decodeUnknownEither(Schema.Array(UsageSnapshot))(
        parsed,
      );
      return Either.isRight(decoded)
        ? Effect.succeed(decoded.right)
        : Effect.fail(usageCacheError(operation, decoded.left));
    }),
  );

const decodeRow = (
  row: UsageStateRow | undefined,
): Effect.Effect<UsageStateValue | undefined, UsageCacheError> => {
  if (row?.snapshots_json == null) return Effect.succeed(undefined);
  return decodeSnapshots("load.decode", row.snapshots_json).pipe(
    Effect.flatMap((snapshots) => {
      const state: UsageStateValue = {
        snapshots: [...snapshots],
        stale: true,
        ...(row.last_live_at !== null
          ? { lastLiveAt: row.last_live_at }
          : {}),
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

/**
 * Legacy JSON is an untrusted, best-effort import source. Once decoded it is
 * normalized to the same narrow last-good shape as SQLite. Parse/schema
 * failures intentionally collapse to `undefined`; they cannot affect any
 * other state table.
 */
const readLegacyLastGood = (
  path: string,
): UsageStateValue | undefined => {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    const decoded = Schema.decodeUnknownEither(UsageState)(parsed);
    if (Either.isLeft(decoded) || !hasUsageQuotas(decoded.right)) {
      return undefined;
    }
    return {
      snapshots: decoded.right.snapshots,
      stale: true,
      ...(decoded.right.lastLiveAt !== undefined
        ? { lastLiveAt: decoded.right.lastLiveAt }
        : {}),
    };
  } catch {
    return undefined;
  }
};

export type UsageCacheOptions = {
  readonly legacyPath?: string;
};

export const makeUsageCacheLive = (
  options: UsageCacheOptions = {},
): Layer.Layer<UsageCache, never, StateEngine> =>
  Layer.effect(
    UsageCache,
    Effect.gen(function* () {
      const engine = yield* StateEngine;
      const legacyPath = resolve(options.legacyPath ?? legacyUsageCachePath());

      const loadLastGood = Effect.gen(function* () {
        const current = yield* engine
          .read("usage.load", selectUsageState)
          .pipe(Effect.mapError((error) => fromStateError("load", error)));
        if (current !== undefined) return yield* decodeRow(current);

        // Read outside the transaction. The transaction checks the singleton
        // again, so a concurrent first refresh/import can only win once.
        const legacy = readLegacyLastGood(legacyPath);
        const imported = yield* engine
          .transaction("usage.import-legacy", (writer) => {
            const raced = selectUsageState(writer);
            if (raced !== undefined) return raced;
            const now = new Date().toISOString();
            writer.run(
              `INSERT INTO usage_state(
                 singleton,
                 snapshots_json,
                 last_live_at,
                 legacy_imported_at,
                 updated_at
               ) VALUES (1, ?, ?, ?, ?)`,
              [
                legacy === undefined
                  ? null
                  : JSON.stringify(legacy.snapshots),
                legacy?.lastLiveAt ?? null,
                now,
                now,
              ],
            );
            return selectUsageState(writer);
          })
          .pipe(
            Effect.mapError((error) =>
              fromStateError("import-legacy", error),
            ),
          );
        return yield* decodeRow(imported);
      }).pipe(Effect.withSpan("usage-cache.load-last-good"));

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
                 legacy_imported_at,
                 updated_at
               ) VALUES (1, ?, ?, ?, ?)
               ON CONFLICT(singleton) DO UPDATE SET
                 snapshots_json = excluded.snapshots_json,
                 last_live_at = excluded.last_live_at,
                 updated_at = excluded.updated_at`,
              [
                JSON.stringify(state.snapshots),
                state.lastLiveAt ?? now,
                now,
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
