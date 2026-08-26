import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect, Layer } from "effect";
import { acquireInstallOpsFileGuard } from "./filesystem";
import { installOpsDatabasePath } from "./paths";
import {
  INSTALL_OPS_SCHEMA_SQL,
  INSTALL_OPS_SCHEMA_VERSION,
} from "./schema";
import {
  InstallOpsDeferredError,
  InstallOpsError,
  InstallOpsService,
  type BackfillMarker,
  type BackfillMarkerStatus,
  type InstallOpsServiceShape,
} from "./service";

export { BACKFILL_INLINE_MEDIA_V1, INSTALL_OPS_SCHEMA_VERSION } from "./schema";
export { installOpsDatabasePath } from "./paths";
export {
  InstallOpsDeferredError,
  InstallOpsError,
  InstallOpsService,
  type BackfillMarker,
  type BackfillMarkerStatus,
  type InstallOpsAvailability,
  type InstallOpsServiceError,
  type InstallOpsServiceShape,
} from "./service";

const BUSY_TIMEOUT_MS = 5_000;

const opsError = (
  operation: string,
  cause: unknown,
): InstallOpsError =>
  cause instanceof InstallOpsError
    ? cause
    : new InstallOpsError({
      operation,
      message: cause instanceof Error ? cause.message : String(cause),
      cause,
    });

const normalizeSchemaSql = (sql: string): string =>
  sql.replace(/\s+/gu, " ").trim().replace(/;$/u, "").toLowerCase();

const expectedSchemaSql = normalizeSchemaSql(INSTALL_OPS_SCHEMA_SQL);

type SchemaObjectRow = {
  readonly type: string;
  readonly name: string;
  readonly tbl_name: string;
  readonly sql: string | null;
};

const applicationSchema = (database: DatabaseSync): ReadonlyArray<SchemaObjectRow> =>
  database
    .prepare(
      `
        SELECT type, name, tbl_name, sql
        FROM sqlite_schema
        WHERE name NOT LIKE 'sqlite_%'
        ORDER BY type, name
      `,
    )
    .all() as SchemaObjectRow[];

const assertCurrentSchema = (database: DatabaseSync): void => {
  const objects = applicationSchema(database);
  const table = objects[0];
  if (
    objects.length !== 1 ||
    table?.type !== "table" ||
    table.name !== "backfill_markers" ||
    table.tbl_name !== "backfill_markers" ||
    table.sql === null ||
    normalizeSchemaSql(table.sql) !== expectedSchemaSql
  ) {
    throw new Error("install-ops schema does not match its recorded version");
  }
};

const schemaVersion = (database: DatabaseSync): number => {
  const row = database
    .prepare("PRAGMA user_version")
    .get() as { readonly user_version?: number | bigint } | undefined;
  const version = Number(row?.user_version ?? 0);
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new Error(`invalid install-ops schema version: ${String(version)}`);
  }
  return version;
};

const initializeFreshSchema = (database: DatabaseSync): void => {
  if (applicationSchema(database).length !== 0) {
    throw new Error(
      "unstamped install-ops database contains unexpected schema objects",
    );
  }

  let transactionOpen = false;
  try {
    database.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    database.exec(INSTALL_OPS_SCHEMA_SQL);
    database.exec(`PRAGMA user_version = ${INSTALL_OPS_SCHEMA_VERSION}`);
    assertCurrentSchema(database);
    database.exec("COMMIT");
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Preserve the schema acquisition failure.
      }
    }
    throw error;
  }
};

const acquireSchema = (database: DatabaseSync): void => {
  const version = schemaVersion(database);
  if (version === 0) {
    initializeFreshSchema(database);
  } else if (version === INSTALL_OPS_SCHEMA_VERSION) {
    assertCurrentSchema(database);
  } else {
    throw new Error(
      `unsupported install-ops schema version ${version}; expected ${INSTALL_OPS_SCHEMA_VERSION}`,
    );
  }

  const check = database
    .prepare("PRAGMA quick_check")
    .get() as { readonly quick_check?: string } | undefined;
  if (check?.quick_check !== "ok") {
    throw new Error("install-ops database failed SQLite quick_check");
  }
};

type OpenInstallOps = {
  readonly service: InstallOpsServiceShape;
  readonly close: () => void;
};

const openInstallOps = (configuredPath: string): Effect.Effect<
  OpenInstallOps,
  InstallOpsError
