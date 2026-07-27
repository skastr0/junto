import { Context, Effect, Layer, Schema } from "effect";
import type { ServiceCheck } from "@shared/contracts";
import { StateEngine } from "../vellum/state/service";

export class StoreError extends Schema.TaggedError<StoreError>()("StoreError", {
  message: Schema.String,
}) {}

export class StoreService extends Context.Tag("@chassis/StoreService")<
  StoreService,
  {
    readonly doctor: Effect.Effect<ServiceCheck>;
    readonly get: <T>(key: string) => Effect.Effect<T | undefined, StoreError>;
    readonly set: <T>(key: string, value: T) => Effect.Effect<void, StoreError>;
  }
>() {}

const asStoreError = (operation: string, error: unknown): StoreError =>
  error instanceof StoreError
    ? error
    : new StoreError({
        message: `${operation}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });

const serializeStoreValue = (key: string, value: unknown): string => {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new Error(
      `value for ${JSON.stringify(key)} is not JSON-serializable`,
    );
  }
  return encoded;
};

const parseStoreValue = <T>(key: string, encoded: string): T => {
  try {
    return JSON.parse(encoded) as T;
  } catch (error) {
    throw new Error(
      `stored value for ${JSON.stringify(key)} is not valid JSON (${
        error instanceof Error ? error.message : String(error)
      })`,
    );
  }
};

const makeStoreService = (
  engine: Context.Tag.Service<typeof StateEngine>,
): Context.Tag.Service<typeof StoreService> =>
  StoreService.of({
    doctor: engine
      .read(
        "store.doctor",
        (reader) =>
          reader.get<{ count: number }>(
            "SELECT count(*) AS count FROM runtime_store_values",
          )?.count ?? 0,
      )
      .pipe(
        Effect.map((count): ServiceCheck => ({
          id: "store",
          label: "Local Store",
          status: "ok",
          detail: `${count} value(s) in ${engine.info.path}`,
          metadata: { database: engine.info.path },
        })),
        Effect.catchAll((error) =>
          Effect.succeed({
            id: "store",
            label: "Local Store",
            status: "error" as const,
            detail: `SQLite store unreadable: ${error.message}`,
            metadata: { database: engine.info.path },
          }),
        ),
      ),
    get: <T>(key: string) =>
      engine
        .read("store.get", (reader) => {
          const row = reader.get<{ value_json: string }>(
            "SELECT value_json FROM runtime_store_values WHERE key = ?",
            [key],
          );
          return row === undefined
            ? undefined
            : parseStoreValue<T>(key, row.value_json);
        })
        .pipe(
          Effect.mapError((error) =>
            asStoreError(`read store key ${key}`, error),
          ),
        ),
    set: <T>(key: string, value: T) =>
      Effect.try({
        try: () => serializeStoreValue(key, value),
        catch: (error) => asStoreError(`encode store key ${key}`, error),
      }).pipe(
        Effect.flatMap((valueJson) =>
          engine.transaction("store.set", (writer) => {
            writer.run(
              `
                INSERT INTO runtime_store_values(key, value_json, updated_at)
                VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
                ON CONFLICT(key) DO UPDATE SET
                  value_json = excluded.value_json,
                  updated_at = excluded.updated_at
              `,
              [key, valueJson],
            );
          }),
        ),
        Effect.mapError((error) =>
          asStoreError(`write store key ${key}`, error),
        ),
      ),
  });

/**
 * StoreLive requires the app's one StateEngine instance. It has no file
 * fallback, migration path, or secondary source of truth.
 */
export const StoreLive: Layer.Layer<StoreService, never, StateEngine> =
  Layer.effect(StoreService, Effect.map(StateEngine, makeStoreService));
