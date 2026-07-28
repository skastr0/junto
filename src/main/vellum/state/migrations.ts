import {
  constants,
  DatabaseSync,
  type SQLOutputValue,
} from "node:sqlite";
import { STATE_SCHEMA_SQL } from "./schema";
import {
  actualStateSchemaSha256,
  expectedStateSchemaIdentity,
  isFreshStateSchema,
  readRecordedStateSchemaIdentity,
  stampStateSchemaIdentity,
  verifyAndStampStateSchema,
  verifyRecordedStateSchemaIdentity,
  type VerifiedStateSchemaIdentity,
} from "./schema-identity";

export type StateSchemaMigrationDatabase = Pick<
  DatabaseSync,
  "exec" | "prepare"
>;

export type StateSchemaMigration = {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly name: string;
  readonly fromIdentity: VerifiedStateSchemaIdentity;
  /**
   * Runs synchronously inside StateEngine's startup BEGIN IMMEDIATE. Throwing
   * rolls back DDL, transformed data, schema identity, and user_version.
   */
  readonly migrate: (database: StateSchemaMigrationDatabase) => void;
};

export type StateSchemaMigrationPlan = {
  readonly baselineVersion: number;
  readonly baselineIdentity: VerifiedStateSchemaIdentity;
  readonly currentVersion: number;
  readonly currentSchemaSql: string;
  readonly migrations: ReadonlyArray<StateSchemaMigration>;
};

export type StateSchemaMigrationResult =
  VerifiedStateSchemaIdentity & {
    readonly schemaVersion: number;
    readonly previousVersion: number;
    readonly initialized: boolean;
  };

/**
 * Version 1 is the one-way cut after the SQLite/work-protocol consolidation.
 * These literals are immutable release evidence. Future schema edits advance
 * CURRENT_STATE_SCHEMA_VERSION and append a 1 -> 2 migration; they never
 * rewrite this witness.
 */
export const STATE_SCHEMA_V1_IDENTITY = {
  actualSchemaSha256:
    "376d0448e43bda8373930f74140ff2f11c315bcf9c9382daf25bd4cb7b910195",
  sourceSchemaSha256:
    "eced07754950232548eae3015fb9deeb0f2d5829d6f588ef6a45d0763356153d",
} as const satisfies VerifiedStateSchemaIdentity;

export const CURRENT_STATE_SCHEMA_VERSION = 1;

export const STATE_SCHEMA_MIGRATIONS =
  [] as const satisfies ReadonlyArray<StateSchemaMigration>;

export const STATE_SCHEMA_MIGRATION_PLAN: StateSchemaMigrationPlan = {
  baselineVersion: 1,
  baselineIdentity: STATE_SCHEMA_V1_IDENTITY,
  currentVersion: CURRENT_STATE_SCHEMA_VERSION,
  currentSchemaSql: STATE_SCHEMA_SQL,
  migrations: STATE_SCHEMA_MIGRATIONS,
};

const readUserVersion = (database: DatabaseSync): number => {
  const row = database.prepare("PRAGMA user_version").get() as
    | { readonly user_version: SQLOutputValue }
    | undefined;
  const version = Number(row?.user_version);
  if (
    !Number.isSafeInteger(version) ||
    version < 0 ||
    version > 2_147_483_647
  ) {
    throw new Error(
      `state schema user_version is invalid: ${String(row?.user_version)}`,
    );
  }
  return version;
};

const setUserVersion = (
  database: DatabaseSync,
  version: number,
): void => {
  if (
    !Number.isSafeInteger(version) ||
    version < 0 ||
    version > 2_147_483_647
  ) {
    throw new Error(`refusing invalid state schema version ${version}`);
  }
  database.exec(`PRAGMA user_version = ${version}`);
};

const sameIdentity = (
  left: VerifiedStateSchemaIdentity,
  right: VerifiedStateSchemaIdentity,
): boolean =>
  left.actualSchemaSha256 === right.actualSchemaSha256 &&
  left.sourceSchemaSha256 === right.sourceSchemaSha256;

const requireIdentity = (
  label: string,
  actual: VerifiedStateSchemaIdentity,
  expected: VerifiedStateSchemaIdentity,
): void => {
  if (!sameIdentity(actual, expected)) {
    throw new Error(
      `${label} identity is not a recognized Vellum schema`,
    );
  }
};

const assertForeignKeys = (database: DatabaseSync): void => {
  const violations = database
    .prepare("PRAGMA foreign_key_check")
    .all();
  if (violations.length > 0) {
    throw new Error(
      `state schema migration leaves ${violations.length} foreign-key violation(s)`,
    );
  }
};

const runMigrationStep = (
  database: DatabaseSync,
  migration: StateSchemaMigration,
): void => {
  const connection: StateSchemaMigrationDatabase = {
    exec: (sql) => database.exec(sql),
    prepare: (sql, options) => database.prepare(sql, options),
  };
  database.setAuthorizer((actionCode) =>
    actionCode === constants.SQLITE_TRANSACTION ||
      actionCode === constants.SQLITE_SAVEPOINT
      ? constants.SQLITE_DENY
      : constants.SQLITE_OK
  );
  try {
    migration.migrate(connection);
  } finally {
    database.setAuthorizer(null);
  }
  if (!database.isTransaction) {
    throw new Error(
      `state schema migration ${migration.fromVersion} -> ${migration.toVersion} escaped its startup transaction`,
    );
  }
};

