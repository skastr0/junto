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
  verifyStateSchema,
  verifyAndStampStateSchema,
  verifyRecordedStateSchemaIdentity,
  type VerifiedStateSchemaIdentity,
} from "./schema-identity";
import {
  LICENSE_STATE_V1_SCHEMA_SQL,
  LICENSE_STATE_V2_SCHEMA_SQL,
} from "../license/state-schema";
import {
  WORK_BOARD_STATE_SCHEMA_SQL,
  WORK_PROPOSAL_PLANNING_STATE_SCHEMA_SQL,
  WORK_PROPOSAL_STATE_SCHEMA_SQL,
  WORK_STATE_SCHEMA_BOARD_VOCAB_SQL,
  WORK_TASK_DEPENDENCIES_STATE_SCHEMA_SQL,
  WORK_TASK_FINISH_STATE_SCHEMA_SQL,
} from "../work/state-schema";
import { ENTITIES_STATE_SCHEMA_SQL } from "../entities/state-schema";

export type StateSchemaMigrationDatabase = Pick<
  DatabaseSync,
  "exec" | "prepare"
>;

export const STATE_SCHEMA_MIGRATION_SAFETY = "expand-only" as const;

export type StateSchemaMigration = {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly name: string;
  readonly safety: typeof STATE_SCHEMA_MIGRATION_SAFETY;
  readonly fromIdentity: VerifiedStateSchemaIdentity;
  /** Exact non-table schema objects this step is authorized to replace. */
  readonly replacesObjects?: ReadonlyArray<`trigger:${string}`>;
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
 * Version 1 is the one-way cut after the SQLite/work-protocol consolidation.
 * These literals are immutable release evidence. Future schema edits advance
 * CURRENT_STATE_SCHEMA_VERSION and append the next contiguous migration; they
 * never rewrite this witness.
 */
export const STATE_SCHEMA_V1_IDENTITY = {
  actualSchemaSha256:
    "376d0448e43bda8373930f74140ff2f11c315bcf9c9382daf25bd4cb7b910195",
} as const satisfies VerifiedStateSchemaIdentity;

export const STATE_SCHEMA_V2_IDENTITY = {
  actualSchemaSha256:
    "c7050c73efcea27e7ccb6e7c687f213cae8d2c32e8903d1ab7c7f1e8aeb953c3",
} as const satisfies VerifiedStateSchemaIdentity;

export const STATE_SCHEMA_V3_IDENTITY = {
  actualSchemaSha256:
    "4a8d0fd0545e2108c79c611fc4f56acb1ce96a1972cae13cbf7e716b241bc941",
} as const satisfies VerifiedStateSchemaIdentity;

export const STATE_SCHEMA_V4_IDENTITY = {
  actualSchemaSha256:
    "8870c6e4b932ee4a2895bfc9926e2be97f0baa3c538bdfa1e9e8cca5eb354d7f",
} as const satisfies VerifiedStateSchemaIdentity;

/** Exact witness of schema version 5 (task proposals; no entity registry). */
export const STATE_SCHEMA_V5_IDENTITY = {
  actualSchemaSha256:
    "4c0fd324cb37c9c609acdeade50a10325b2bffddaae40c0ee8fa464d6cfc6b6f",
} as const satisfies VerifiedStateSchemaIdentity;

/** Exact witness of schema version 6 (canvas entity registry). */
export const STATE_SCHEMA_V6_IDENTITY = {
  actualSchemaSha256:
    "f097722579ffcaad121b0e5eb62076a8ab70cb9c5d66a78978d572612703be53",
} as const satisfies VerifiedStateSchemaIdentity;

/** Exact witness of schema version 7 (task dependencies). */
export const STATE_SCHEMA_V7_IDENTITY = {
  actualSchemaSha256:
    "9f2aace6eaefaa20c1141304d5d4d62544a0500ff3bc7f30acda94d4099006bc",
} as const satisfies VerifiedStateSchemaIdentity;

/** Exact witness of schema version 8 (task finish criteria; no board). */
export const STATE_SCHEMA_V8_IDENTITY = {
  actualSchemaSha256:
    "8239ad37bd9fb890d585f5fedef69086890a75b1c01b5fb257bb4573c2809e71",
} as const satisfies VerifiedStateSchemaIdentity;

/** Exact witness of schema version 9 (board tables; pre board event vocab). */
export const STATE_SCHEMA_V9_IDENTITY = {
  actualSchemaSha256:
    "00777be6fb3361c057a799d0f58c86d364518d24a1eb2d8a08b6f32c58d7bcef",
} as const satisfies VerifiedStateSchemaIdentity;

/** Exact witness of schema version 10 (board event vocabulary; pre proposal planning). */
export const STATE_SCHEMA_V10_IDENTITY = {
  actualSchemaSha256:
    "7844862b7ed357a60b4e78a336ae7229aab8dd812622862f0de56c916e12269e",
} as const satisfies VerifiedStateSchemaIdentity;

/** Exact witness of schema version 11 (proposal planning arms). */
export const STATE_SCHEMA_V11_IDENTITY = {
  actualSchemaSha256:
    "66e16dda9d6d938b107ec25b0edd58f1a964d40192fd1d9fe35793665d03e99f",
} as const satisfies VerifiedStateSchemaIdentity;

export const CURRENT_STATE_SCHEMA_VERSION = 11;

export const STATE_SCHEMA_MIGRATIONS =
  [
    {
      fromVersion: 1,
      toVersion: 2,
      name: "add-license-activation",
      safety: STATE_SCHEMA_MIGRATION_SAFETY,
      fromIdentity: STATE_SCHEMA_V1_IDENTITY,
      migrate: (database) => {
        database.exec(LICENSE_STATE_V1_SCHEMA_SQL);
      },
    },
    {
      fromVersion: 2,
      toVersion: 3,
      name: "bind-license-entitlement-to-dodo-product",
      safety: STATE_SCHEMA_MIGRATION_SAFETY,
      fromIdentity: STATE_SCHEMA_V2_IDENTITY,
      migrate: (database) => {
        database.exec(LICENSE_STATE_V2_SCHEMA_SQL);
      },
    },
    {
      fromVersion: 3,
      toVersion: 4,
      name: "allow-atomic-task-release",
      safety: STATE_SCHEMA_MIGRATION_SAFETY,
      fromIdentity: STATE_SCHEMA_V3_IDENTITY,
      replacesObjects: ["trigger:work_tasks_actor_immutable"],
      migrate: (database) => {
        database.exec(`
          DROP TRIGGER work_tasks_actor_immutable;
          CREATE TRIGGER work_tasks_actor_immutable
          BEFORE UPDATE OF actor_seat_id ON work_tasks
          WHEN
            OLD.actor_seat_id IS NOT NULL
            AND OLD.actor_seat_id IS NOT NEW.actor_seat_id
            AND NOT (
              NEW.actor_seat_id IS NULL
              AND NEW.state = 'submitted'
            )
          BEGIN
            SELECT RAISE(
              ABORT,
              'work task actor seat is immutable except for operator release'
            );
          END;
        `);
      },
    },
    {
      fromVersion: 4,
      toVersion: 5,
      name: "add-task-proposals",
      safety: STATE_SCHEMA_MIGRATION_SAFETY,
      fromIdentity: STATE_SCHEMA_V4_IDENTITY,
      migrate: (database) => {
        database.exec(WORK_PROPOSAL_STATE_SCHEMA_SQL);
      },
    },
    {
      fromVersion: 5,
      toVersion: 6,
      name: "add-canvas-entities",
      safety: STATE_SCHEMA_MIGRATION_SAFETY,
      fromIdentity: STATE_SCHEMA_V5_IDENTITY,
      migrate: (database) => {
        database.exec(ENTITIES_STATE_SCHEMA_SQL);
        backfillCanvasEntitiesFromHead(database);
      },
    },
    {
      fromVersion: 6,
      toVersion: 7,
      name: "add-work-task-dependencies",
      safety: STATE_SCHEMA_MIGRATION_SAFETY,
      fromIdentity: STATE_SCHEMA_V6_IDENTITY,
      migrate: (database) => {
        database.exec(WORK_TASK_DEPENDENCIES_STATE_SCHEMA_SQL);
      },
    },
    {
      fromVersion: 7,
      toVersion: 8,
      name: "add-work-task-finish-criteria",
      safety: STATE_SCHEMA_MIGRATION_SAFETY,
      fromIdentity: STATE_SCHEMA_V7_IDENTITY,
      migrate: (database) => {
        database.exec(WORK_TASK_FINISH_STATE_SCHEMA_SQL);
      },
    },
    {
      fromVersion: 8,
      toVersion: 9,
      name: "add-work-board",
      safety: STATE_SCHEMA_MIGRATION_SAFETY,
      fromIdentity: STATE_SCHEMA_V8_IDENTITY,
      migrate: (database) => {
        database.exec(WORK_BOARD_STATE_SCHEMA_SQL);
      },
    },
    {
      fromVersion: 9,
      toVersion: 10,
      name: "board-event-vocabulary",
      safety: STATE_SCHEMA_MIGRATION_SAFETY,
      fromIdentity: STATE_SCHEMA_V9_IDENTITY,
      replacesTables: ["work_events", "work_pending_commands"],
      migrate: (database) => {
        // Expand CHECK vocab for board topic/post kinds + board ops.
        // node:sqlite forbids writable_schema rewrites; expand-only allows an
        // authorized same-column rebuild with full row copy-forward.
        // FK enforcement is disabled by migrateStateSchema *before* BEGIN
        // (in-txn PRAGMA foreign_keys is a no-op — see replacesTables docs).
        database.exec(`
          CREATE TABLE work_events__migrate_bak AS SELECT * FROM work_events;
          CREATE TABLE work_pending_commands__migrate_bak AS
            SELECT * FROM work_pending_commands;

          DROP TABLE work_pending_commands;
          DROP TABLE work_events;
        `);

        // Recreate exact current work schema objects (IF NOT EXISTS): only the
        // two dropped tables + their indexes/triggers are missing.
        database.exec(WORK_STATE_SCHEMA_BOARD_VOCAB_SQL);

        database.exec(`
          INSERT INTO work_events SELECT * FROM work_events__migrate_bak;
          INSERT INTO work_pending_commands
            SELECT * FROM work_pending_commands__migrate_bak;
          DROP TABLE work_events__migrate_bak;
          DROP TABLE work_pending_commands__migrate_bak;
        `);
      },
    },
    {
      fromVersion: 10,
      toVersion: 11,
      name: "add-work-proposal-planning",
      safety: STATE_SCHEMA_MIGRATION_SAFETY,
      fromIdentity: STATE_SCHEMA_V10_IDENTITY,
      migrate: (database) => {
        database.exec(WORK_PROPOSAL_PLANNING_STATE_SCHEMA_SQL);
      },
    },

  ] as const satisfies ReadonlyArray<StateSchemaMigration>;

/**
 * Seed the entity registry from the current authorial head so active nodes
 * already on disk become active entities without rewriting canvas bodies.
 *
 * Conflict policy (must not brick upgrade):
 * - first wins for (canvas, entity_id)
 * - first wins for active binding_id on a canvas; later copies store binding_id NULL
 * - undecodable documents fail the step (fail closed) when body is non-empty
 */
const backfillCanvasEntitiesFromHead = (
  database: StateSchemaMigrationDatabase,
): void => {
  const head = database
    .prepare(
      "SELECT generation FROM canvas_head WHERE singleton = 1",
    )
    .get() as { readonly generation: string } | undefined;
  if (head === undefined) return;

  const documents = database
    .prepare(
      `
        SELECT name, body
        FROM canvas_generation_documents
        WHERE generation = ?
      `,
    )
    .all(head.generation) as unknown as ReadonlyArray<{
    readonly name: string;
    readonly body: string;
  }>;

  const now = new Date().toISOString();
  const insert = database.prepare(
    `
      INSERT INTO canvas_entities(
        canvas_name,
        entity_id,
        kind,
        binding_id,
        lifecycle,
        created_at,
        updated_at,
        archived_at,
        soft_deleted_at
      ) VALUES (?, ?, ?, ?, 'active', ?, ?, NULL, NULL)
      ON CONFLICT(canvas_name, entity_id) DO NOTHING
    `,
  );

  for (const document of documents) {
    if (document.body.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(document.body);
    } catch {
      throw new Error(
        `canvas entity backfill: document "${document.name}" is not valid JSON`,
      );
    }
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      !("nodes" in parsed) ||
      !Array.isArray((parsed as { nodes: unknown }).nodes)
    ) {
      throw new Error(
        `canvas entity backfill: document "${document.name}" is not a canvas body with nodes[]`,
      );
    }

    const claimedBindings = new Set<string>();
    for (const node of (parsed as { nodes: ReadonlyArray<unknown> }).nodes) {
      if (
        node === null ||
        typeof node !== "object" ||
        !("id" in node) ||
        typeof (node as { id: unknown }).id !== "string"
      ) {
        throw new Error(
          `canvas entity backfill: document "${document.name}" has a node without a string id`,
        );
      }
      const entityId = (node as { id: string }).id;
      if (entityId.length === 0 || entityId.length > 256) {
        throw new Error(
          `canvas entity backfill: document "${document.name}" has an out-of-range entity id`,
        );
      }

      let kind: string | null = null;
      let bindingId: string | null = null;
      const ether = (node as { ether?: unknown }).ether;
      if (ether !== null && typeof ether === "object") {
        const entity = (ether as { entity?: unknown }).entity;
        if (
          entity !== null &&
          typeof entity === "object" &&
          typeof (entity as { kind?: unknown }).kind === "string"
        ) {
          const k = (entity as { kind: string }).kind;
          if (k.length > 0 && k.length <= 128) kind = k;
        }
        const terminal = (ether as { terminal?: unknown }).terminal;
        if (
          terminal !== null &&
          typeof terminal === "object" &&
          typeof (terminal as { bindingId?: unknown }).bindingId === "string"
        ) {
          const b = (terminal as { bindingId: string }).bindingId;
          if (b.length > 0 && b.length <= 256) bindingId = b;
        }
      }
      if (kind === null) {
        const nodeType = (node as { type?: unknown }).type;
        if (
          typeof nodeType === "string" &&
          nodeType.length > 0 &&
          nodeType.length <= 128
        ) {
          kind = nodeType;
        }
      }

      if (bindingId !== null) {
        if (claimedBindings.has(bindingId)) {
          bindingId = null;
        } else {
          claimedBindings.add(bindingId);
        }
      }

      insert.run(document.name, entityId, kind, bindingId, now, now);
    }
  }
};

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
      `${label} identity is not a recognized Vellum Command schema`,
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
): void => {
  const after = expandSchemaSnapshot(database);
  for (const [tableName, beforeColumns] of before.tables) {
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
    if ((migration.replacesTables?.length ?? 0) > 0) return true;
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
  const sideObjects = sideObjectsForReplacedTables(database, replacesTables);
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
              (replacesObjects.size > 0 || replacesTables.size > 0)
            ) ||
            // DROP TABLE also emits DELETE against the table body.
            isReplacedTable ||
            isMigrateBackup
          )
        ) &&
        !(
          actionCode === constants.SQLITE_DROP_TABLE &&
          (isReplacedTable || isMigrateBackup)
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
        !replacesTables.has(arg1)
      ) ||
      (
        actionCode === constants.SQLITE_UPDATE &&
        arg1 !== null &&
        arg2 !== null &&
        before.tables.get(arg1)?.has(arg2) === true
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
    assertExpandSchemaPreserved(before, database, replacesObjects);
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

const verifyRecordedCurrentSchemaReadOnly = (
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
  const expected = verifyStateSchema(database, currentSchemaSql);
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
      migration.safety !== STATE_SCHEMA_MIGRATION_SAFETY
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
  if (version === plan.currentVersion && version !== 0) return false;

  if (version === 0 && plan.baselineVersion === plan.currentVersion) {
    verifyRecordedCurrentSchemaReadOnly(database, plan.currentSchemaSql);
    return true;
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
 * Initialize, adopt, or migrate the sole Vellum Command database in one transaction.
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
