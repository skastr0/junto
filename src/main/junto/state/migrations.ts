import {
  constants,
  DatabaseSync,
  type SQLOutputValue,
} from "node:sqlite";
import { STATE_SCHEMA_SQL } from "./schema";
import { AGENT_SIGNALS_STATE_SCHEMA_SQL } from "../signals/state-schema";
import { SQUADS_STATE_SCHEMA_SQL } from "../squads/state-schema";
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

export const STATE_SCHEMA_MIGRATION_SAFETY = "expand-only" as const;
/**
 * A consolidation step retires durable tables whose content has been migrated
 * into a canonical replacement inside the same step. It is the only step class
 * allowed to DROP tables it names in `removesTables`.
 */
export const STATE_SCHEMA_CONSOLIDATE_SAFETY = "consolidate" as const;

export type StateSchemaMigrationSafety =
  | typeof STATE_SCHEMA_MIGRATION_SAFETY
  | typeof STATE_SCHEMA_CONSOLIDATE_SAFETY;

export type StateSchemaMigration = {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly name: string;
  readonly safety: StateSchemaMigrationSafety;
  readonly fromIdentity: VerifiedStateSchemaIdentity;
  /** Exact non-table schema objects this step is authorized to replace. */
  readonly replacesObjects?: ReadonlyArray<`trigger:${string}`>;
  /**
   * Durable tables a consolidation step's corrective converter may UPDATE or
   * INSERT while they still exist from before the step. Only valid on a
   * consolidation step: every other write to a pre-existing table stays
   * denied, so the corrective capability is scoped to exactly the tables the
   * repair is allowed to touch, not to the whole step class.
   */
  readonly correctiveWriteTables?: ReadonlyArray<string>;
  /**
   * Durable tables this step may DROP and recreate with identical columns
   * (CHECK-domain expand). Rows must be copy-forwarded; final column set must
   * match expand-only preservation. Prefer CREATE…AS SELECT backup → DROP →
   * CREATE exact DDL → INSERT → DROP backup.
   *
   * Presence of any `replacesTables` on the pending migration chain causes
   * `migrateStateSchema` to set `PRAGMA foreign_keys=OFF` **before**
   * `BEGIN IMMEDIATE` (SQLite treats in-transaction foreign_keys toggles as
   * no-ops). Step SQL must not rely on in-txn FK pragmas. Enforcement is
   * restored after COMMIT/ROLLBACK; `PRAGMA foreign_key_check` still gates.
   */
  readonly replacesTables?: ReadonlyArray<string>;
  /**
   * Durable tables this consolidation step retires: their content is migrated
   * into the canonical replacement inside the same step, then the table is
   * DROPped and never recreated. Only valid with safety "consolidate". The
   * same pre-transaction foreign_keys=OFF treatment as `replacesTables`
   * applies.
   */
  readonly removesTables?: ReadonlyArray<string>;
  /**
   * Runs synchronously inside StateEngine's startup BEGIN IMMEDIATE. Throwing
   * rolls back DDL, copied-forward data, schema identity, and user_version.
   * The supplied connection rejects destructive schema/data operations.
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
 * Junto schema version 1 is the re-baselined durable shape: the rename carries
 * the schema forward at its current composition with no chain beneath it.
 * `bun run schema:identity` rewrites the hash after any schema change; the
 * next schema edit advances CURRENT_STATE_SCHEMA_VERSION and appends `1 -> 2`.
 */
export const STATE_SCHEMA_V1_IDENTITY = {
  actualSchemaSha256:
    "5486e207e1571e17f4e726891ea30ed165eec95324e5c5ba27d946e44330e382",
} as const satisfies VerifiedStateSchemaIdentity;

/**
 * Version 2 retires the mail delivery ledger: mail is typed into its seat at
 * once, with no attempts, refusals, or fallback to record.
 */
export const STATE_SCHEMA_V2_IDENTITY = {
  actualSchemaSha256:
    "a28acec6845e2cd35e9b22e5e1d29eac754674fbe9401f77339d94f42bfbddd1",
} as const satisfies VerifiedStateSchemaIdentity;

/**
 * Version 3 adds agent signals: a seat's durable escalate, blocked, or
 * feedback claim waiting for the operator's response.
 */
export const STATE_SCHEMA_V3_IDENTITY = {
  actualSchemaSha256:
    "59a9fd4f9c230fc9e03b340320bc34e8c6c5fbfd7c5646353f35bab11bf9146d",
} as const satisfies VerifiedStateSchemaIdentity;

/**
 * Version 4 adds squads: the operator's reusable seat templates, placed from
 * the add picker.
 */
export const STATE_SCHEMA_V4_IDENTITY = {
  actualSchemaSha256:
    "97562129f02960699181a455e453f0bc38164717bf8afc06006cd820c9d75bbc",
} as const satisfies VerifiedStateSchemaIdentity;

export const CURRENT_STATE_SCHEMA_VERSION = 4;

/**
 * Stable alias for the head identity so tests and tooling never rename an
 * import on a schema bump. `bun run schema:identity` rewrites the constant
 * above after any schema change.
 */
export const CURRENT_STATE_SCHEMA_IDENTITY: VerifiedStateSchemaIdentity =
  STATE_SCHEMA_V4_IDENTITY;

/**
 * Junto version 1 is composed fresh and adopted, never reached by chain; each
 * later schema change appends its step here.
 */
export const STATE_SCHEMA_MIGRATIONS: ReadonlyArray<StateSchemaMigration> = [
  {
    fromVersion: 1,
    toVersion: 2,
    name: "retire the mail delivery ledger",
    safety: STATE_SCHEMA_CONSOLIDATE_SAFETY,
    fromIdentity: STATE_SCHEMA_V1_IDENTITY,
    // Transport bookkeeping with no successor: whether a message reached its
    // seat lives in work_delivery_receipts, which this step leaves untouched.
    removesTables: ["work_mail_attempts", "work_mail_notice_fallback"],
    migrate: (database) => {
      database.exec(`
        DROP TABLE work_mail_attempts;
        DROP TABLE work_mail_notice_fallback;
      `);
    },
  },
  {
    fromVersion: 2,
    toVersion: 3,
    name: "add agent signals",
    safety: STATE_SCHEMA_MIGRATION_SAFETY,
    fromIdentity: STATE_SCHEMA_V2_IDENTITY,
    migrate: (database) => {
      database.exec(AGENT_SIGNALS_STATE_SCHEMA_SQL);
    },
  },
  {
    fromVersion: 3,
    toVersion: 4,
    name: "add squads",
    safety: STATE_SCHEMA_MIGRATION_SAFETY,
    fromIdentity: STATE_SCHEMA_V3_IDENTITY,
    migrate: (database) => {
      database.exec(SQUADS_STATE_SCHEMA_SQL);
    },
  },
];

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
): boolean => left.actualSchemaSha256 === right.actualSchemaSha256;