> =>
  Effect.try({
    try: () => {
      const fileGuard = acquireInstallOpsFileGuard(configuredPath);
      let database: DatabaseSync | undefined;
      try {
        database = new DatabaseSync(fileGuard.path, {
          open: true,
          readOnly: false,
          allowExtension: false,
          enableForeignKeyConstraints: true,
          enableDoubleQuotedStringLiterals: false,
          allowBareNamedParameters: false,
          allowUnknownNamedParameters: false,
          timeout: BUSY_TIMEOUT_MS,
        });

        // The constructor has opened the pathname, but no statement has run.
        // Recheck the pinned inode before the first PRAGMA or schema write.
        fileGuard.verifyPostOpen();

        database.exec(`
          PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};
          PRAGMA foreign_keys = ON;
          PRAGMA trusted_schema = OFF;
        `);
        acquireSchema(database);
        // WAL is persistent. Apply it only after version and shape admission.
        database.exec(`
          PRAGMA journal_mode = WAL;
          PRAGMA synchronous = NORMAL;
        `);

        const getRow = database.prepare(
          `
            SELECT id, status, objects_ingested, completed_at
            FROM backfill_markers
            WHERE id = ?
          `,
        );
        const ensurePending = database.prepare(
          `
            INSERT INTO backfill_markers(id, status, objects_ingested, completed_at)
            VALUES (?, 'pending', 0, NULL)
            ON CONFLICT(id) DO NOTHING
          `,
        );
        const reopenPending = database.prepare(
          `
            INSERT INTO backfill_markers(id, status, objects_ingested, completed_at)
            VALUES (?, 'pending', 0, NULL)
            ON CONFLICT(id) DO UPDATE SET
              status = 'pending',
              completed_at = NULL
          `,
        );
        const markComplete = database.prepare(
          `
            INSERT INTO backfill_markers(id, status, objects_ingested, completed_at)
            VALUES (?, 'complete', ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              status = 'complete',
              objects_ingested = excluded.objects_ingested,
              completed_at = excluded.completed_at
          `,
        );

        let closed = false;
        const requireOpen = (): void => {
          if (closed) throw new Error("install-ops database is closed");
        };
        const service: InstallOpsServiceShape = {
          path: fileGuard.path,
          availability: { status: "available" },
          getBackfill: (id) =>
            Effect.try({
              try: () => {
                requireOpen();
                const row = getRow.get(id) as
                  | {
                    readonly id: string;
                    readonly status: string;
                    readonly objects_ingested: number | bigint;
                    readonly completed_at: string | null;
                  }
                  | undefined;
                if (row === undefined) return undefined;
                if (row.status !== "pending" && row.status !== "complete") {
                  throw new Error(`invalid backfill status: ${row.status}`);
                }
                return {
                  id: row.id,
                  status: row.status as BackfillMarkerStatus,
                  objectsIngested: Number(row.objects_ingested),
                  completedAt: row.completed_at ?? undefined,
                } satisfies BackfillMarker;
              },
              catch: (cause) => opsError("getBackfill", cause),
            }),
          ensurePending: (id) =>
            Effect.try({
              try: () => {
                requireOpen();
                ensurePending.run(id);
              },
              catch: (cause) => opsError("ensurePending", cause),
            }),
          reopenPending: (id) =>
            Effect.try({
              try: () => {
                requireOpen();
                reopenPending.run(id);
              },
              catch: (cause) => opsError("reopenPending", cause),
            }),
          markComplete: (id, objectsIngested) =>
            Effect.try({
              try: () => {
                requireOpen();
                markComplete.run(
                  id,
                  objectsIngested,
                  new Date().toISOString(),
                );
              },
              catch: (cause) => opsError("markComplete", cause),
            }),
        };

        const close = (): void => {
          if (closed) return;
          closed = true;
          let closeFailure: unknown;
          try {
            database!.close();
          } catch (error) {
            closeFailure = error;
          }
          try {
            fileGuard.close();
          } catch (error) {
            closeFailure ??= error;
          }
          if (closeFailure !== undefined) throw closeFailure;
        };

        return { service, close };
      } catch (cause) {
        if (database !== undefined) {
          try {
            database.close();
          } catch {
            // Preserve the setup error; SQLite close was still attempted.
          }
        }
        try {
          fileGuard.close();
        } catch {
          // Preserve the setup error; descriptor close was still attempted.
        }
        throw cause;
      }
    },
    catch: (cause) => opsError("open", cause),
  });

const deferredService = (
  path: string,
  acquisitionError: InstallOpsError,
): InstallOpsServiceShape => {
  const deferred = (operation: string) =>
    new InstallOpsDeferredError({
      path,
      operation,
      message:
        "install-ops ledger is unavailable; backfill reconciliation is deferred",
      cause: acquisitionError,
    });
  const reason = deferred("acquire");

  return {
    path,
    availability: { status: "unavailable", reason },
    getBackfill: () => Effect.fail(deferred("getBackfill")),
    ensurePending: () => Effect.fail(deferred("ensurePending")),
    reopenPending: () => Effect.fail(deferred("reopenPending")),
    markComplete: () => Effect.fail(deferred("markComplete")),
  };
};

export const makeInstallOpsLive = (
  path?: string,
): Layer.Layer<InstallOpsService> => {
  const resolvedPath = resolve(path ?? installOpsDatabasePath());
  return Layer.effect(
    InstallOpsService,
    Effect.acquireRelease(
      openInstallOps(resolvedPath),
      ({ close }) => Effect.sync(close),
    ).pipe(
      Effect.map(({ service }) => service),
      Effect.catch((error) =>
        Effect.sync(() => {
          console.error(
            "[install-ops] ledger unavailable; backfills deferred until a later boot:",
            error,
          );
          return deferredService(resolvedPath, error);
        }),
      ),
    ),
  );
};

export const InstallOpsLive = makeInstallOpsLive();