const verifyRecordedCurrentSchema = (
  database: DatabaseSync,
  currentSchemaSql: string,
): VerifiedStateSchemaIdentity => {
  let recorded:
    | ReturnType<typeof readRecordedStateSchemaIdentity>
    | undefined;
  let recordedFailure: unknown;
  try {
    recorded = readRecordedStateSchemaIdentity(database);
  } catch (error) {
    recordedFailure = error;
  }
  // This may stamp, but the caller's transaction rolls that write back if the
  // prior witness was absent or false. Running it first preserves the exact
  // missing/changed/unexpected schema diagnostic for current-version drift.
  const expected = verifyAndStampStateSchema(
    database,
    currentSchemaSql,
  );
  if (recorded === undefined) throw recordedFailure;
  requireIdentity("recorded current state schema", recorded, expected);
  return recorded;
};

export const validateStateSchemaMigrationPlan = (
  plan: StateSchemaMigrationPlan,
): ReadonlyMap<number, StateSchemaMigration> => {
  if (
    !Number.isSafeInteger(plan.baselineVersion) ||
    plan.baselineVersion < 1 ||
    !Number.isSafeInteger(plan.currentVersion) ||
    plan.currentVersion < plan.baselineVersion
  ) {
    throw new Error("state schema migration version bounds are invalid");
  }
  const byVersion = new Map<number, StateSchemaMigration>();
  for (const migration of plan.migrations) {
    if (
      !Number.isSafeInteger(migration.fromVersion) ||
      migration.fromVersion < plan.baselineVersion ||
      migration.toVersion !== migration.fromVersion + 1 ||
      migration.toVersion > plan.currentVersion ||
      migration.name.length === 0
    ) {
      throw new Error(
        `invalid state schema migration ${migration.fromVersion} -> ${migration.toVersion}`,
      );
    }
    if (byVersion.has(migration.fromVersion)) {
      throw new Error(
        `duplicate state schema migration from version ${migration.fromVersion}`,
      );
    }
    byVersion.set(migration.fromVersion, migration);
  }
  for (
    let version = plan.baselineVersion;
    version < plan.currentVersion;
    version += 1
  ) {
    if (!byVersion.has(version)) {
      throw new Error(
        `missing state schema migration ${version} -> ${version + 1}`,
      );
    }
  }
  return byVersion;
};

/**
 * Initialize, adopt, or migrate the sole Vellum database in one transaction.
 *
 * `user_version = 0` is not a wildcard for arbitrary old databases. A
 * non-empty version-zero database must match the frozen v1 witness exactly.
 */
export const migrateStateSchema = (
  database: DatabaseSync,
  plan: StateSchemaMigrationPlan = STATE_SCHEMA_MIGRATION_PLAN,
): StateSchemaMigrationResult => {
  const migrations = validateStateSchemaMigrationPlan(plan);
  database.exec("BEGIN IMMEDIATE");
  try {
    const previousVersion = readUserVersion(database);
    if (previousVersion > plan.currentVersion) {
      throw new Error(
        `state schema version ${previousVersion} is newer than supported version ${plan.currentVersion}`,
      );
    }
    const fresh = isFreshStateSchema(database);
    let version = previousVersion;

    if (fresh) {
      if (version !== 0) {
        throw new Error(
          `fresh state database carries unexpected user_version ${version}`,
        );
      }
      database.exec(plan.currentSchemaSql);
      version = plan.currentVersion;
    } else {
      let recorded =
        version === plan.currentVersion ||
          (
            version === 0 &&
            plan.baselineVersion === plan.currentVersion
          )
          ? verifyRecordedCurrentSchema(
              database,
              plan.currentSchemaSql,
            )
          : verifyRecordedStateSchemaIdentity(database);
      if (version === 0) {
        requireIdentity(
          "unversioned state schema baseline",
          recorded,
          plan.baselineIdentity,
        );
        version = plan.baselineVersion;
        setUserVersion(database, version);
      } else if (version < plan.baselineVersion) {
        throw new Error(
          `state schema version ${version} predates the supported baseline ${plan.baselineVersion}`,
        );
      }

      while (version < plan.currentVersion) {
        const migration = migrations.get(version);
        if (migration === undefined) {
          throw new Error(
            `missing state schema migration ${version} -> ${version + 1}`,
          );
        }
        requireIdentity(
          `state schema version ${version}`,
          recorded,
          migration.fromIdentity,
        );
        runMigrationStep(database, migration);
        version = migration.toVersion;
        setUserVersion(database, version);
        if (version < plan.currentVersion) {
          const next = migrations.get(version);
          if (next === undefined) {
            throw new Error(
              `missing state schema migration ${version} -> ${version + 1}`,
            );
          }
          const actualSchemaSha256 =
            actualStateSchemaSha256(database);
          requireIdentity(
            `migrated state schema version ${version}`,
            {
              actualSchemaSha256,
              sourceSchemaSha256:
                next.fromIdentity.sourceSchemaSha256,
            },
            next.fromIdentity,
          );
          stampStateSchemaIdentity(database, next.fromIdentity);
          recorded = next.fromIdentity;
        }
      }

      if (previousVersion === plan.currentVersion) {
        requireIdentity(
          `state schema version ${plan.currentVersion}`,
          recorded,
          expectedStateSchemaIdentity(plan.currentSchemaSql),
        );
      }
    }

    const identity = verifyAndStampStateSchema(
      database,
      plan.currentSchemaSql,
    );
    assertForeignKeys(database);
    setUserVersion(database, plan.currentVersion);
    database.exec("COMMIT");
    return {
      ...identity,
      schemaVersion: plan.currentVersion,
      previousVersion,
      initialized: fresh,
    };
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the migration failure. A rollback failure keeps startup
      // failed closed and the connection is closed by StateEngine.
    }
    throw error;
  }
};
