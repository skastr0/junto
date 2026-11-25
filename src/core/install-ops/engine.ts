import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { Effect, Layer } from "effect";
import { acquireInstallOpsFileGuard } from "./filesystem";
import { installOpsDatabasePath } from "./paths";
import {
  INSTALL_OPS_SCHEMA_SQL,
  INSTALL_OPS_SCHEMA_VERSION,
  INSTALL_OPS_V1_SCHEMA_SQL,
  INSTALL_OPS_V2_SCHEMA_SQL,
  INSTALL_OPS_V3_SCHEMA_SQL,
  MACHINE_SETUP_REFUSALS_SQL,
  MACHINE_UPDATE_ATTEMPTS_SQL,
  MACHINE_UPDATE_LATCHES_SQL,
} from "./schema";
import {
  InstallOpsDeferredError,
  InstallOpsError,
  InstallOpsService,
  type BackfillMarker,
  type BackfillMarkerStatus,
  type InstallOpsAvailability,
  type InstallOpsServiceError,
  type InstallOpsServiceShape,
  type MachineSetupRefusal,
  type MachineUpdateLatch,
} from "./service";

export {
  BACKFILL_ARTIFACT_LINKS_V1,
  BACKFILL_INLINE_MEDIA_V1,
  BACKFILL_CANVAS_RELATIONAL_V1,
  BACKFILL_CANVAS_RELATIONAL_V2,
  INSTALL_OPS_SCHEMA_VERSION,
} from "./schema";
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
  type MachineSetupRefusal,
  type MachineUpdateLatch,
} from "./service";

const BUSY_TIMEOUT_MS = 5_000;
const INSTALL_OPS_APPLICATION_ID = 0;

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

const serviceError = (
  operation: string,
  cause: unknown,
): InstallOpsServiceError =>
  cause instanceof InstallOpsError || cause instanceof InstallOpsDeferredError
    ? cause
    : opsError(operation, cause);

const storedSchemaSql = (sql: string): string =>
  sql.trim().replace(/;$/u, "");

const expectedSchemaSql = storedSchemaSql(INSTALL_OPS_SCHEMA_SQL);
const expectedV1SchemaSql = storedSchemaSql(INSTALL_OPS_V1_SCHEMA_SQL);
const expectedV2SchemaSql = storedSchemaSql(INSTALL_OPS_V2_SCHEMA_SQL);
const expectedV3SchemaSql = storedSchemaSql(INSTALL_OPS_V3_SCHEMA_SQL);

const EXPECTED_V1_SCHEMA_OBJECTS = [
  { type: "index", name: "sqlite_autoindex_backfill_markers_1", tbl_name: "backfill_markers", sql: null },
  { type: "table", name: "backfill_markers", tbl_name: "backfill_markers", sql: expectedV1SchemaSql },
] as const;

const EXPECTED_V2_SCHEMA_OBJECTS = [
  { type: "index", name: "sqlite_autoindex_backfill_markers_1", tbl_name: "backfill_markers", sql: null },
  { type: "index", name: "sqlite_autoindex_machine_update_latches_1", tbl_name: "machine_update_latches", sql: null },
  { type: "table", name: "backfill_markers", tbl_name: "backfill_markers", sql: expectedV1SchemaSql },
  { type: "table", name: "machine_update_latches", tbl_name: "machine_update_latches", sql: storedSchemaSql(MACHINE_UPDATE_LATCHES_SQL) },
] as const;

const EXPECTED_V3_SCHEMA_OBJECTS = [
  { type: "index", name: "sqlite_autoindex_backfill_markers_1", tbl_name: "backfill_markers", sql: null },
  { type: "index", name: "sqlite_autoindex_machine_update_attempts_1", tbl_name: "machine_update_attempts", sql: null },
  { type: "index", name: "sqlite_autoindex_machine_update_latches_1", tbl_name: "machine_update_latches", sql: null },
  { type: "table", name: "backfill_markers", tbl_name: "backfill_markers", sql: expectedV1SchemaSql },
  { type: "table", name: "machine_update_attempts", tbl_name: "machine_update_attempts", sql: storedSchemaSql(MACHINE_UPDATE_ATTEMPTS_SQL) },
  { type: "table", name: "machine_update_latches", tbl_name: "machine_update_latches", sql: storedSchemaSql(MACHINE_UPDATE_LATCHES_SQL) },
] as const;