const requireIdentity = (
  label: string,
  actual: VerifiedStateSchemaIdentity,
  expected: VerifiedStateSchemaIdentity,
): void => {
  if (!sameIdentity(actual, expected)) {
    throw new Error(
      `${label} identity is not a recognized Junto schema`,
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

type ExpandColumn = {
  readonly name: string;
  readonly type: string;
  readonly notNull: number;
  readonly defaultValue: string | null;
  readonly primaryKey: number;
  readonly hidden: number;
};

type ExpandSchemaSnapshot = {
  readonly tables: ReadonlyMap<string, ReadonlyMap<string, ExpandColumn>>;
  readonly retainedObjects: ReadonlyMap<string, string | null>;
};

const expandSchemaSnapshot = (
  database: DatabaseSync,
): ExpandSchemaSnapshot => {
  const objects = database
    .prepare(
      `
        SELECT type, name, sql
        FROM sqlite_schema
        WHERE type IN ('table', 'index', 'view', 'trigger')
          AND name NOT GLOB 'sqlite_*'
        ORDER BY type COLLATE BINARY, name COLLATE BINARY
      `,
    )
    .all() as unknown as ReadonlyArray<{
      readonly type: SQLOutputValue;
      readonly name: SQLOutputValue;
      readonly sql: SQLOutputValue;
    }>;
  const tables = new Map<string, ReadonlyMap<string, ExpandColumn>>();
  const retainedObjects = new Map<string, string | null>();
  for (const object of objects) {
    const type = String(object.type);
    const name = String(object.name);
    if (type !== "table") {
      retainedObjects.set(
        `${type}:${name}`,
        object.sql === null ? null : String(object.sql),
      );
      continue;
    }
    const columns = database
      .prepare(
        `
          SELECT
            name,
            type,
            "notnull" AS not_null,
            dflt_value AS default_value,
            pk AS primary_key,
            hidden
          FROM pragma_table_xinfo(?)
          ORDER BY cid
        `,
      )
      .all(name) as unknown as ReadonlyArray<{
        readonly name: SQLOutputValue;
        readonly type: SQLOutputValue;
        readonly not_null: SQLOutputValue;
        readonly default_value: SQLOutputValue;
        readonly primary_key: SQLOutputValue;
        readonly hidden: SQLOutputValue;
      }>;
    tables.set(
      name,
      new Map(
        columns.map((column) => [
          String(column.name),
          {
            name: String(column.name),
            type: String(column.type),
            notNull: Number(column.not_null),
            defaultValue:
              column.default_value === null
                ? null
                : String(column.default_value),
            primaryKey: Number(column.primary_key),
            hidden: Number(column.hidden),
          },
        ]),
      ),
    );
  }
  return { tables, retainedObjects };
};

const assertExpandSchemaPreserved = (
  before: ExpandSchemaSnapshot,
  database: DatabaseSync,
  replacesObjects: ReadonlySet<string>,
  /**
   * Indexes/triggers owned by `replacesTables` tables. DROP TABLE cascades
   * them and the step rebuilds them; their SQL may change with the rebuild.
   */
  sideObjects: {
    readonly indexes: ReadonlySet<string>;
    readonly triggers: ReadonlySet<string>;
  } = { indexes: new Set(), triggers: new Set() },
  removedTables: ReadonlySet<string> = new Set(),
): void => {
  const after = expandSchemaSnapshot(database);
  for (const [tableName, beforeColumns] of before.tables) {
    if (removedTables.has(tableName)) {
      if (after.tables.has(tableName)) {
        throw new Error(
          `state schema consolidation step retained table ${tableName} it declared removed`,
        );
      }
      continue;
    }
    const afterColumns = after.tables.get(tableName);
    if (afterColumns === undefined) {
      throw new Error(
        `state schema startup migration removed table ${tableName}`,
      );
    }
    for (const [columnName, beforeColumn] of beforeColumns) {
      const afterColumn = afterColumns.get(columnName);
      if (
        afterColumn === undefined ||
        JSON.stringify(afterColumn) !== JSON.stringify(beforeColumn)
      ) {
        throw new Error(
          `state schema startup migration changed durable column ${tableName}.${columnName}`,
        );
      }
    }
  }
  for (const [key, sql] of before.retainedObjects) {
    if (replacesObjects.has(key)) continue;
    const colon = key.indexOf(":");
    if (colon > 0) {
      const kind = key.slice(0, colon);
      const name = key.slice(colon + 1);
      if (kind === "trigger" && sideObjects.triggers.has(name)) continue;
      if (kind === "index" && sideObjects.indexes.has(name)) continue;
    }
    if (after.retainedObjects.get(key) !== sql) {
      throw new Error(
        `state schema startup migration changed durable ${key}`,
      );
    }
  }
};

const destructiveMigrationActions = new Set<number>([
  constants.SQLITE_DELETE,
  constants.SQLITE_DROP_INDEX,
  constants.SQLITE_DROP_TABLE,
  constants.SQLITE_DROP_TEMP_INDEX,
  constants.SQLITE_DROP_TEMP_TABLE,
  constants.SQLITE_DROP_TEMP_TRIGGER,
  constants.SQLITE_DROP_TEMP_VIEW,
  constants.SQLITE_DROP_TRIGGER,
  constants.SQLITE_DROP_VIEW,
  constants.SQLITE_DROP_VTABLE,
  constants.SQLITE_ATTACH,
  constants.SQLITE_DETACH,
  constants.SQLITE_REINDEX,
  constants.SQLITE_ANALYZE,
]);

const migrationOwnedPragmas = new Set([
  "application_id",
  "journal_mode",
  "legacy_alter_table",
  "schema_version",
  "user_version",
  "writable_schema",
]);

const assertExpandOnlyMigrationSql = (sql: string): void => {
  const withoutComments = sql
    .replace(/--[^\r\n]*/gu, " ")
    .replace(/\/\*[\s\S]*?\*\//gu, " ");
  if (
    /\balter\s+table\b[\s\S]*?\b(?:rename(?:\s+(?:to|column))?|drop\s+column)\b/iu
      .test(withoutComments)
  ) {
    throw new Error(
      "state schema startup migrations may not rename or drop tables or columns",
    );
  }
  if (/\b(?:insert\s+or\s+replace|replace\s+into)\b/iu.test(withoutComments)) {
    throw new Error(
      "state schema startup migrations may not replace existing rows",
    );
  }
};

/**
 * Indexes and triggers owned by tables authorized for same-column rebuild.
 * Includes sqlite_autoindex_* names (filtered from retainedObjects but still
 * authorized on DROP TABLE cascades).
 */
const sideObjectsForReplacedTables = (
  database: DatabaseSync,
  replacesTables: ReadonlySet<string>,
): {
  readonly indexes: ReadonlySet<string>;
  readonly triggers: ReadonlySet<string>;
} => {
  if (replacesTables.size === 0) {
    return { indexes: new Set(), triggers: new Set() };
  }
  const tables = [...replacesTables];
  const placeholders = tables.map(() => "?").join(", ");
  const rows = database
    .prepare(
      `
        SELECT type, name
        FROM sqlite_schema
        WHERE type IN ('index', 'trigger')
          AND tbl_name IN (${placeholders})
      `,
    )
    .all(...tables) as unknown as ReadonlyArray<{
    readonly type: string;
    readonly name: string;
  }>;
  const indexes = new Set<string>();
  const triggers = new Set<string>();
  for (const row of rows) {
    if (row.type === "index") indexes.add(row.name);
    else if (row.type === "trigger") triggers.add(row.name);
  }
  return { indexes, triggers };
};

/**
 * True when advancing from the current user_version to plan.currentVersion
 * will execute at least one step that rebuilds durable tables.
 */
const chainNeedsTableReplace = (
  previousVersion: number,
  fresh: boolean,
  plan: StateSchemaMigrationPlan,
  migrations: ReadonlyMap<number, StateSchemaMigration>,
): boolean => {
  if (fresh) return false;
  if (previousVersion >= plan.currentVersion) return false;
  let version =
    previousVersion === 0 ? plan.baselineVersion : previousVersion;
  if (version < plan.baselineVersion) return false;
  while (version < plan.currentVersion) {
    const migration = migrations.get(version);
    if (migration === undefined) return false;
    if (
      (migration.replacesTables?.length ?? 0) > 0 ||
      (migration.removesTables?.length ?? 0) > 0
    ) {
      return true;
    }
    version = migration.toVersion;
  }
  return false;
};

const runMigrationStep = (
  database: DatabaseSync,
  migration: StateSchemaMigration,
): void => {
  const before = expandSchemaSnapshot(database);
  const replacesObjects = new Set<string>(migration.replacesObjects ?? []);
  const replacesTables = new Set<string>(migration.replacesTables ?? []);
  const removesTables = new Set<string>(migration.removesTables ?? []);
  const correctiveWriteTables = new Set<string>(
    migration.correctiveWriteTables ?? [],
  );
  const sideObjects = sideObjectsForReplacedTables(
    database,
    new Set([...replacesTables, ...removesTables]),
  );
  const connection: StateSchemaMigrationDatabase = {
    exec: (sql) => {
      assertExpandOnlyMigrationSql(sql);
      database.exec(sql);
    },
    prepare: (sql, options) => {
      assertExpandOnlyMigrationSql(sql);
      return database.prepare(sql, options);
    },
  };
  database.setAuthorizer((actionCode, arg1, arg2) => {
    const pragmaName = arg1 === null ? "" : arg1.toLowerCase();
    const isSchemaCatalog =
      arg1 === "sqlite_schema" || arg1 === "sqlite_master";
    const isReplacedTable = arg1 !== null && replacesTables.has(arg1);
    const isRemovedTable = arg1 !== null && removesTables.has(arg1);
    const isMigrateBackup =
      arg1 !== null && arg1.endsWith("__migrate_bak");
    const isSideIndex = arg1 !== null && sideObjects.indexes.has(arg1);
    const isSideTrigger = arg1 !== null && sideObjects.triggers.has(arg1);

    const deny =
      actionCode === constants.SQLITE_TRANSACTION ||
      actionCode === constants.SQLITE_SAVEPOINT ||
      (
        destructiveMigrationActions.has(actionCode) &&
        !(
          actionCode === constants.SQLITE_REINDEX &&
          arg1 !== null &&
          (
            !before.retainedObjects.has(`index:${arg1}`) ||
            isSideIndex
          )
        ) &&
        !(
          actionCode === constants.SQLITE_DROP_TRIGGER &&
          arg1 !== null &&
          (
            replacesObjects.has(`trigger:${arg1}`) ||
            isSideTrigger
          )
        ) &&
        !(
          actionCode === constants.SQLITE_DELETE &&
          (
            // Catalog rewrites during DROP/recreate of authorized objects.
            (
              isSchemaCatalog &&
              (
                replacesObjects.size > 0 ||
                replacesTables.size > 0 ||
                removesTables.size > 0
              )
            ) ||
            // DROP TABLE also emits DELETE against the table body.
            isReplacedTable ||
            isRemovedTable ||
            isMigrateBackup
          )
        ) &&
        !(
          actionCode === constants.SQLITE_DROP_TABLE &&
          (isReplacedTable || isRemovedTable || isMigrateBackup)
        ) &&
        !(
          actionCode === constants.SQLITE_DROP_INDEX &&
          isSideIndex
        )
      ) ||
      (
        actionCode === constants.SQLITE_INSERT &&
        arg1 !== null &&
        before.tables.has(arg1) &&
        !replacesTables.has(arg1) &&
        !correctiveWriteTables.has(arg1)
      ) ||
      (
        actionCode === constants.SQLITE_UPDATE &&
        arg1 !== null &&
        arg2 !== null &&
        before.tables.get(arg1)?.has(arg2) === true &&
        !correctiveWriteTables.has(arg1)
      ) ||
      (
        actionCode === constants.SQLITE_PRAGMA &&
        arg1 !== null &&
        migrationOwnedPragmas.has(pragmaName)
      );
    return deny ? constants.SQLITE_DENY : constants.SQLITE_OK;
  });
  try {
    migration.migrate(connection);
    assertExpandSchemaPreserved(
      before,
      database,
      replacesObjects,
      sideObjects,
      removesTables,
    );
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
      migration.name.length === 0 ||
      (migration.safety !== STATE_SCHEMA_MIGRATION_SAFETY &&
        migration.safety !== STATE_SCHEMA_CONSOLIDATE_SAFETY) ||
      ((migration.removesTables?.length ?? 0) > 0) !==
        (migration.safety === STATE_SCHEMA_CONSOLIDATE_SAFETY) ||
      ((migration.correctiveWriteTables?.length ?? 0) > 0 &&
        migration.safety !== STATE_SCHEMA_CONSOLIDATE_SAFETY)
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
 * Prove whether opening an installed database will durably advance its
 * schema cursor. This is deliberately read-only: StateEngine uses it to take
 * and verify a coherent backup before `migrateStateSchema` begins BEGIN
 * IMMEDIATE or writes an identity/version witness.
 */
export const stateSchemaAdvanceRequired = (
  database: DatabaseSync,
  plan: StateSchemaMigrationPlan = STATE_SCHEMA_MIGRATION_PLAN,
): boolean => {
  const migrations = validateStateSchemaMigrationPlan(plan);
  const version = readUserVersion(database);
  if (version > plan.currentVersion) {
    throw new Error(
      `state schema version ${version} is newer than supported version ${plan.currentVersion}`,
    );
  }
  if (isFreshStateSchema(database)) {
    if (version !== 0) {
      throw new Error(
        `fresh state database carries unexpected user_version ${version}`,
      );
    }
    return false;
  }
  if (version === plan.currentVersion && version !== 0) {
    return false;
  }

  const recorded = verifyRecordedStateSchemaIdentity(database);
  const effectiveVersion = version === 0 ? plan.baselineVersion : version;
  if (version === 0) {
    requireIdentity(
      "unversioned state schema baseline",
      recorded,
      plan.baselineIdentity,
    );
  } else if (version < plan.baselineVersion) {
    throw new Error(
      `state schema version ${version} predates the supported baseline ${plan.baselineVersion}`,
    );
  }
  const migration = migrations.get(effectiveVersion);
  if (effectiveVersion < plan.currentVersion && migration === undefined) {
    throw new Error(
      `missing state schema migration ${effectiveVersion} -> ${effectiveVersion + 1}`,
    );
  }
  if (migration !== undefined) {
    requireIdentity(
      `state schema version ${effectiveVersion}`,
      recorded,
      migration.fromIdentity,
    );
  }
  return true;
};

/**
 * Initialize, adopt, or migrate the sole Junto database in one transaction.
 *
 * `user_version = 0` is not a wildcard for arbitrary old databases. A
 * non-empty version-zero database must match the frozen v1 witness exactly.
 */
export const migrateStateSchema = (
  database: DatabaseSync,
  plan: StateSchemaMigrationPlan = STATE_SCHEMA_MIGRATION_PLAN,
): StateSchemaMigrationResult => {
  const migrations = validateStateSchemaMigrationPlan(plan);
  const previousVersion = readUserVersion(database);
  if (previousVersion > plan.currentVersion) {
    throw new Error(
      `state schema version ${previousVersion} is newer than supported version ${plan.currentVersion}`,
    );
  }
  const fresh = isFreshStateSchema(database);
  // SQLite ignores PRAGMA foreign_keys inside a transaction. Table-rebuild
  // steps need enforcement off *before* BEGIN IMMEDIATE so DROP of a parent
  // with ON DELETE RESTRICT children can copy-forward.
  const needsForeignKeysOff = chainNeedsTableReplace(
    previousVersion,
    fresh,
    plan,
    migrations,
  );

  let disabledForeignKeys = false;
  try {
    if (needsForeignKeysOff) {
      database.exec("PRAGMA foreign_keys = OFF");
      disabledForeignKeys = true;
    }
    database.exec("BEGIN IMMEDIATE");
    try {
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
        // An unversioned database is admitted only through its recorded
        // witness: it must prove the stamped identity matches the live
        // shape before the baseline comparison below accepts it as v1.
        let recorded: VerifiedStateSchemaIdentity =
          version === plan.currentVersion
            ? verifyRecordedCurrentSchema(database, plan.currentSchemaSql)
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
              { actualSchemaSha256 },
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
  } finally {
    if (disabledForeignKeys) {
      try {
        database.exec("PRAGMA foreign_keys = ON");
      } catch {
        // Connection may already be unusable after a hard failure.
      }
    }
  }
};
