import {
  constants,
  DatabaseSync,
  type SQLOutputValue,
} from "node:sqlite";
import { STATE_SCHEMA_SQL } from "./schema";
import {
  AUTOMATION_BOARDS_STATE_SCHEMA_SQL,
  CANVAS_EDITOR_COLUMN_SQL,
  PEERS_STATE_SCHEMA_SQL,
  STUBS_STATE_SCHEMA_SQL,
} from "../model/state-schema";
import { AUTOMATION_NODE_ARCHIVES_SQL, AUTOMATION_STATE_SCHEMA_SQL } from "../automation/state-schema";
import {
  CANVAS_COPY_HISTORY_STATE_SCHEMA_SQL,
  WORK_EXCHANGE_CURSORS_V16_STATE_SCHEMA_SQL,
} from "../work/exchange/state-schema";
import {
  MACHINE_NAMES_CORRECTED_TABLES,
  MACHINE_NAMES_REMOVED_TABLES,
  MACHINE_NAMES_RENAMED_TABLES,
  migrateMachineNames,
} from "./migrate-machine-names";
import {
  migrateOneMachineLog,
  ONE_MACHINE_LOG_REMOVED_TABLES,
  ONE_MACHINE_LOG_RETIRED_FACT_COLUMNS,
} from "../work/migrate-one-machine-log";
import { migrateSeatPins } from "./migrate-seat-pins";
import { migrateSeatSessionData } from "./migrate-seat-session-data";
import { migrateSeatRows } from "./migrate-seat-rows";
import { migrateRetireOnRemove } from "./migrate-retire-on-remove";
import { migrateRulingActor } from "./migrate-ruling-actor";
import { migrateArtifactBodyRefs } from "./migrate-artifact-body-refs";
import { migrateTaskModel } from "./migrate-task-model";
import { migrateReviewStamps } from "./migrate-review-stamps";
import { migrateTaskStateSince } from "./migrate-task-state-since";
import {
  CANVAS_DELETIONS_CORRECTED_TABLES,
  CANVAS_DELETIONS_REMOVED_TABLES,
  CANVAS_DELETIONS_REPLACED_TABLES,
  CANVAS_DELETIONS_RETIRED_COLUMNS,
  migrateCanvasDeletions,
} from "./migrate-canvas-deletions";
import { RELAY_TRIGGER_PORT_REPLACED_TABLES, migrateRelayTriggerPort } from "./migrate-relay-trigger-port";
import { HARNESS_MODEL_CACHE_STATE_SCHEMA_SQL } from "../term/templates/harness-models-state-schema";
import {
  actualStateSchemaSha256,
  normalizeSchemaSql,
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

/** Artifacts as 25 -> 26 created them, before body refs (28 -> 29). Frozen. */
const ARTIFACTS_V26_SQL = `
  CREATE TABLE IF NOT EXISTS artifact_heads (
    canvas_name TEXT NOT NULL CHECK (length(canvas_name) BETWEEN 1 AND 256),
    artifact_id TEXT NOT NULL CHECK (length(artifact_id) = 26),
    node_id TEXT NOT NULL CHECK (length(node_id) BETWEEN 1 AND 256),
    type TEXT NOT NULL CHECK (type IN ('link', 'document', 'pad', 'sheet', 'file')),
    title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
    version INTEGER NOT NULL CHECK (version >= 1),
    created_by_json TEXT NOT NULL CHECK (json_valid(created_by_json)),
    updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
    archived INTEGER NOT NULL CHECK (archived IN (0, 1)),
    task_ids_json TEXT NOT NULL CHECK (json_valid(task_ids_json)),
    PRIMARY KEY (canvas_name, artifact_id)
  ) STRICT, WITHOUT ROWID;

  CREATE INDEX IF NOT EXISTS artifact_heads_by_node
    ON artifact_heads (canvas_name, node_id, updated_at DESC);

  CREATE TABLE IF NOT EXISTS artifact_versions (
    canvas_name TEXT NOT NULL,
    artifact_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version >= 1),
    op_id TEXT NOT NULL CHECK (length(op_id) = 26),
    author_json TEXT NOT NULL CHECK (json_valid(author_json)),
    at INTEGER NOT NULL CHECK (at >= 0),
    edit_json TEXT CHECK (edit_json IS NULL OR json_valid(edit_json)),
    body_json TEXT NOT NULL CHECK (json_valid(body_json)),
    PRIMARY KEY (canvas_name, artifact_id, version),
    CHECK ((version = 1) = (edit_json IS NULL)),
    FOREIGN KEY (canvas_name, artifact_id)
      REFERENCES artifact_heads (canvas_name, artifact_id)
      ON DELETE CASCADE
  ) STRICT, WITHOUT ROWID;
`;

/** Resource rulings as 25 -> 26 created them, before the actor (26 -> 27). Frozen. */
const RESOURCE_RULINGS_V26_SQL = `
  CREATE TABLE IF NOT EXISTS resource_rulings (
    canvas_name TEXT NOT NULL CHECK (length(canvas_name) BETWEEN 1 AND 256),
    writer TEXT NOT NULL CHECK (length(writer) BETWEEN 1 AND 256),
    op_id TEXT NOT NULL CHECK (length(op_id) = 26),
    kind TEXT NOT NULL CHECK (kind IN ('applied', 'refused')),
    ruling_json TEXT NOT NULL CHECK (json_valid(ruling_json)),
    PRIMARY KEY (canvas_name, writer, op_id)
  ) STRICT, WITHOUT ROWID;
`;

export const STATE_SCHEMA_MIGRATION_SAFETY = "expand-only" as const;
/**
 * A consolidation step drops the tables it names in `removesTables` and
 * rebuilds the ones it names in `replacesTables`, copying every kept row. It
 * is the only step class allowed to drop a table, and it names at least one.
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
  /** Exact columns retired by an operator-authorized consolidation rebuild. */
  readonly retiresColumns?: Readonly<Record<string, ReadonlyArray<string>>>;
  /**
   * Columns of `replacesTables` tables whose rebuild drops their NOT NULL:
   * the column keeps its name, type, default, key and position, and only
   * becomes nullable. Nothing else about a named column may change, it may
   * not be tightened, and every named column must be one the step relaxes.
   * Only valid on a consolidation step.
   */
  readonly relaxesNotNull?: Readonly<Record<string, ReadonlyArray<string>>>;
  /**
   * Durable tables this consolidation step retires: their content is migrated
   * into the canonical replacement inside the same step, then the table is
   * DROPped and never recreated. Only valid with safety "consolidate". The
   * same pre-transaction foreign_keys=OFF treatment as `replacesTables`
   * applies.
   */
  readonly removesTables?: ReadonlyArray<string>;
  /**
   * Durable tables this consolidation step renames, old name to new, with
   * `ALTER TABLE old RENAME TO new`. SQLite rewrites every reference to the
   * table itself; the table keeps its rows and columns. No other rename is
   * admitted.
   */
  readonly renamesTables?: Readonly<Record<string, string>>;
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
 * Version 13 is the floor: kinds replaced document authority there, and no
 * older database is opened. `bun run schema:identity` rewrites the head hash
 * after any schema change; the next schema edit advances
 * CURRENT_STATE_SCHEMA_VERSION and appends its step.
 */
export const STATE_SCHEMA_V13_IDENTITY = {
  actualSchemaSha256:
    "5c7bc7241a4a81d1d0813ac85169b09a83e4c447dcf433670a273d9dc4c4720f",
} as const satisfies VerifiedStateSchemaIdentity;

/**
 * Version 14 drops the trigger that pinned every mailbox row to one machine:
 * mail lives on its seat's machine, whichever that is.
 */
export const STATE_SCHEMA_V14_IDENTITY = {
  actualSchemaSha256:
    "d6b5aa2a9f73723d6cfe7cc6f6b527415ef883a82473f6e438a0910828eca276",
} as const satisfies VerifiedStateSchemaIdentity;

/**
 * Version 15 drops the tables that carried tasks between machines and
 * rebuilds the work log without its links to them. Every fact survives.
 */
export const STATE_SCHEMA_V15_IDENTITY = {
  actualSchemaSha256:
    "a76f3cd89bf0f4de0164cc4aede76294a66dabe265da3bc1f802eb196ea3e073",
} as const satisfies VerifiedStateSchemaIdentity;

/**
 * Version 16 adds the row exchange cursors: how far this machine is caught up
 * on each writer's facts for each canvas. Expand only.
 */
export const STATE_SCHEMA_V16_IDENTITY = {
  actualSchemaSha256:
    "548d828a1b391a1038b601ef62695681bb0c007071f02f92ff7257bef098197c",
} as const satisfies VerifiedStateSchemaIdentity;

/**
 * Version 17 adds peers: the seats of other machines, as a machine holding a
 * copy of a canvas sees them. Expand only.
 */
export const STATE_SCHEMA_V17_IDENTITY = {
  actualSchemaSha256:
    "e97f1a02b6e7caad55dfa952f76c78a1aaabb68b2519c0375a4ea064161dd062",
} as const satisfies VerifiedStateSchemaIdentity;

/**
 * Version 18 names, on each canvas, the machine that may change it. Every
 * canvas already held is this machine's. Expand only.
 */
export const STATE_SCHEMA_V18_IDENTITY = {
  actualSchemaSha256:
    "3370750f0a2e8f37a68757a9107c03c6617778841845382f368ec1cacee6feb8",
} as const satisfies VerifiedStateSchemaIdentity;

/**
 * Version 19 adds what the editing machine remembers of the copies it sent:
 * the counts, and where each seat was at each. Expand only.
 */
export const STATE_SCHEMA_V19_IDENTITY = {
  actualSchemaSha256:
    "ff9740c27d75838011ae3a9096bc44f5ee4b6d5e0920b3cc59c76c63b02555f6",
} as const satisfies VerifiedStateSchemaIdentity;

/**
 * Version 20 makes the session each seat row names the seat's open session in
 * the seat sessions store, and gives every session there its binding. The
 * table is rebuilt for the new column; every session survives.
 */
export const STATE_SCHEMA_V20_IDENTITY = {
  actualSchemaSha256:
    "ad2673cb715e3ef9bb5edd13fb7b8464db3fedb74e79167f9c3da70eee2ca6c1",
} as const satisfies VerifiedStateSchemaIdentity;

/**
 * Version 21 gives every machine a real name: the identity tables take their
 * plain names, this machine's configuration and the machines it knows move to
 * their new tables, and no canvas row says `local` any more.
 */
export const STATE_SCHEMA_V21_IDENTITY = {
  actualSchemaSha256:
    "3f66bf3f3123345039d6bd1bd9eda6c4bed42ffb7d5bb1ade4ed7ae0d5903148",
} as const satisfies VerifiedStateSchemaIdentity;

/**
 * Version 22 keeps everything about a seat session in this database: its
 * notes, the note for its next session, who ended it and when it onboarded
 * are on its row, kept whole, and the continuation ledger and the offboard
 * clock have tables. The step imports the files under `~/.junto/seats` once;
 * nothing lives there any more.
 */
export const STATE_SCHEMA_V22_IDENTITY = {
  actualSchemaSha256:
    "9eb0519e24c5662639d6dcde2592266d5e2c60a70774fe6d8eae501461443976",
} as const satisfies VerifiedStateSchemaIdentity;

/**
 * Version 23 keeps what this machine's agent CLIs offer in tables, a cache
 * rebuilt from the CLIs: each harness's last scan, its models, their efforts
 * and its profiles, with a full-text index over the models. Nothing is written
 * to `~/.junto/state/harness-models.json` any more.
 */
export const STATE_SCHEMA_V23_IDENTITY = {
  actualSchemaSha256:
    "1578cf99d1019ab060d00f938f50c4128689f6eca41f43c4102f2cb6e441c6d8",
} as const satisfies VerifiedStateSchemaIdentity;

/**
 * Version 24 retires `seats.session_id`, which nothing read after 19 -> 20,
 * and says "stop" where a seat or terminal row said "kill-session".
 */
export const STATE_SCHEMA_V24_IDENTITY = {
  actualSchemaSha256:
    "2dedbf9a2fa06bc55dcfda50592e467664b87c9572b1ce147b24813e5aaadd25",
} as const satisfies VerifiedStateSchemaIdentity;

/**
 * Version 25 retires `on_remove` from seats and terminals: nothing read it for
 * either. Pages keep theirs.
 */
export const STATE_SCHEMA_V25_IDENTITY = {
  actualSchemaSha256:
    "abad16a0ab2aa95be9c7c233e61c5ba609c449b3a4415c080ab0d432f03a8a4e",
} as const satisfies VerifiedStateSchemaIdentity;

/**
 * Version 26 adds versioned artifacts and the shared rulings on resource
 * commands (0.10, plans 02 and 05). Expand only: `work_artifacts` and its
 * publish path are left for their own deletion.
 */
export const STATE_SCHEMA_V26_IDENTITY = {
  actualSchemaSha256:
    "440ace1f1a5f36092904e5604066fec7b01fa31f39816f820e766a6c0bf2d57e",
} as const satisfies VerifiedStateSchemaIdentity;

/**
 * Version 27 puts the actor on every resource ruling, so a seat reads its own
 * writes with `junto op show` and `junto op list`.
 */
export const STATE_SCHEMA_V27_IDENTITY = {
  actualSchemaSha256:
    "46b6f38f44f029f1ce2ddc386e1c02231153cc25ef84f38b270a0fe73d371add",
} as const satisfies VerifiedStateSchemaIdentity;

/**
 * Version 28 adds the Automations node and its store: the automation heads,
 * the runner's cursors, and its firings, the claim slots keyed by automation
 * with their history (0.10, plan 07). Expand only.
 */
export const STATE_SCHEMA_V28_IDENTITY = {
  actualSchemaSha256:
    "1ad62cabba205a19c62d885a4a2a86be4f7c6f5bddd354ad7a76dba60a8b5c76",
} as const satisfies VerifiedStateSchemaIdentity;

/**
 * Version 29 names every artifact version's body by content ref and lets a
 * replica hold a version whose bytes are pending: `body_ref_json` on every
 * version, and the required `body_json` retired for a nullable
 * `inline_body_json` (0.10, plan 05 with 02).
 */
export const STATE_SCHEMA_V29_IDENTITY = {
  actualSchemaSha256:
    "6ce1b20e80ade3b95a6a98919f6119d64a4500119b39e5d43853eb14bde05958",
} as const satisfies VerifiedStateSchemaIdentity;

/**
 * Version 30 adds stubs: the files, links, repositories and pages of a canvas
 * another machine edits, as this machine's copy holds them, with no path or
 * address. Expand only.
 */
export const STATE_SCHEMA_V30_IDENTITY = {
  actualSchemaSha256:
    "4ae32757b439425bcda3df39f07a8edcffca5af44b152ee6b40d24d60c17bc27",
} as const satisfies VerifiedStateSchemaIdentity;

/**
 * Version 31 adds the 0.10 tasks (plan 04): `task_heads`, `task_layers` and
 * `task_numbers`, with every stored task copied in through the contract's
 * state remap (`migrate-task-model.ts`). Expand only.
 */
export const STATE_SCHEMA_V31_IDENTITY = {
  actualSchemaSha256:
    "b4f31a7c29db5bee02d6d2b851eae5aac95f3a9f061c839d52de60b984e92b3d",
} as const satisfies VerifiedStateSchemaIdentity;

/**
 * Version 32 deletes what 0.10 deletes (plan 09): the pad, sheet and
 * scheduler kinds with their nodes and wires, the verbs no kind says any
 * more, `feeds` stored as `flows`, the tables of removed features, and
 * Hermes from the machine list. Consolidate.
 */
export const STATE_SCHEMA_V32_IDENTITY = {
  actualSchemaSha256:
    "c9311b4af0b6f7dd1293b087cbf4402b67c5f184cd90b951cd8bd2bdd291ffda",
} as const satisfies VerifiedStateSchemaIdentity;

/**
 * Version 33 names each review verdict's reviewer kind, so the operator can
 * stamp and a task stamp is keyed by its reviewer's node (0.10, plan 04,
 * ruling 1b): `work_review_verdicts` rebuilt with `reviewer_kind` and seat
 * ids required only where a verdict needs them.
 */
export const STATE_SCHEMA_V33_IDENTITY = {
  actualSchemaSha256:
    "d3c517a7a11922df59dbd3159fec503ab5f4824889ab8d0d46bf30e597d5b234",
} as const satisfies VerifiedStateSchemaIdentity;

/**
 * Version 34 remembers which automations a deleted Automations node archived
 * (plan 07): `automation_node_archives`, so undoing the delete restores
 * exactly those, each as it was. Expand only.
 */
export const STATE_SCHEMA_V34_IDENTITY = {
  actualSchemaSha256:
    "cbe4024d72a8dd25b14a9b1575225f0084fe043c5c8d9312523dcf8b61c01cd9",
} as const satisfies VerifiedStateSchemaIdentity;

/**
 * Version 35 takes the retired `relay.trigger` port out of every stored wire
 * mask, so the port can leave the closed list masks decode against. The
 * schema text does not move. Consolidate.
 */
export const STATE_SCHEMA_V35_IDENTITY = {
  actualSchemaSha256:
    "cbe4024d72a8dd25b14a9b1575225f0084fe043c5c8d9312523dcf8b61c01cd9",
} as const satisfies VerifiedStateSchemaIdentity;

/**
 * Version 36 keeps when each task's state began (plan 04, the seat ring's
 * stall times): `task_heads` rebuilt with `state_since`, backfilled from the
 * task's last stored transition (`migrate-task-state-since.ts`).
 */
export const STATE_SCHEMA_V36_IDENTITY = {
  actualSchemaSha256:
    "f63759002b670cfae4730bbba7a47414624d0e14fb96d7a24cd9d2785a44346e",
} as const satisfies VerifiedStateSchemaIdentity;

export const CURRENT_STATE_SCHEMA_VERSION = 36;

/**
 * Stable alias for the head identity so tests and tooling never rename an
 * import on a schema bump. `bun run schema:identity` rewrites the constant
 * above after any schema change.
 */
export const CURRENT_STATE_SCHEMA_IDENTITY: VerifiedStateSchemaIdentity =
  STATE_SCHEMA_V36_IDENTITY;

/**
 * Version 13 is the oldest database Junto opens: steps below it, and the
 * legacy row converters only they used, are gone. Each later schema change
 * appends its step here.
 */
export const STATE_SCHEMA_MIGRATIONS: ReadonlyArray<StateSchemaMigration> = [
  {
    fromVersion: 13,
    toVersion: 14,
    name: "let mail live on any machine",
    safety: STATE_SCHEMA_MIGRATION_SAFETY,
    fromIdentity: STATE_SCHEMA_V13_IDENTITY,
    // No row changes: the trigger only refused inserts, and nothing replaces it.
    replacesObjects: ["trigger:work_messages_require_cc_home"],
    migrate: (database) => {
      database.exec("DROP TRIGGER work_messages_require_cc_home");
    },
  },
  {
    fromVersion: 14,
    toVersion: 15,
    name: "keep the work log of one machine",
    safety: STATE_SCHEMA_CONSOLIDATE_SAFETY,
    fromIdentity: STATE_SCHEMA_V14_IDENTITY,
    removesTables: [...ONE_MACHINE_LOG_REMOVED_TABLES],
    replacesTables: ["work_events", "work_facts"],
    retiresColumns: { work_facts: [...ONE_MACHINE_LOG_RETIRED_FACT_COLUMNS] },
    migrate: migrateOneMachineLog,
  },
  {
    fromVersion: 15,
    toVersion: 16,
    name: "add row exchange cursors",
    safety: STATE_SCHEMA_MIGRATION_SAFETY,
    fromIdentity: STATE_SCHEMA_V15_IDENTITY,
    migrate: (database) => {
      database.exec(WORK_EXCHANGE_CURSORS_V16_STATE_SCHEMA_SQL);
    },
  },
  {
    fromVersion: 16,
    toVersion: 17,
    name: "add peers",
    safety: STATE_SCHEMA_MIGRATION_SAFETY,
    fromIdentity: STATE_SCHEMA_V16_IDENTITY,
    migrate: (database) => {
      database.exec(PEERS_STATE_SCHEMA_SQL);
    },
  },
  {
    fromVersion: 17,
    toVersion: 18,
    name: "name the machine that edits each canvas",
    safety: STATE_SCHEMA_MIGRATION_SAFETY,
    fromIdentity: STATE_SCHEMA_V17_IDENTITY,
    migrate: (database) => {
      database.exec(`ALTER TABLE canvases ADD COLUMN ${CANVAS_EDITOR_COLUMN_SQL}`);
      database.exec(`
        UPDATE canvases
        SET editor_installation_id = (
          SELECT installation_id FROM station_installation WHERE singleton = 1
        )
      `);
    },
  },
  {
    fromVersion: 18,
    toVersion: 19,
    name: "remember the canvas copies sent",
    safety: STATE_SCHEMA_MIGRATION_SAFETY,
    fromIdentity: STATE_SCHEMA_V18_IDENTITY,
    migrate: (database) => {
      database.exec(CANVAS_COPY_HISTORY_STATE_SCHEMA_SQL);
    },
  },
  {
    fromVersion: 19,
    toVersion: 20,
    name: "keep each seat's session pin in the seat sessions store",
    safety: STATE_SCHEMA_CONSOLIDATE_SAFETY,
    fromIdentity: STATE_SCHEMA_V19_IDENTITY,
    replacesTables: ["seat_sessions"],
    migrate: (database) => migrateSeatPins(database),
  },
  {
    fromVersion: 20,
    toVersion: 21,
    name: "name this machine and the machines it knows",
    safety: STATE_SCHEMA_CONSOLIDATE_SAFETY,
    fromIdentity: STATE_SCHEMA_V20_IDENTITY,
    removesTables: [...MACHINE_NAMES_REMOVED_TABLES],
    replacesTables: ["host_registry"],
    retiresColumns: { host_registry: ["kind"] },
    renamesTables: MACHINE_NAMES_RENAMED_TABLES,
    replacesObjects: [
      "trigger:station_known_installation_identity_immutable",
      "trigger:station_local_installation_identity_immutable",
    ],
    correctiveWriteTables: [...MACHINE_NAMES_CORRECTED_TABLES],
    migrate: (database) => migrateMachineNames(database),
  },
  {
    fromVersion: 21,
    toVersion: 22,
    name: "keep seat session notes and marks in the database",
    safety: STATE_SCHEMA_CONSOLIDATE_SAFETY,
    fromIdentity: STATE_SCHEMA_V21_IDENTITY,
    replacesTables: ["seat_sessions"],
    retiresColumns: { seat_sessions: ["notes_path"] },
    migrate: (database) => migrateSeatSessionData(database),
  },
  {
    fromVersion: 22,
    toVersion: 23,
    name: "add the harness model tables",
    safety: STATE_SCHEMA_MIGRATION_SAFETY,
    fromIdentity: STATE_SCHEMA_V22_IDENTITY,
    migrate: (database) => {
      database.exec(HARNESS_MODEL_CACHE_STATE_SCHEMA_SQL);
    },
  },
  {
    fromVersion: 23,
    toVersion: 24,
    name: "retire the seat row's session column and say stop",
    safety: STATE_SCHEMA_CONSOLIDATE_SAFETY,
    fromIdentity: STATE_SCHEMA_V23_IDENTITY,
    replacesTables: ["seats", "terminals"],
    retiresColumns: { seats: ["session_id"] },
    migrate: (database) => migrateSeatRows(database),
  },
  {
    fromVersion: 24,
    toVersion: 25,
    name: "retire on_remove from seats and terminals",
    safety: STATE_SCHEMA_CONSOLIDATE_SAFETY,
    fromIdentity: STATE_SCHEMA_V24_IDENTITY,
    replacesTables: ["seats", "terminals"],
    retiresColumns: { seats: ["on_remove"], terminals: ["on_remove"] },
    migrate: (database) => migrateRetireOnRemove(database),
  },
  {
    fromVersion: 25,
    toVersion: 26,
    name: "add versioned artifacts and resource rulings",
    safety: STATE_SCHEMA_MIGRATION_SAFETY,
    fromIdentity: STATE_SCHEMA_V25_IDENTITY,
    migrate: (database) => {
      database.exec(RESOURCE_RULINGS_V26_SQL);
      database.exec(ARTIFACTS_V26_SQL);
    },
  },
  {
    fromVersion: 26,
    toVersion: 27,
    name: "put the actor on resource rulings",
    safety: STATE_SCHEMA_CONSOLIDATE_SAFETY,
    fromIdentity: STATE_SCHEMA_V26_IDENTITY,
    replacesTables: ["resource_rulings"],
    migrate: (database) => migrateRulingActor(database),
  },
  {
    fromVersion: 27,
    toVersion: 28,
    name: "add the automations node and its store",
    safety: STATE_SCHEMA_MIGRATION_SAFETY,
    fromIdentity: STATE_SCHEMA_V27_IDENTITY,
    migrate: (database) => {
      database.exec(AUTOMATION_BOARDS_STATE_SCHEMA_SQL);
      database.exec(AUTOMATION_STATE_SCHEMA_SQL);
    },
  },
  {
    fromVersion: 28,
    toVersion: 29,
    name: "name artifact bodies by content ref",
    safety: STATE_SCHEMA_CONSOLIDATE_SAFETY,
    fromIdentity: STATE_SCHEMA_V28_IDENTITY,
    replacesTables: ["artifact_versions"],
    retiresColumns: { artifact_versions: ["body_json"] },
    migrate: (database) => migrateArtifactBodyRefs(database),
  },
  {
    fromVersion: 29,
    toVersion: 30,
    name: "add stubs",
    safety: STATE_SCHEMA_MIGRATION_SAFETY,
    fromIdentity: STATE_SCHEMA_V29_IDENTITY,
    migrate: (database) => {
      database.exec(STUBS_STATE_SCHEMA_SQL);
    },
  },
  {
    fromVersion: 30,
    toVersion: 31,
    name: "add the task tables and copy every task into them",
    safety: STATE_SCHEMA_MIGRATION_SAFETY,
    fromIdentity: STATE_SCHEMA_V30_IDENTITY,
    migrate: (database) => migrateTaskModel(database),
  },
  {
    fromVersion: 31,
    toVersion: 32,
    name: "delete what 0.10 deletes",
    safety: STATE_SCHEMA_CONSOLIDATE_SAFETY,
    fromIdentity: STATE_SCHEMA_V31_IDENTITY,
    removesTables: [...CANVAS_DELETIONS_REMOVED_TABLES],
    replacesTables: [...CANVAS_DELETIONS_REPLACED_TABLES],
    retiresColumns: CANVAS_DELETIONS_RETIRED_COLUMNS,
    correctiveWriteTables: [...CANVAS_DELETIONS_CORRECTED_TABLES],
    migrate: migrateCanvasDeletions,
  },
  {
    fromVersion: 32,
    toVersion: 33,
    name: "name each review verdict's reviewer kind",
    safety: STATE_SCHEMA_CONSOLIDATE_SAFETY,
    fromIdentity: STATE_SCHEMA_V32_IDENTITY,
    replacesTables: ["work_review_verdicts"],
    relaxesNotNull: { work_review_verdicts: ["reviewer_seat_id", "author_seat_id"] },
    migrate: (database) => migrateReviewStamps(database),
  },
  {
    fromVersion: 33,
    toVersion: 34,
    name: "remember the automations a node delete archived",
    safety: STATE_SCHEMA_MIGRATION_SAFETY,
    fromIdentity: STATE_SCHEMA_V33_IDENTITY,
    migrate: (database) => {
      database.exec(AUTOMATION_NODE_ARCHIVES_SQL);
    },
  },
  {
    fromVersion: 34,
    toVersion: 35,
    name: "take relay.trigger out of every wire mask",
    safety: STATE_SCHEMA_CONSOLIDATE_SAFETY,
    fromIdentity: STATE_SCHEMA_V34_IDENTITY,
    replacesTables: [...RELAY_TRIGGER_PORT_REPLACED_TABLES],
    migrate: migrateRelayTriggerPort,
  },
  {
    fromVersion: 35,
    toVersion: 36,
    name: "keep when each task's state began",
    safety: STATE_SCHEMA_CONSOLIDATE_SAFETY,
    fromIdentity: STATE_SCHEMA_V35_IDENTITY,
    replacesTables: ["task_heads"],
    migrate: (database) => migrateTaskStateSince(database),
  },
];

export const STATE_SCHEMA_MIGRATION_PLAN: StateSchemaMigrationPlan = {
  baselineVersion: 13,
  baselineIdentity: STATE_SCHEMA_V13_IDENTITY,
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
  retiredColumns: Readonly<Record<string, ReadonlyArray<string>>> = {},
  renamedTables: Readonly<Record<string, string>> = {},
  relaxedNotNull: Readonly<Record<string, ReadonlyArray<string>>> = {},
): void => {
  const after = expandSchemaSnapshot(database);
  // A declared relax names a column the step really relaxes, so a stale one cannot widen a later rebuild.
  for (const [tableName, columns] of Object.entries(relaxedNotNull)) {
    for (const columnName of columns) {
      const beforeColumn = before.tables.get(tableName)?.get(columnName);
      const afterColumn = after.tables.get(tableName)?.get(columnName);
      if (beforeColumn?.notNull !== 1 || afterColumn?.notNull !== 0) {
        throw new Error(
          `state schema consolidation step declared ${tableName}.${columnName} relaxed but does not drop its NOT NULL`,
        );
      }
    }
  }
  /** An object's stored text as SQLite leaves it once the renamed tables carry their new names. */
  const renamed = (sql: string | null): string | null => {
    if (sql === null) return null;
    let text = sql;
    for (const [from, to] of Object.entries(renamedTables)) {
      text = text.replace(new RegExp(`(?<![A-Za-z0-9_])${from}(?![A-Za-z0-9_])`, "gu"), to);
    }
    return normalizeSchemaSql(text);
  };
  for (const [tableName, beforeColumns] of before.tables) {
    if (removedTables.has(tableName)) {
      if (after.tables.has(tableName)) {
        throw new Error(
          `state schema consolidation step retained table ${tableName} it declared removed`,
        );
      }
      continue;
    }
    const afterColumns = after.tables.get(renamedTables[tableName] ?? tableName);
    if (afterColumns === undefined) {
      throw new Error(
        `state schema startup migration removed table ${tableName}`,
      );
    }
    for (const [columnName, beforeColumn] of beforeColumns) {
      const afterColumn = afterColumns.get(columnName);
      if (retiredColumns[tableName]?.includes(columnName)) {
        if (afterColumn !== undefined) throw new Error(`consolidation retained retired column ${tableName}.${columnName}`);
        continue;
      }
      // A relaxed column is the same column once its NOT NULL is put back.
      const compared = relaxedNotNull[tableName]?.includes(columnName) === true && afterColumn !== undefined
        ? { ...afterColumn, notNull: 1 }
        : afterColumn;
      if (
        compared === undefined ||
        JSON.stringify(compared) !== JSON.stringify(beforeColumn)
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
    const kept = after.retainedObjects.get(key);
    // Byte for byte, unless the step renamed a table: then SQLite rewrote the
    // name inside every object that refers to it, and nothing else.
    const follows =
      Object.keys(renamedTables).length > 0 &&
      typeof kept === "string" &&
      normalizeSchemaSql(kept) === renamed(sql);
    if (kept !== sql && !follows) {
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

const assertExpandOnlyMigrationSql = (
  sql: string,
  renamesTables: Readonly<Record<string, string>> = {},
): void => {
  let withoutComments = sql
    .replace(/--[^\r\n]*/gu, " ")
    .replace(/\/\*[\s\S]*?\*\//gu, " ");
  // The renames a step declares are the only ones it may make.
  for (const [from, to] of Object.entries(renamesTables)) {
    withoutComments = withoutComments.replace(
      new RegExp(`\\balter\\s+table\\s+${from}\\s+rename\\s+to\\s+${to}\\s*(?=;|$)`, "giu"),
      " ",
    );
  }
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
  const renamedTo = new Set<string>(Object.values(migration.renamesTables ?? {}));
  const sideObjects = sideObjectsForReplacedTables(
    database,
    new Set([...replacesTables, ...removesTables]),
  );
  const connection: StateSchemaMigrationDatabase = {
    exec: (sql) => {
      assertExpandOnlyMigrationSql(sql, migration.renamesTables);
      database.exec(sql);
    },
    prepare: (sql, options) => {
      assertExpandOnlyMigrationSql(sql, migration.renamesTables);
      return database.prepare(sql, options);
    },
  };
  database.setAuthorizer((actionCode, arg1, arg2) => {
    const pragmaName = arg1 === null ? "" : arg1.toLowerCase();
    const isSchemaCatalog =
      arg1 === "sqlite_schema" || arg1 === "sqlite_master";
    const isReplacedTable = arg1 !== null && replacesTables.has(arg1);
    const isRemovedTable = arg1 !== null && removesTables.has(arg1);
    // A table the step made itself is the step's to drop: a backup, or a
    // working copy under any name. A durable table under its new name is not.
    const isMigrateBackup =
      arg1 !== null &&
      (arg1.endsWith("__migrate_bak") ||
        (!isSchemaCatalog &&
          !arg1.startsWith("sqlite_") &&
          !before.tables.has(arg1) &&
          !renamedTo.has(arg1)));
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
      migration.retiresColumns,
      migration.renamesTables,
      migration.relaxesNotNull,
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
      ((migration.removesTables?.length ?? 0) > 0 || (migration.replacesTables?.length ?? 0) > 0) !==
        (migration.safety === STATE_SCHEMA_CONSOLIDATE_SAFETY) ||
      ((migration.correctiveWriteTables?.length ?? 0) > 0 &&
        migration.safety !== STATE_SCHEMA_CONSOLIDATE_SAFETY) ||
      (Object.keys(migration.renamesTables ?? {}).length > 0 &&
        migration.safety !== STATE_SCHEMA_CONSOLIDATE_SAFETY) ||
      (migration.retiresColumns !== undefined && (
        migration.safety !== STATE_SCHEMA_CONSOLIDATE_SAFETY ||
        Object.keys(migration.retiresColumns).some((table) => !migration.replacesTables?.includes(table))
      )) ||
      (migration.relaxesNotNull !== undefined && (
        migration.safety !== STATE_SCHEMA_CONSOLIDATE_SAFETY ||
        Object.keys(migration.relaxesNotNull).some((table) => !migration.replacesTables?.includes(table))
      ))
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
 * non-empty version-zero database must match the frozen baseline witness exactly.
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