const EXPECTED_SCHEMA_OBJECTS = [
  { type: "index", name: "sqlite_autoindex_backfill_markers_1", tbl_name: "backfill_markers", sql: null },
  { type: "index", name: "sqlite_autoindex_machine_setup_refusals_1", tbl_name: "machine_setup_refusals", sql: null },
  { type: "index", name: "sqlite_autoindex_machine_update_attempts_1", tbl_name: "machine_update_attempts", sql: null },
  { type: "index", name: "sqlite_autoindex_machine_update_latches_1", tbl_name: "machine_update_latches", sql: null },
  { type: "table", name: "backfill_markers", tbl_name: "backfill_markers", sql: expectedV1SchemaSql },
  { type: "table", name: "machine_setup_refusals", tbl_name: "machine_setup_refusals", sql: storedSchemaSql(MACHINE_SETUP_REFUSALS_SQL) },
  { type: "table", name: "machine_update_attempts", tbl_name: "machine_update_attempts", sql: storedSchemaSql(MACHINE_UPDATE_ATTEMPTS_SQL) },
  { type: "table", name: "machine_update_latches", tbl_name: "machine_update_latches", sql: storedSchemaSql(MACHINE_UPDATE_LATCHES_SQL) },
] as const;

type SchemaObjectRow = {
  readonly type: string;
  readonly name: string;
  readonly tbl_name: string;
  readonly sql: string | null;
};

type DatabaseFingerprint = {
  readonly userVersion: number;
  readonly applicationId: number;
  readonly journalMode: string;
  readonly schema: ReadonlyArray<SchemaObjectRow>;
};

type AdmittedDatabaseKind = "fresh" | "current" | "previous-v3" | "previous-v2" | "previous-v1";

const integerPragma = (
  database: DatabaseSync,
  sql: string,
  column: string,
): number => {
  const row = database.prepare(sql).get() as
    | Readonly<Record<string, number | bigint | undefined>>
    | undefined;
  const value = Number(row?.[column] ?? Number.NaN);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`invalid install-ops ${column}: ${String(row?.[column])}`);
  }
  return value;
};

const textPragma = (
  database: DatabaseSync,
  sql: string,
  column: string,
): string => {
  const row = database.prepare(sql).get() as
    | Readonly<Record<string, string | undefined>>
    | undefined;
  const value = row?.[column];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`invalid install-ops ${column}: ${String(value)}`);
  }
  return value.toLowerCase();
};

const schemaObjects = (database: DatabaseSync): ReadonlyArray<SchemaObjectRow> =>
  database
    .prepare(
      `
        SELECT type, name, tbl_name, sql
        FROM sqlite_schema
        ORDER BY type, name
      `,
    )
    .all() as SchemaObjectRow[];

const assertDatabaseChecks = (database: DatabaseSync): void => {
  const quickRows = database.prepare("PRAGMA quick_check").all() as Array<{
    readonly quick_check?: string;
  }>;
  if (quickRows.length !== 1 || quickRows[0]?.quick_check !== "ok") {
    throw new Error("install-ops database failed SQLite quick_check");
  }

  const integrityRows = database.prepare("PRAGMA integrity_check").all() as Array<{
    readonly integrity_check?: string;
  }>;
  if (
    integrityRows.length !== 1 ||
    integrityRows[0]?.integrity_check !== "ok"
  ) {
    throw new Error("install-ops database failed SQLite integrity_check");
  }
};

/**
 * Run only read statements through the actual SQLite connection. Normal
 * families open their first actual connection read-only. A hot rollback
 * journal reaches the original only after an app-created clone recovered to
 * this exact fingerprint. Thus a constructor-time product version/table swap
 * is rejected before an application write even when its pathname is restored.
 *
 * The later read-write connection is fingerprinted again before setup. These
 * checks plus the descriptor-pinned full family are the strongest preflight
 * stock `DatabaseSync` exposes; it has no fd handoff or custom-VFS hook.
 */
