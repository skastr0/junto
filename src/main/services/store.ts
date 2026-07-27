import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { app } from "electron";
import { Context, Effect, Layer, Schema } from "effect";
import type { ServiceCheck } from "@shared/contracts";
import { StateEngine, type StateWriter } from "../vellum/state/service";

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

type StoreImportStatus = "absent" | "imported" | "skipped-existing";

type StoreImportReceipt = {
  readonly status: StoreImportStatus;
  readonly legacyPath: string;
  readonly importedKeyCount: number;
};

type StoreStartup =
  | {
      readonly _tag: "Ready";
      readonly receipt: StoreImportReceipt;
    }
  | {
      readonly _tag: "Fault";
      readonly error: StoreError;
    };

type LegacyStoreCandidate =
  | {
      readonly status: "absent";
      readonly entries: ReadonlyArray<readonly [string, string]>;
    }
  | {
      readonly status: "imported";
      readonly entries: ReadonlyArray<readonly [string, string]>;
    };

export interface StoreLiveOptions {
  /** Test/import override. Production imports Electron's former userData file. */
  readonly legacyPath?: string;
}

const defaultLegacyStorePath = (): string =>
  join(app.getPath("userData"), "store.json");

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

const readLegacyCandidate = (
  legacyPath: string,
): Effect.Effect<LegacyStoreCandidate, StoreError> =>
  Effect.tryPromise({
    try: async () => {
      let raw: string;
      try {
        raw = await readFile(legacyPath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return { status: "absent", entries: [] } as const;
        }
        throw error;
      }

      const decoded = JSON.parse(raw) as unknown;
      if (
        decoded === null ||
        typeof decoded !== "object" ||
        Array.isArray(decoded)
      ) {
        throw new Error("legacy store root must be a JSON object");
      }
      const entries = Object.entries(decoded).map(
        ([key, value]) => [key, serializeStoreValue(key, value)] as const,
      );
      return { status: "imported", entries } as const;
    },
    catch: (error) =>
      asStoreError(
        `store.json unreadable at ${legacyPath} — refusing to treat as empty`,
        error,
      ),
  });

const existingImportReceipt = (
  writer: StateWriter,
): StoreImportReceipt | undefined => {
  const row = writer.get<{
    status: StoreImportStatus;
    legacy_path: string;
    imported_key_count: number;
  }>(
    `
      SELECT status, legacy_path, imported_key_count
      FROM runtime_store_legacy_import
      WHERE singleton = 1
    `,
  );
  return row === undefined
    ? undefined
    : {
        status: row.status,
        legacyPath: row.legacy_path,
        importedKeyCount: row.imported_key_count,
      };
};

const recordImportReceipt = (
  writer: StateWriter,
  receipt: StoreImportReceipt,
): void => {
  writer.run(
    `
      INSERT INTO runtime_store_legacy_import(
        singleton,
        status,
        legacy_path,
        imported_key_count,
        completed_at
      )
      VALUES (1, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    `,
    [receipt.status, receipt.legacyPath, receipt.importedKeyCount],
  );
};

const ensureLegacyImport = (
  engine: Context.Tag.Service<typeof StateEngine>,
  legacyPath: string,
): Effect.Effect<StoreImportReceipt, StoreError> =>
  Effect.gen(function* () {
    const state = yield* engine
      .read("store.import.inspect", (reader) => ({
        receipt: reader.get<{
          status: StoreImportStatus;
          legacy_path: string;
          imported_key_count: number;
        }>(
          `
          SELECT status, legacy_path, imported_key_count
          FROM runtime_store_legacy_import
          WHERE singleton = 1
        `,
        ),
        valueCount:
          reader.get<{ count: number }>(
            "SELECT count(*) AS count FROM runtime_store_values",
          )?.count ?? 0,
      }))
      .pipe(
        Effect.mapError((error) =>
          asStoreError("inspect runtime store", error),
        ),
      );

    if (state.receipt !== undefined) {
      return {
        status: state.receipt.status,
        legacyPath: state.receipt.legacy_path,
        importedKeyCount: state.receipt.imported_key_count,
      };
    }

    if (state.valueCount > 0) {
      return yield* engine
        .transaction("store.import.skip-existing", (writer) => {
          const existing = existingImportReceipt(writer);
          if (existing !== undefined) return existing;
          const receipt: StoreImportReceipt = {
            status: "skipped-existing",
            legacyPath,
            importedKeyCount: 0,
          };
          recordImportReceipt(writer, receipt);
          return receipt;
        })
        .pipe(
          Effect.mapError((error) =>
            asStoreError("record runtime store import state", error),
          ),
        );
    }

    const candidate = yield* readLegacyCandidate(legacyPath);
    return yield* engine
      .transaction("store.import.legacy", (writer) => {
        const existing = existingImportReceipt(writer);
        if (existing !== undefined) return existing;
        const valueCount =
          writer.get<{ count: number }>(
            "SELECT count(*) AS count FROM runtime_store_values",
          )?.count ?? 0;
        if (valueCount > 0) {
          const receipt: StoreImportReceipt = {
            status: "skipped-existing",
            legacyPath,
            importedKeyCount: 0,
          };
          recordImportReceipt(writer, receipt);
          return receipt;
        }

        for (const [key, valueJson] of candidate.entries) {
          writer.run(
            `
            INSERT INTO runtime_store_values(key, value_json, updated_at)
            VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
          `,
            [key, valueJson],
          );
        }
        const receipt: StoreImportReceipt = {
          status: candidate.status,
          legacyPath,
          importedKeyCount: candidate.entries.length,
        };
        recordImportReceipt(writer, receipt);
        return receipt;
      })
      .pipe(
        Effect.mapError((error) =>
          asStoreError("import legacy runtime store", error),
        ),
      );
  });

const makeStoreService = (
  engine: Context.Tag.Service<typeof StateEngine>,
  startup: StoreStartup,
): Context.Tag.Service<typeof StoreService> =>
  StoreService.of({
    doctor:
      startup._tag === "Fault"
        ? Effect.succeed({
            id: "store",
            label: "Local Store",
            status: "error" as const,
            detail: startup.error.message,
            metadata: { database: engine.info.path },
          })
        : engine
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
                metadata: {
                  database: engine.info.path,
                  legacyImport: startup.receipt.status,
                  legacyImportedKeys: String(startup.receipt.importedKeyCount),
                },
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
      startup._tag === "Fault"
        ? Effect.fail(startup.error)
        : engine
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
      startup._tag === "Fault"
        ? Effect.fail(startup.error)
        : Effect.try({
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

export const makeStoreLive = (
  options: StoreLiveOptions = {},
): Layer.Layer<StoreService, never, StateEngine> =>
  Layer.effect(
    StoreService,
    Effect.gen(function* () {
      const engine = yield* StateEngine;
      const legacyPath = resolve(
        options.legacyPath ?? defaultLegacyStorePath(),
      );
      const imported = yield* Effect.either(
        ensureLegacyImport(engine, legacyPath),
      );
      return makeStoreService(
        engine,
        imported._tag === "Right"
          ? { _tag: "Ready", receipt: imported.right }
          : { _tag: "Fault", error: imported.left },
      );
    }),
  );

/**
 * StoreLive requires the app's one StateEngine instance. The app layer must
 * provide that dependency; StoreService never opens SQLite (or any file)
 * itself after the one-shot legacy import.
 */
export const StoreLive = makeStoreLive();