const inspectDatabase = (database: DatabaseSync): DatabaseFingerprint => {
  const fingerprint = {
    userVersion: integerPragma(database, "PRAGMA user_version", "user_version"),
    applicationId: integerPragma(
      database,
      "PRAGMA application_id",
      "application_id",
    ),
    journalMode: textPragma(
      database,
      "PRAGMA journal_mode",
      "journal_mode",
    ),
    schema: schemaObjects(database),
  } satisfies DatabaseFingerprint;
  assertDatabaseChecks(database);
  return fingerprint;
};

const schemaIsExact = (schema: ReadonlyArray<SchemaObjectRow>, expectedObjects: typeof EXPECTED_SCHEMA_OBJECTS | typeof EXPECTED_V3_SCHEMA_OBJECTS | typeof EXPECTED_V2_SCHEMA_OBJECTS | typeof EXPECTED_V1_SCHEMA_OBJECTS): boolean =>
  schema.length === expectedObjects.length &&
  schema.every((row, index) => {
    const expected = expectedObjects[index];
    return (
      expected !== undefined &&
      row.type === expected.type &&
      row.name === expected.name &&
      row.tbl_name === expected.tbl_name &&
      (row.sql === null
        ? expected.sql === null
        : expected.sql !== null && row.sql === expected.sql)
    );
  });

const admitFingerprint = (
  fingerprint: DatabaseFingerprint,
  allowFresh: boolean,
): AdmittedDatabaseKind => {
  if (
    fingerprint.applicationId === INSTALL_OPS_APPLICATION_ID &&
    fingerprint.userVersion === INSTALL_OPS_SCHEMA_VERSION &&
    schemaIsExact(fingerprint.schema, EXPECTED_SCHEMA_OBJECTS)
  ) {
    return "current";
  }

  if (
    fingerprint.applicationId === INSTALL_OPS_APPLICATION_ID &&
    fingerprint.userVersion === 3 &&
    schemaIsExact(fingerprint.schema, EXPECTED_V3_SCHEMA_OBJECTS)
  ) {
    return "previous-v3";
  }

  if (
    fingerprint.applicationId === INSTALL_OPS_APPLICATION_ID &&
    fingerprint.userVersion === 2 &&
    schemaIsExact(fingerprint.schema, EXPECTED_V2_SCHEMA_OBJECTS)
  ) {
    return "previous-v2";
  }

  if (
    fingerprint.applicationId === INSTALL_OPS_APPLICATION_ID &&
    fingerprint.userVersion === 1 &&
    schemaIsExact(fingerprint.schema, EXPECTED_V1_SCHEMA_OBJECTS)
  ) {
    return "previous-v1";
  }

  if (
    allowFresh &&
    fingerprint.applicationId === INSTALL_OPS_APPLICATION_ID &&
    fingerprint.userVersion === 0 &&
    fingerprint.schema.length === 0
  ) {
    return "fresh";
  }

  throw new Error(
    "opened database is neither the app-created empty install-ops inode " +
      "nor its exact current schema",
  );
};

const assertCurrentSchema = (database: DatabaseSync): void => {
  const kind = admitFingerprint(inspectDatabase(database), false);
  if (kind !== "current") {
    throw new Error("install-ops schema does not match its recorded version");
  }
};

const migratePreviousSchema = (database: DatabaseSync, kind: "previous-v1" | "previous-v2" | "previous-v3"): void => {
  let open = false;
  try {
    database.exec("BEGIN IMMEDIATE");
    open = true;
    if (kind === "previous-v1") database.exec(MACHINE_UPDATE_LATCHES_SQL);
    if (kind !== "previous-v3") database.exec(MACHINE_UPDATE_ATTEMPTS_SQL);
    database.exec(MACHINE_SETUP_REFUSALS_SQL);
    database.exec(`PRAGMA user_version = ${INSTALL_OPS_SCHEMA_VERSION}`);
    database.exec("COMMIT");
    open = false;
  } catch (error) {
    if (open) {
      try { database.exec("ROLLBACK"); } catch { /* keep the migration failure */ }
    }
    throw error;
  }
  assertCurrentSchema(database);
};

const initializeFreshSchema = (database: DatabaseSync): void => {
  let transactionOpen = false;
  try {
    database.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    database.exec(INSTALL_OPS_SCHEMA_SQL);
    database.exec(`PRAGMA user_version = ${INSTALL_OPS_SCHEMA_VERSION}`);
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

const databaseLocation = (path: string, mode: "ro" | "rw"): URL => {
  const location = pathToFileURL(path);
  // Stock SQLite URI mode makes both opens existing-only. If the guarded main
  // pathname disappears, SQLite must fail instead of recreating a new inode.
  location.searchParams.set("mode", mode);
  return location;
};

const databaseOptions = (readOnly: boolean) => ({
  open: true,
  readOnly,
  allowExtension: false,
  // Enable connection policy only after the actual opened database passes its
  // read-only fingerprint. The install-ops schema has no foreign keys.
  enableForeignKeyConstraints: false,
  enableDoubleQuotedStringLiterals: false,
  allowBareNamedParameters: false,
  allowUnknownNamedParameters: false,
  defensive: true,
  timeout: BUSY_TIMEOUT_MS,
});

const createFreshDatabaseBytes = (): Uint8Array => {
  const database = new DatabaseSync(":memory:", databaseOptions(false));
  try {
    database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA trusted_schema = OFF;
    `);
    initializeFreshSchema(database);
    assertCurrentSchema(database);
    const serialize = (
      database as unknown as { readonly serialize?: () => Uint8Array }
    ).serialize;
    if (typeof serialize !== "function") {
      throw new Error("shipped SQLite runtime lacks in-memory serialization");
    }
    return serialize.call(database);
  } finally {
    database.close();
  }
};

type OpenInstallOps = {
  readonly service: InstallOpsServiceShape;
  readonly close: () => void;
};

const deferredError = (
  path: string,
  operation: string,
  cause: unknown,
): InstallOpsDeferredError =>
  new InstallOpsDeferredError({
    path,
    operation,
    message:
      "install-ops ledger is unavailable; backfill reconciliation is deferred",
    cause,
  });

const openInstallOps = (configuredPath: string): Effect.Effect<
  OpenInstallOps,
  InstallOpsError
> =>
  Effect.try({
    try: () => {
      const fileGuard = acquireInstallOpsFileGuard(
        configuredPath,
        createFreshDatabaseBytes,
      );
      let inspectionDatabase: DatabaseSync | undefined;
      let database: DatabaseSync | undefined;
      try {
        fileGuard.verifyFamily();
        const startupFamily = fileGuard.classifyStartupFamily();
        let inspectedKind: AdmittedDatabaseKind;
        let inspectedJournalMode: string;

        if (startupFamily === "hot-rollback-zero-origin") {
          throw new Error(
            "zero-origin install-ops recovery lacks app-minted provenance",
          );
        }

        if (startupFamily === "hot-rollback") {
          // A truly hot rollback journal cannot be queried through SQLite's
          // read-only connection. Recover an app-created byte-for-byte clone
          // first. Only an exact recovered install-ops schema authorizes the
          // later writable recovery of the original admitted family.
          const recovered = fileGuard.withRollbackRecoveryClone(
            (recoveryPath) => {
              const recoveryDatabase = new DatabaseSync(
                databaseLocation(recoveryPath, "rw"),
                databaseOptions(false),
              );
              try {
                const fingerprint = inspectDatabase(recoveryDatabase);
                const kind = admitFingerprint(fingerprint, false);
                if (
                  kind === "fresh" ||
                  fingerprint.journalMode !== "delete"
                ) {
                  throw new Error(
                    "recovered install-ops clone has an unexpected format",
                  );
                }
                return fingerprint;
              } finally {
                recoveryDatabase.close();
              }
            },
          );
          inspectedKind = "current";
          inspectedJournalMode = recovered.journalMode;
          fileGuard.verifyFamily();
        } else {
          if (startupFamily === "wal-recovery") {
            const recovered = fileGuard.withWalRecoveryClone(
              (recoveryPath) => {
                const recoveryDatabase = new DatabaseSync(
                  databaseLocation(recoveryPath, "ro"),
                  databaseOptions(true),
                );
                try {
                  const fingerprint = inspectDatabase(recoveryDatabase);
                  const kind = admitFingerprint(fingerprint, false);
                  if (
                    kind === "fresh" ||
                    fingerprint.journalMode !== "wal"
                  ) {
                    throw new Error(
                      "recovered install-ops WAL clone has an unexpected format",
                    );
                  }
                  return fingerprint;
                } finally {
                  recoveryDatabase.close();
                }
              },
            );
            if (recovered.journalMode !== "wal") {
              throw new Error(
                "clone-validated install-ops WAL changed journal mode",
              );
            }
            fileGuard.verifyFamily();
          }

          inspectionDatabase = new DatabaseSync(
            databaseLocation(fileGuard.path, "ro"),
            databaseOptions(true),
          );
          const fingerprint = inspectDatabase(inspectionDatabase);
          inspectedKind = admitFingerprint(
            fingerprint,
            fileGuard.mainCreated,
          );
          inspectedJournalMode = fingerprint.journalMode;
          if (
            (startupFamily === "quiescent" &&
              fingerprint.journalMode !== "delete") ||
            ((startupFamily === "wal-clean" ||
              startupFamily === "wal-recovery") &&
              fingerprint.journalMode !== "wal")
          ) {
            throw new Error(
              "install-ops SQLite header and connection journal modes disagree",
            );
          }
          fileGuard.verifyFamily();
        }

        // Keep a successful admitted read-only connection live while the
        // writable connection opens. Clone-validated hot-journal recovery has
        // no live read connection because it would block SQLite recovery.
        database = new DatabaseSync(
          databaseLocation(fileGuard.path, "rw"),
          databaseOptions(false),
        );
        const writableFingerprint = inspectDatabase(database);
        const writableKind = admitFingerprint(
          writableFingerprint,
          inspectedKind === "fresh" && fileGuard.mainCreated,
        );
        if (
          writableKind !== inspectedKind ||
          writableFingerprint.journalMode !== inspectedJournalMode
        ) {
          throw new Error(
            "install-ops database identity changed between inspection and writable open",
          );
        }
        if (writableKind === "previous-v1" || writableKind === "previous-v2" || writableKind === "previous-v3") migratePreviousSchema(database, writableKind);
        fileGuard.verifyFamily();

        if (inspectionDatabase !== undefined) {
          inspectionDatabase.close();
          inspectionDatabase = undefined;
          fileGuard.verifyFamily();
        }

        // Classify every existing sidecar before any application PRAGMA. A
        // DELETE database must be quiescent; a WAL database may carry WAL/SHM
        // for recovery, but never an unrelated rollback journal too.
        if (writableFingerprint.journalMode === "delete") {
          fileGuard.verifyQuiescent();
        } else if (writableFingerprint.journalMode === "wal") {
          fileGuard.verifyNoRollbackJournal();
        } else {
          throw new Error(
            `unsupported install-ops journal mode: ${writableFingerprint.journalMode}`,
          );
        }

        // Every PRAGMA below runs only after both actual connections and the
        // complete file family passed admission.
        fileGuard.verifyFamily();
        database.exec(`
          PRAGMA foreign_keys = ON;
          PRAGMA trusted_schema = OFF;
          PRAGMA synchronous = FULL;
        `);
        fileGuard.verifyFamily();

        // Use rollback journaling for this tiny advisory ledger. Legacy WAL and
        // SHM leaves were admitted and pinned before either connection opened;
        // this exact switch checkpoints them and leaves no persistent sidecar.
        fileGuard.verifyFamily();
        const journal = database
          .prepare("PRAGMA journal_mode = DELETE")
          .get() as { readonly journal_mode?: string } | undefined;
        if (journal?.journal_mode?.toLowerCase() !== "delete") {
          throw new Error("install-ops could not enter rollback-journal mode");
        }
        fileGuard.verifyFamily();
        // SQLite itself must checkpoint and remove every admitted legacy
        // WAL/SHM leaf. The app never unlinks a pre-existing family member.
        fileGuard.verifyQuiescent();

        // Schema acquisition is the first application write for a new ledger.
        // Existing empty files are never initialized: only the O_EXCL inode
        // minted by this acquisition can carry the `fresh` classification.
        fileGuard.verifyFamily();
        if (writableKind === "fresh") initializeFreshSchema(database);
        assertCurrentSchema(database);
        fileGuard.verifyFamily();
        fileGuard.verifyQuiescent();

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
        const readUpdateLatch = database.prepare(
          "SELECT installation_id, target_build, outcome, at FROM machine_update_attempts WHERE installation_id = ?",
        );
        const writeUpdateLatch = database.prepare(
          `INSERT INTO machine_update_attempts(installation_id, target_build, outcome, at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(installation_id) DO UPDATE SET
             target_build = excluded.target_build,
             outcome = excluded.outcome,
             at = excluded.at`,
        );
        const deleteUpdateLatch = database.prepare("DELETE FROM machine_update_attempts WHERE installation_id = ?");
        const readSetupRefusal = database.prepare(
          "SELECT machine_name, installation_id, route, recorded_at FROM machine_setup_refusals WHERE machine_name = ?",
        );
        const writeSetupRefusal = database.prepare(
          `INSERT INTO machine_setup_refusals(machine_name, installation_id, route, recorded_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(machine_name) DO UPDATE SET
             installation_id = excluded.installation_id,
             route = excluded.route,
             recorded_at = excluded.recorded_at`,
        );
        const deleteSetupRefusal = database.prepare("DELETE FROM machine_setup_refusals WHERE machine_name = ?");
        fileGuard.verifyQuiescent();

        let closed = false;
        let unavailableReason: InstallOpsDeferredError | undefined;

        const closeResources = (): void => {
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

        const makeUnavailable = (
          operation: string,
          cause: unknown,
        ): InstallOpsDeferredError => {
          unavailableReason ??= deferredError(
            fileGuard.path,
            operation,
            opsError(operation, cause),
          );
          try {
            closeResources();
          } catch {
            // Preserve the filesystem or fingerprint failure that caused the
            // service to fail closed.
          }
          return deferredError(fileGuard.path, operation, unavailableReason);
        };

        const requireAvailable = (operation: string): void => {
          if (unavailableReason !== undefined || closed) {
            throw deferredError(
              fileGuard.path,
              operation,
              unavailableReason ?? new Error("install-ops database is closed"),
            );
          }
        };

        const verifyLiveDatabase = (operation: string): void => {
          try {
            fileGuard.verifyQuiescent();
            assertCurrentSchema(database!);
            fileGuard.verifyQuiescent();
          } catch (cause) {
            throw makeUnavailable(operation, cause);
          }
        };

        const guardedOperation = <A>(
          operation: string,
          action: () => A,
        ): A => {
          requireAvailable(operation);
          verifyLiveDatabase(operation);

          let value: A | undefined;
          let actionFailed = false;
          let actionFailure: unknown;
          try {
            value = action();
          } catch (cause) {
            actionFailed = true;
            actionFailure = cause;
          }

          verifyLiveDatabase(operation);
          if (actionFailed) {
            throw serviceError(operation, actionFailure);
          }
          return value as A;
        };

        const service: InstallOpsServiceShape = {
          path: fileGuard.path,
          get availability(): InstallOpsAvailability {
            return unavailableReason === undefined
              ? { status: "available" }
              : { status: "unavailable", reason: unavailableReason };
          },
          getBackfill: (id) =>
            Effect.try({
              try: () =>
                guardedOperation("getBackfill", () => {
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
                }),
              catch: (cause) => serviceError("getBackfill", cause),
            }),
          ensurePending: (id) =>
            Effect.try({
              try: () =>
                guardedOperation("ensurePending", () => {
                  ensurePending.run(id);
                }),
              catch: (cause) => serviceError("ensurePending", cause),
            }),
          reopenPending: (id) =>
            Effect.try({
              try: () =>
                guardedOperation("reopenPending", () => {
                  reopenPending.run(id);
                }),
              catch: (cause) => serviceError("reopenPending", cause),
            }),
          markComplete: (id, objectsIngested) =>
            Effect.try({
              try: () =>
                guardedOperation("markComplete", () => {
                  markComplete.run(
                    id,
                    objectsIngested,
                    new Date().toISOString(),
                  );
                }),
              catch: (cause) => serviceError("markComplete", cause),
            }),
          updateLatch: (installationId) =>
            Effect.try({
              try: () => guardedOperation("updateLatch", () => {
                const row = readUpdateLatch.get(installationId) as { readonly installation_id: string; readonly target_build: string; readonly outcome: string; readonly at: string } | undefined;
                if (row === undefined) return undefined;
                return { installationId: row.installation_id, targetBuild: row.target_build, outcome: row.outcome, at: row.at } as MachineUpdateLatch;
              }),
              catch: (cause) => serviceError("updateLatch", cause),
            }),
          recordUpdateLatch: (latch) =>
            Effect.try({
              try: () => guardedOperation("recordUpdateLatch", () => {
                writeUpdateLatch.run(latch.installationId, latch.targetBuild, latch.outcome, latch.at);
              }),
              catch: (cause) => serviceError("recordUpdateLatch", cause),
            }),
          clearUpdateLatch: (installationId) =>
            Effect.try({
              try: () => guardedOperation("clearUpdateLatch", () => {
                deleteUpdateLatch.run(installationId);
              }),
              catch: (cause) => serviceError("clearUpdateLatch", cause),
            }),
          setupRefusal: (machineName) =>
            Effect.try({
              try: () => guardedOperation("setupRefusal", () => {
                const row = readSetupRefusal.get(machineName) as { readonly machine_name: string; readonly installation_id: string; readonly route: string; readonly recorded_at: string } | undefined;
                if (row === undefined) return undefined;
                return { machineName: row.machine_name, installationId: row.installation_id, route: row.route, at: row.recorded_at } satisfies MachineSetupRefusal;
              }),
              catch: (cause) => serviceError("setupRefusal", cause),
            }),
          recordSetupRefusal: (refusal) =>
            Effect.try({
              try: () => guardedOperation("recordSetupRefusal", () => {
                writeSetupRefusal.run(refusal.machineName, refusal.installationId, refusal.route, refusal.at);
              }),
              catch: (cause) => serviceError("recordSetupRefusal", cause),
            }),
          clearSetupRefusal: (machineName) =>
            Effect.try({
              try: () => guardedOperation("clearSetupRefusal", () => {
                deleteSetupRefusal.run(machineName);
              }),
              catch: (cause) => serviceError("clearSetupRefusal", cause),
            }),
        };

        return { service, close: closeResources };
      } catch (cause) {
        if (inspectionDatabase !== undefined) {
          try {
            inspectionDatabase.close();
          } catch {
            // Preserve the setup error; read-only close was still attempted.
          }
        }
        if (database !== undefined) {
          try {
            database.close();
          } catch {
            // Preserve the setup error; writable close was still attempted.
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
    deferredError(path, operation, acquisitionError);
  const reason = deferred("acquire");

  return {
    path,
    availability: { status: "unavailable", reason },
    getBackfill: () => Effect.fail(deferred("getBackfill")),
    ensurePending: () => Effect.fail(deferred("ensurePending")),
    reopenPending: () => Effect.fail(deferred("reopenPending")),
    markComplete: () => Effect.fail(deferred("markComplete")),
    updateLatch: () => Effect.fail(deferred("updateLatch")),
    recordUpdateLatch: () => Effect.fail(deferred("recordUpdateLatch")),
    clearUpdateLatch: () => Effect.fail(deferred("clearUpdateLatch")),
    setupRefusal: () => Effect.fail(deferred("setupRefusal")),
    recordSetupRefusal: () => Effect.fail(deferred("recordSetupRefusal")),
    clearSetupRefusal: () => Effect.fail(deferred("clearSetupRefusal")),
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
