import {
  constants,
  DatabaseSync,
  type SQLOutputValue,
} from "node:sqlite";
import { STATE_SCHEMA_SQL } from "./schema";
import {
  AUTOMATION_BOARDS_STATE_SCHEMA_SQL,
  CANVAS_EDITOR_COLUMN_SQL,
  FILE_TREES_STATE_SCHEMA_SQL,
  PEERS_STATE_SCHEMA_SQL,
  STUBS_V30_STATE_SCHEMA_SQL,
} from "../model/state-schema";
import { AUTOMATION_FIRING_REV_COLUMN_SQL, AUTOMATION_NODE_ARCHIVES_SQL, AUTOMATION_RULING_CURSORS_SQL, AUTOMATION_V28_STATE_SCHEMA_SQL } from "../automation/state-schema";
import { TASK_SEAT_RELEASES_SQL } from "../work/task-state-schema";
import { MACHINE_CODE_ALLOWANCES_SQL } from "../automation/code-allowance-schema";
import { MACHINE_PEER_BINDING_COLUMN_SQL } from "../machines/state-schema";
import { SEAT_CONTROLS_STATE_SCHEMA_SQL } from "../work/seat-controls-state-schema";
import { FLEET_CONSENSUS_SEED_SQL, FLEET_CONSENSUS_STATE_SCHEMA_SQL, FLEET_COPY_LIST_STATE_SCHEMA_SQL, FLEET_STRUCTURE_LOG_STATE_SCHEMA_SQL } from "../fleet/state-schema";
import { MACHINE_VAULT_TOKENS_SQL } from "../vault/state-schema";
import { SHOT_PURGES_SQL } from "../work/shot-purge-schema";
import {
  AUTOMATION_PLACEMENTS_STATE_SCHEMA_SQL,
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
import { migrateTaskChecks } from "./migrate-task-checks";
import { migrateTaskArchivedFrom } from "./migrate-task-archived-from";
import { migrateTaskFinishNotes } from "./migrate-task-finish-notes";
import { migrateSignalContentOwner } from "./migrate-signal-content-owner";
import { migrateSignalKinds, SIGNAL_KINDS_REPLACED_TABLES } from "../signals/migrate-signal-kinds";
import { migrateStubFiles, STUB_FILES_REPLACED_TABLES } from "./migrate-stub-files";
import { WORK_MENTIONS_SQL } from "../work/mention-state-schema";
import {
  ARTIFACT_LABEL_COLOURS_STATE_SCHEMA_SQL,
  ARTIFACT_MOVES_STATE_SCHEMA_SQL,
  ARTIFACT_LABELS_STATE_SCHEMA_SQL,
  ARTIFACT_LINKS_STATE_SCHEMA_SQL,
} from "../work/artifact-state-schema";
import { rebuildMentions } from "../work/mention-backlinks";
import {
  CANVAS_DELETIONS_CORRECTED_TABLES,
  CANVAS_DELETIONS_REMOVED_TABLES,
  CANVAS_DELETIONS_REPLACED_TABLES,
  CANVAS_DELETIONS_RETIRED_COLUMNS,
  migrateCanvasDeletions,
} from "./migrate-canvas-deletions";
import { RELAY_TRIGGER_PORT_REPLACED_TABLES, migrateRelayTriggerPort } from "./migrate-relay-trigger-port";
import { DERIVES_VERB_REPLACED_TABLES, migrateDerivesVerb } from "./migrate-derives-verb";
import {
  TASK_ARTIFACT_PORTS_REPLACED_TABLES,
  migrateTaskArtifactPorts,
} from "./migrate-task-artifact-ports";
import {
  BOARD_REQUESTS_REMOVED_TABLES,
  BOARD_REQUESTS_REPLACED_TABLES,
  migrateBoardRequests,
} from "./migrate-board-requests";
import { HARNESS_MODEL_CACHE_STATE_SCHEMA_SQL } from "../term/templates/harness-models-state-schema";
import { VIEW_CAPTURE_DESK_SCHEMA_SQL, VIEW_CAPTURE_INBOX_SCHEMA_SQL, VIEW_STATE_SCHEMA_SQL } from "../view-state/state-schema";
import { OPERATOR_MAIL_READS_SCHEMA_SQL } from "../work/mail-reads-state-schema";
import { WORK_MESSAGES_SENDER_INDEX_SQL } from "../work/state-schema";
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

/** The touched-origin record as 37 -> 38 created it, before 39 -> 40 eased its limit. Frozen. */
const BROWSER_TOUCHED_ORIGINS_V38_SQL = `
  CREATE TABLE IF NOT EXISTS browser_touched_origins (
    profile TEXT NOT NULL
      CHECK (
        length(profile) BETWEEN 1 AND 63
        AND substr(profile, 1, 1) GLOB '[a-z0-9]'
        AND profile NOT GLOB '*[^a-z0-9-]*'
      ),
    origin TEXT NOT NULL
      CHECK (
        length(CAST(origin AS BLOB)) BETWEEN 1 AND 2048
        AND (origin GLOB 'https://?*' OR origin GLOB 'http://?*')
      ),
    PRIMARY KEY (profile, origin)
  ) STRICT, WITHOUT ROWID;

  CREATE TRIGGER IF NOT EXISTS browser_touched_origins_limit
  BEFORE INSERT ON browser_touched_origins
  WHEN (SELECT count(*) FROM browser_touched_origins) >= 4096
  BEGIN
    SELECT RAISE(ABORT, 'browser touched-origin limit reached');
  END;
`;

/** The touched-origin limit as 39 -> 40 leaves it: a held origin passes a full record. Frozen. */
const BROWSER_TOUCHED_ORIGINS_LIMIT_V40_SQL = `
  CREATE TRIGGER IF NOT EXISTS browser_touched_origins_limit
  BEFORE INSERT ON browser_touched_origins
  WHEN (SELECT count(*) FROM browser_touched_origins) >= 4096
    AND NOT EXISTS (
      SELECT 1 FROM browser_touched_origins WHERE profile = NEW.profile AND origin = NEW.origin
    )
  BEGIN
    SELECT RAISE(ABORT, 'browser touched-origin limit reached');
  END;
`;

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

/**
 * Version 37 keeps the check runs on a task's current layer (plan 04, task
 * check): `task_heads` rebuilt with `checks_json`, each task starting with
 * none (`migrate-task-checks.ts`).
 */
export const STATE_SCHEMA_V37_IDENTITY = {
  actualSchemaSha256:
    "b260ce08f7be0bba01c816fa737358da770a7e939bc26aa30ab85d5726c0a491",
} as const satisfies VerifiedStateSchemaIdentity;

/**
 * Version 38 keeps the origins a seat ran code in, by browser profile
 * (`browser_touched_origins`), so their service workers are cleared at the
 * next start even after a crash. This machine's own state.
 */
export const STATE_SCHEMA_V38_IDENTITY = {
  actualSchemaSha256:
    "6312197ca401a3d11f1a679fabe46c1ca5081360679106e70384c8b4d7e310b8",
} as const satisfies VerifiedStateSchemaIdentity;

/**
 * Version 39 deletes the bulletin board and the requests node (0.10): their
 * nodes, tables and wires, the `participates` verb, the board ports, the
 * request lane of the old task store, the board owners of content refs, and
 * the journal rows of the retired board, request and pad operations.
 * Consolidate.
 */
export const STATE_SCHEMA_V39_IDENTITY = {
  actualSchemaSha256:
    "2abb7480b4f58d93bc0d6731bab5d98090679109a74e709472cd63461e9a9f5c",
} as const satisfies VerifiedStateSchemaIdentity;

/**
 * Version 40 lets a full touched-origin record admit an origin it already
 * holds, so a seat's eval in a recorded origin is not refused. Expand-only.
 */
export const STATE_SCHEMA_V40_IDENTITY = {
  actualSchemaSha256:
    "34426648fe48c97b2ccae370493fa405c7bb82e156942b64a6315c26cb93fe43",
} as const satisfies VerifiedStateSchemaIdentity;

/**
 * Version 41 remembers the open tasks a seat delete sent back to the backlog
 * (`task_seat_releases`), so undoing the delete gives each back to its seat
 * while no command has ruled on it since. This machine's own state.
 * Expand-only.
 */
export const STATE_SCHEMA_V41_IDENTITY = {
  actualSchemaSha256:
    "1bb64b2cd2d95ffecead64ec52f3604d0623afcb06ac28c722a7ccf0d96889f8",
} as const satisfies VerifiedStateSchemaIdentity;

/**
 * Version 42 keeps the page comments whose shot the operator purged
 * (`content_purges`), so the shot reads removed and is never pulled again.
 * Expand-only.
 */
export const STATE_SCHEMA_V42_IDENTITY = {
  actualSchemaSha256:
    "c6176345e0494e39022b76c11a0ebc7dd5ad98f7b7d92b12b989621272dd78ea",
} as const satisfies VerifiedStateSchemaIdentity;

/**
 * Version 43 keeps the closed state each archived task was archived from
 * (plan 04, finish waits on dependencies): `task_heads` rebuilt with
 * `archived_from`, each task starting with none
 * (`migrate-task-archived-from.ts`). Consolidate.
 */
export const STATE_SCHEMA_V43_IDENTITY = {
  actualSchemaSha256:
    "5a62ee9a0a701a0e8f9cf38d1dd95e3c5becc65e98e1e06f6f42d2c2141c439b",
} as const satisfies VerifiedStateSchemaIdentity;

/**
 * Version 44 keeps how far the automation runner has read each canvas's task
 * rulings (`automation_ruling_cursors`), so a change trigger fires once per
 * ruling, in the order rulings landed. Expand-only.
 */
export const STATE_SCHEMA_V44_IDENTITY = {
  actualSchemaSha256:
    "74a76dd3699512f0967acb9ad3e0c9cb4c2d2305688c0dbb971bae103f78f656",
} as const satisfies VerifiedStateSchemaIdentity;

/**
 * Version 45 keeps what the finish that ruled cited and the note it left
 * (plan 04): `task_heads` rebuilt with `evidence_json` and `handoff`, each
 * task starting with none (`migrate-task-finish-notes.ts`). Consolidate.
 */
export const STATE_SCHEMA_V45_IDENTITY = {
  actualSchemaSha256:
    "e7838f1d5ab8bb96734fb94a4008f2b6c564788d5c116ac9514c662606291e76",
} as const satisfies VerifiedStateSchemaIdentity;

/** The mentionable kinds' tables as version 46 names them, for its backfill. Frozen. */
export const MENTIONABLE_TABLES_V46 = [
  ["agent", "seats"],
  ["task", "task_boards"],
  ["artifacts", "artifact_boards"],
  ["page", "pages"],
] as const;

/**
 * Version 46 keeps where each seat, task, artifact and page is mentioned
 * (plan 03 section 3): `work_mentions`, a projection of mail rows, built
 * from every row already held (`work/mention-backlinks.ts`). Expand-only.
 */
export const STATE_SCHEMA_V46_IDENTITY = {
  actualSchemaSha256:
    "b71de53b744f1c5ca8b7c90ac3c600b58a66c6184f04648a299b96503ba41af4",
} as const satisfies VerifiedStateSchemaIdentity;

/**
 * Version 47 gives a signal's files an owner kind of their own (plan 02):
 * `content_refs` rebuilt with `signal` in its owner kind CHECK, each
 * `{ other, signal:<id> }` row moved to `{ signal, <id> }` in the same copy
 * (`migrate-signal-content-owner.ts`). Consolidate.
 */
export const STATE_SCHEMA_V47_IDENTITY = {
  actualSchemaSha256:
    "34452160b8cd729a99fbabbed23eae8393f1bcfae9c181557f56d2e074570f11",
} as const satisfies VerifiedStateSchemaIdentity;

/**
 * Version 48 takes the `tasks.*` ports and `artifact.publish` out of every
 * stored wire mask, so they can leave the closed list masks decode against:
 * a seat reaches those nodes by region, with no port. The schema text does
 * not move. Consolidate.
 */
export const STATE_SCHEMA_V48_IDENTITY = {
  actualSchemaSha256:
    "34452160b8cd729a99fbabbed23eae8393f1bcfae9c181557f56d2e074570f11",
} as const satisfies VerifiedStateSchemaIdentity;

/**
 * Version 49 lets the operator name a page, a file or a link: `label` added
 * as the last column of `pages`, `file_cards` and `link_cards`, empty on every
 * row already held. Expand only.
 */
export const STATE_SCHEMA_V49_IDENTITY = {
  actualSchemaSha256:
    "f3e72b3be6c97c0cc9ca5950d5e9a36c8054c067675a3e75bbede87059788bfa",
} as const satisfies VerifiedStateSchemaIdentity;

/**
 * Version 50 lets a task board derive into another (0.10.3): `wires` rebuilt
 * with `derives` in its verb CHECK, every row copied as it was, and
 * `derived_from` added to `task_heads`, null on every task already held,
 * with its index (`migrate-derives-verb.ts`). Consolidate, approved by the
 * operator.
 */
export const STATE_SCHEMA_V50_IDENTITY = {
  actualSchemaSha256:
    "47696d804762d9a5bc7b999e4192b3440217f34906a2935113d8c5fb545b000e",
} as const satisfies VerifiedStateSchemaIdentity;

/**
 * Version 51 adds the Files node (0.11): `file_trees`, one row per node, with
 * the machine its folder lives on and the folder's path there. Expand only.
 */
export const STATE_SCHEMA_V51_IDENTITY = {
  actualSchemaSha256:
    "8b26a65de1ca26a4c1dbd6a792f17d5bffc1012bd996e931982966fcd76c7e02",
} as const satisfies VerifiedStateSchemaIdentity;

/**
 * Version 52 keeps what each artifact's head body links (0.11, 02):
 * `work_artifact_links`, one row per (source artifact, target mention key),
 * rebuilt from the head body on every applied edit and rebuildable from the
 * bodies. Expand only.
 */
export const STATE_SCHEMA_V52_IDENTITY = {
  actualSchemaSha256:
    "810f2dd7a207fb19aa8a85a5b9d796b35c655a3fd6e5a8fe376909d3960150d5",
} as const satisfies VerifiedStateSchemaIdentity;

/**
 * Version 53 keeps an artifact's labels (0.11, 03): `artifact_labels`, one
 * row per label the head carries, replaced whole by every labels ruling. A
 * head from before the step has no rows and reads as none. Expand only.
 */
export const STATE_SCHEMA_V53_IDENTITY = {
  actualSchemaSha256:
    "a769e869bb7f8b86fceb67fe349e336757e60581298d05cf24762a1b03672be3",
} as const satisfies VerifiedStateSchemaIdentity;

/**
 * Version 54 keeps a label's colour in its Artifacts node (0.11, 03
 * Colours): `artifact_label_colours`, one row per (node, label) with a
 * colour, by name. A node from before the step has no rows: every label
 * draws uncoloured. Expand only.
 */
export const STATE_SCHEMA_V54_IDENTITY = {
  actualSchemaSha256:
    "d1d2f81a0ecd06cc8bdd70dad1e5906671fdb386a2ee2462cb5f0f77c01d260c",
} as const satisfies VerifiedStateSchemaIdentity;

/**
 * Version 55 keeps how the operator arranged Junto (0.11, 04): the hotbar
 * slots and their groups, each node's filters and open item, a collapsed
 * sidebar, a resized surface and a section's flag, one typed row per thing.
 * Machine-local. A canvas or node from before the step has no rows: every
 * surface opens at its default. Expand only.
 */
export const STATE_SCHEMA_V55_IDENTITY = {
  actualSchemaSha256:
    "31bc26cf1526c7ee14be85d01222b5ffb55abf7e2e5ebd6893104fb498d19340",
} as const satisfies VerifiedStateSchemaIdentity;

/**
 * Version 56 keeps where each automation was at each count the editing
 * machine sent (0.11, 05 S2): `automation_placements`, by Automations node
 * and automation id, judged as `canvas_placements` judges a seat. A canvas
 * from before the step has no rows: an automation's rows are judged from
 * the next copy sent. Expand only.
 */
export const STATE_SCHEMA_V56_IDENTITY = {
  actualSchemaSha256:
    "6e207db7a4cb7cba786ef105c061b9396e3a6f263d676b08f8ae390f9ccd4105",
} as const satisfies VerifiedStateSchemaIdentity;

/**
 * Version 57 keeps which canvases this machine runs code steps for (0.11, 05,
 * Code steps, check 4): `machine_code_allowances` and the ruling
 * installations each trusts. Machine-local and the owner's alone; no row
 * allows nothing, so a machine from before the step runs no code. Expand only.
 */
export const STATE_SCHEMA_V57_IDENTITY = {
  actualSchemaSha256:
    "909b6306076435d2b559725d165a4364739fdf1e84119c00b75e6c1b57134713",
} as const satisfies VerifiedStateSchemaIdentity;

/**
 * Version 58 records which peers link only through their link key (0.11, 05
 * S5): `machine_peers.binding`, `key` or NULL. Every peer from before the
 * step keeps NULL, the account's own SSH access, as before. Expand only.
 */
export const STATE_SCHEMA_V58_IDENTITY = {
  actualSchemaSha256:
    "2112a82b9345488b3832559461c62b04139e4dabc936a3b0c81c3a7c0c397985",
} as const satisfies VerifiedStateSchemaIdentity;

/**
 * Version 59 records every seat-control act at most once (0.11, 05 S4):
 * `seat_controls` keys a control by firing and action index, remembers its
 * outcome — applied, or one closed refusal — and when it settled, the count a
 * seat's machine enforces its per-seat bound from. Expand only.
 */
export const STATE_SCHEMA_V59_IDENTITY = {
  actualSchemaSha256:
    "f0f0259198e72c73cea1647593d037769dc9a8ea56e486cb5b27d78075cc8998",
} as const satisfies VerifiedStateSchemaIdentity;

/**
 * Version 60 lets an automation raise a signal for the operator (0.11, 07
 * N1): `agent_signals` rebuilt with `notice` and `work` in its kind CHECK,
 * every row copied as it was, and `source_json`, `work_json` and `form_json`
 * added beside it, empty on every signal already held. Approved by the
 * operator 2026-10-28. Consolidate.
 */
export const STATE_SCHEMA_V60_IDENTITY = {
  actualSchemaSha256:
    "0df7137242857b6e8666fc8a71a0bee4469d99fa8f92c8bbfd346aec48136b60",
} as const satisfies VerifiedStateSchemaIdentity;

/**
 * Version 61 holds each canvas's authority by quorum commit (0.11, 06 F6):
 * `canvas_consensus`, `canvas_authorities`, `canvas_log` with its
 * `canvas_log_members`, and `canvas_log_waiting`. Every canvas already held
 * starts at term 1 with nothing committed, its editor its one authority, so
 * nothing changes until the operator lists a fallback. Expand only.
 */
export const STATE_SCHEMA_V61_IDENTITY = {
  actualSchemaSha256:
    "8546fa8d9dfbbcdd57683671cf0ef0ef1e6097f3c4374112aaec771b1dbe9ca7",
} as const satisfies VerifiedStateSchemaIdentity;

/**
 * Version 62 keeps each vault token's scope record (0.11, 07 N5):
 * `machine_vault_tokens`, names only, the vault, its permissions and whether
 * Junto minted the token or the operator pasted it in. Machine-local; the
 * token is a file, never a row. Expand only.
 */
export const STATE_SCHEMA_V62_IDENTITY = {
  actualSchemaSha256:
    "6bd4211a71666d421e19a1ba0bf0eb4627ba9b736f556852803db7f6bbc2dfff",
} as const satisfies VerifiedStateSchemaIdentity;

/**
 * Version 63 lets a Files node cross as a stub (0.11, F1): `stubs` rebuilt
 * with `files` in its `stub_of` CHECK, every row copied as it was. A files
 * stub is its geometry and the operator's label, never a host, root, folder
 * name or file count. Consolidate.
 */
export const STATE_SCHEMA_V63_IDENTITY = {
  actualSchemaSha256:
    "83d7611b0b8a2869fa52b0743d91dbc0262de47196edecebf73e847c64ff3ad5",
} as const satisfies VerifiedStateSchemaIdentity;

/**
 * Version 64 keeps where each artifact has been (0.11.1, 10 M1):
 * `artifact_moves`, one row per move, for its history. Expand only.
 */
export const STATE_SCHEMA_V64_IDENTITY = {
  actualSchemaSha256:
    "f35438d5f24b1408aca9b2b657758f7bda4de42e1fd5100446d36d3ff95c2eab",
} as const satisfies VerifiedStateSchemaIdentity;

/**
 * Version 65 keeps quick capture's Inbox (0.11.2, 11 Q4):
 * `view_capture_inboxes`, one row per canvas. Expand only.
 */
export const STATE_SCHEMA_V65_IDENTITY = {
  actualSchemaSha256:
    "aefea4547b37028b6d112aa8fe56efa1d8024b9ea2347ea405f9b6e9e33e8850",
} as const satisfies VerifiedStateSchemaIdentity;

/**
 * Version 66 keeps the operator's read point in each mail thread (0.11.3):
 * `operator_mail_reads`, one row per thread of a canvas. Expand only.
 */
export const STATE_SCHEMA_V66_IDENTITY = {
  actualSchemaSha256:
    "964fd315da714095a3f049d96f87cfa5b7b622573d2304537dfe79eb2e5499fd",
} as const satisfies VerifiedStateSchemaIdentity;

/**
 * Version 67 keeps each structure entry's change beside the canvas log
 * (0.12, 06 F4): `canvas_log_structure` and, for an entry an alone fork
 * revoked, `canvas_log_waiting_structure`. Expand only.
 */
export const STATE_SCHEMA_V67_IDENTITY = {
  actualSchemaSha256:
    "6fef2c2b4e57055dc27e318650d4ec998fc90433f543c710fe89ad26ff675add",
} as const satisfies VerifiedStateSchemaIdentity;

/**
 * Version 68 lets a firing's row carry its revision across the exchange
 * (0.11, 05 S3): `automation_firings` gains `rev`, 0 on every firing already
 * held. Expand only.
 */
export const STATE_SCHEMA_V68_IDENTITY = {
  actualSchemaSha256:
    "00145a0d60bba343419cfd7fe369d07cce00d69fc2d6f11207da2cca732494c3",
} as const satisfies VerifiedStateSchemaIdentity;

/**
 * Version 69 keeps quick capture's desk (0.12, the Cmd+T triage desk):
 * `view_capture_desks`, one row per canvas, the draft not yet in an artifact
 * and where the operator was. Expand only.
 */
export const STATE_SCHEMA_V69_IDENTITY = {
  actualSchemaSha256:
    "e1196ee1e21ec6c5116d9227a30c9a38084b16a4b5d22bf38f7c80b61c99aee1",
} as const satisfies VerifiedStateSchemaIdentity;

/**
 * Version 70 indexes mail by its sender's stamp (0.12, msg list and since
 * off the whole canvas): `work_messages_sender`, so the mail one seat sent
 * is read from an index instead of a walk of every mail. Expand only.
 */
export const STATE_SCHEMA_V70_IDENTITY = {
  actualSchemaSha256:
    "dd84cfc7f7edfe690b0c25d5669ded74fe293a5afe10d24e44e3dacd132497d7",
} as const satisfies VerifiedStateSchemaIdentity;

/**
 * Version 71 keeps the newest installed copy's authority list (0.11/06 F3):
 * `canvas_copy_list` with its committed position and sender, and
 * `canvas_copy_list_members` beside it, so a copy's list can widen the voter
 * set without a copy certifying itself. Expand only.
 */
export const STATE_SCHEMA_V71_IDENTITY = {
  actualSchemaSha256:
    "d91a80e620f8657916aa81ffcd7c651c69d0448ea36e56a8b2ca81ad2b6f672f",
} as const satisfies VerifiedStateSchemaIdentity;

export const CURRENT_STATE_SCHEMA_VERSION = 71;

/**
 * Stable alias for the head identity so tests and tooling never rename an
 * import on a schema bump. `bun run schema:identity` rewrites the constant
 * above after any schema change.
 */
export const CURRENT_STATE_SCHEMA_IDENTITY: VerifiedStateSchemaIdentity =
  STATE_SCHEMA_V70_IDENTITY;

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
      database.exec(AUTOMATION_V28_STATE_SCHEMA_SQL);
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
      database.exec(STUBS_V30_STATE_SCHEMA_SQL);
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
  {
    fromVersion: 36,
    toVersion: 37,
    name: "keep the check runs on each task",
    safety: STATE_SCHEMA_CONSOLIDATE_SAFETY,
    fromIdentity: STATE_SCHEMA_V36_IDENTITY,
    replacesTables: ["task_heads"],
    migrate: (database) => migrateTaskChecks(database),
  },
  {
    fromVersion: 37,
    toVersion: 38,
    name: "keep the origins a seat ran code in",
    safety: STATE_SCHEMA_MIGRATION_SAFETY,
    fromIdentity: STATE_SCHEMA_V37_IDENTITY,
    migrate: (database) => {
      database.exec(BROWSER_TOUCHED_ORIGINS_V38_SQL);
    },
  },
  {
    fromVersion: 38,
    toVersion: 39,
    name: "delete the bulletin board and the requests node",
    safety: STATE_SCHEMA_CONSOLIDATE_SAFETY,
    fromIdentity: STATE_SCHEMA_V38_IDENTITY,
    removesTables: [...BOARD_REQUESTS_REMOVED_TABLES],
    replacesTables: [...BOARD_REQUESTS_REPLACED_TABLES],
    migrate: migrateBoardRequests,
  },
  {
    fromVersion: 39,
    toVersion: 40,
    name: "let a full touched-origin record admit an origin it holds",
    safety: STATE_SCHEMA_MIGRATION_SAFETY,
    fromIdentity: STATE_SCHEMA_V39_IDENTITY,
    // No row changes: the trigger only refused inserts; its replacement refuses fewer.
    replacesObjects: ["trigger:browser_touched_origins_limit"],
    migrate: (database) => {
      database.exec("DROP TRIGGER browser_touched_origins_limit");
      database.exec(BROWSER_TOUCHED_ORIGINS_LIMIT_V40_SQL);
    },
  },
  {
    fromVersion: 40,
    toVersion: 41,
    name: "remember the tasks a seat delete sent back to the backlog",
    safety: STATE_SCHEMA_MIGRATION_SAFETY,
    fromIdentity: STATE_SCHEMA_V40_IDENTITY,
    migrate: (database) => {
      database.exec(TASK_SEAT_RELEASES_SQL);
    },
  },
  {
    fromVersion: 41,
    toVersion: 42,
    name: "keep the page comments whose shot was purged",
    safety: STATE_SCHEMA_MIGRATION_SAFETY,
    fromIdentity: STATE_SCHEMA_V41_IDENTITY,
    migrate: (database) => {
      database.exec(SHOT_PURGES_SQL);
    },
  },
  {
    fromVersion: 42,
    toVersion: 43,
    name: "keep what each archived task was archived from",
    safety: STATE_SCHEMA_CONSOLIDATE_SAFETY,
    fromIdentity: STATE_SCHEMA_V42_IDENTITY,
    replacesTables: ["task_heads"],
    migrate: (database) => migrateTaskArchivedFrom(database),
  },
  {
    fromVersion: 43,
    toVersion: 44,
    name: "keep how far automations have read each canvas's task rulings",
    safety: STATE_SCHEMA_MIGRATION_SAFETY,
    fromIdentity: STATE_SCHEMA_V43_IDENTITY,
    migrate: (database) => {
      database.exec(AUTOMATION_RULING_CURSORS_SQL);
    },
  },
  {
    fromVersion: 44,
    toVersion: 45,
    name: "keep what each finish cited and the note it left",
    safety: STATE_SCHEMA_CONSOLIDATE_SAFETY,
    fromIdentity: STATE_SCHEMA_V44_IDENTITY,
    replacesTables: ["task_heads"],
    migrate: (database) => migrateTaskFinishNotes(database),
  },
  {
    fromVersion: 45,
    toVersion: 46,
    name: "keep where each seat, task, artifact and page is mentioned",
    safety: STATE_SCHEMA_MIGRATION_SAFETY,
    fromIdentity: STATE_SCHEMA_V45_IDENTITY,
    migrate: (database) => {
      database.exec(WORK_MENTIONS_SQL);
      rebuildMentions(database, MENTIONABLE_TABLES_V46);
    },
  },
  {
    fromVersion: 46,
    toVersion: 47,
    name: "give a signal's files an owner kind of their own",
    safety: STATE_SCHEMA_CONSOLIDATE_SAFETY,
    fromIdentity: STATE_SCHEMA_V46_IDENTITY,
    replacesTables: ["content_refs"],
    migrate: (database) => migrateSignalContentOwner(database),
  },
  {
    fromVersion: 47,
    toVersion: 48,
    name: "take the task and artifact ports out of every wire mask",
    safety: STATE_SCHEMA_CONSOLIDATE_SAFETY,
    fromIdentity: STATE_SCHEMA_V47_IDENTITY,
    replacesTables: [...TASK_ARTIFACT_PORTS_REPLACED_TABLES],
    migrate: migrateTaskArtifactPorts,
  },
  {
    fromVersion: 48,
    toVersion: 49,
    name: "let the operator name a page, a file or a link",
    safety: STATE_SCHEMA_MIGRATION_SAFETY,
    fromIdentity: STATE_SCHEMA_V48_IDENTITY,
    migrate: (database) => {
      for (const table of ["pages", "file_cards", "link_cards"]) {
        database.exec(`ALTER TABLE ${table} ADD COLUMN label TEXT`);
      }
    },
  },
  {
    fromVersion: 49,
    toVersion: 50,
    name: "let a task board derive into another",
    safety: STATE_SCHEMA_CONSOLIDATE_SAFETY,
    fromIdentity: STATE_SCHEMA_V49_IDENTITY,
    replacesTables: [...DERIVES_VERB_REPLACED_TABLES],
    migrate: migrateDerivesVerb,
  },
  {
    fromVersion: 50,
    toVersion: 51,
    name: "add the files node",
    safety: STATE_SCHEMA_MIGRATION_SAFETY,
    fromIdentity: STATE_SCHEMA_V50_IDENTITY,
    migrate: (database) => database.exec(FILE_TREES_STATE_SCHEMA_SQL),
  },
  {
    fromVersion: 51,
    toVersion: 52,
    name: "add the artifact body links",
    safety: STATE_SCHEMA_MIGRATION_SAFETY,
    fromIdentity: STATE_SCHEMA_V51_IDENTITY,
    migrate: (database) => database.exec(ARTIFACT_LINKS_STATE_SCHEMA_SQL),
  },
  {
    fromVersion: 52,
    toVersion: 53,
    name: "add the artifact labels",
    safety: STATE_SCHEMA_MIGRATION_SAFETY,
    fromIdentity: STATE_SCHEMA_V52_IDENTITY,
    migrate: (database) => database.exec(ARTIFACT_LABELS_STATE_SCHEMA_SQL),
  },
  {
    fromVersion: 53,
    toVersion: 54,
    name: "add the artifact label colours",
    safety: STATE_SCHEMA_MIGRATION_SAFETY,
    fromIdentity: STATE_SCHEMA_V53_IDENTITY,
    migrate: (database) => database.exec(ARTIFACT_LABEL_COLOURS_STATE_SCHEMA_SQL),
  },
  {
    fromVersion: 54,
    toVersion: 55,
    name: "keep the operator's view state",
    safety: STATE_SCHEMA_MIGRATION_SAFETY,
    fromIdentity: STATE_SCHEMA_V54_IDENTITY,
    migrate: (database) => database.exec(VIEW_STATE_SCHEMA_SQL),
  },
  {
    fromVersion: 55,
    toVersion: 56,
    name: "keep where each automation was",
    safety: STATE_SCHEMA_MIGRATION_SAFETY,
    fromIdentity: STATE_SCHEMA_V55_IDENTITY,
    migrate: (database) => database.exec(AUTOMATION_PLACEMENTS_STATE_SCHEMA_SQL),
  },
  {
    fromVersion: 56,
    toVersion: 57,
    name: "keep which canvases this machine runs code for",
    safety: STATE_SCHEMA_MIGRATION_SAFETY,
    fromIdentity: STATE_SCHEMA_V56_IDENTITY,
    migrate: (database) => database.exec(MACHINE_CODE_ALLOWANCES_SQL),
  },
  {
    fromVersion: 57,
    toVersion: 58,
    name: "bind a peer to its link key",
    safety: STATE_SCHEMA_MIGRATION_SAFETY,
    fromIdentity: STATE_SCHEMA_V57_IDENTITY,
    migrate: (database) => database.exec(`ALTER TABLE machine_peers ADD COLUMN ${MACHINE_PEER_BINDING_COLUMN_SQL}`),
  },
  {
    fromVersion: 58,
    toVersion: 59,
    name: "act on a seat control at most once",
    safety: STATE_SCHEMA_MIGRATION_SAFETY,
    fromIdentity: STATE_SCHEMA_V58_IDENTITY,
    migrate: (database) => database.exec(SEAT_CONTROLS_STATE_SCHEMA_SQL),
  },
  {
    fromVersion: 59,
    toVersion: 60,
    name: "let an automation raise a signal, with its form and its due time",
    safety: STATE_SCHEMA_CONSOLIDATE_SAFETY,
    fromIdentity: STATE_SCHEMA_V59_IDENTITY,
    replacesTables: [...SIGNAL_KINDS_REPLACED_TABLES],
    migrate: migrateSignalKinds,
  },
  {
    fromVersion: 60,
    toVersion: 61,
    name: "hold each canvas's authority by quorum commit",
    safety: STATE_SCHEMA_MIGRATION_SAFETY,
    fromIdentity: STATE_SCHEMA_V60_IDENTITY,
    migrate: (database) => {
      database.exec(FLEET_CONSENSUS_STATE_SCHEMA_SQL);
      database.exec(FLEET_CONSENSUS_SEED_SQL);
    },
  },
  {
    fromVersion: 61,
    toVersion: 62,
    name: "keep each vault token's scope record",
    safety: STATE_SCHEMA_MIGRATION_SAFETY,
    fromIdentity: STATE_SCHEMA_V61_IDENTITY,
    migrate: (database) => database.exec(MACHINE_VAULT_TOKENS_SQL),
  },
  {
    fromVersion: 62,
    toVersion: 63,
    name: "let a Files node cross as a stub",
    safety: STATE_SCHEMA_CONSOLIDATE_SAFETY,
    fromIdentity: STATE_SCHEMA_V62_IDENTITY,
    replacesTables: [...STUB_FILES_REPLACED_TABLES],
    migrate: migrateStubFiles,
  },
  {
    fromVersion: 63,
    toVersion: 64,
    name: "keep where each artifact has been",
    safety: STATE_SCHEMA_MIGRATION_SAFETY,
    fromIdentity: STATE_SCHEMA_V63_IDENTITY,
    migrate: (database) => database.exec(ARTIFACT_MOVES_STATE_SCHEMA_SQL),
  },
  {
    fromVersion: 64,
    toVersion: 65,
    name: "keep the capture Inbox",
    safety: STATE_SCHEMA_MIGRATION_SAFETY,
    fromIdentity: STATE_SCHEMA_V64_IDENTITY,
    migrate: (database) => database.exec(VIEW_CAPTURE_INBOX_SCHEMA_SQL),
  },
  {
    fromVersion: 65,
    toVersion: 66,
    name: "keep the operator's mail read points",
    safety: STATE_SCHEMA_MIGRATION_SAFETY,
    fromIdentity: STATE_SCHEMA_V65_IDENTITY,
    migrate: (database) => database.exec(OPERATOR_MAIL_READS_SCHEMA_SQL),
  },
  {
    fromVersion: 66,
    toVersion: 67,
    name: "keep each structure entry's change",
    safety: STATE_SCHEMA_MIGRATION_SAFETY,
    fromIdentity: STATE_SCHEMA_V66_IDENTITY,
    migrate: (database) => database.exec(FLEET_STRUCTURE_LOG_STATE_SCHEMA_SQL),
  },
  {
    fromVersion: 67,
    toVersion: 68,
    name: "keep a firing's revision",
    safety: STATE_SCHEMA_MIGRATION_SAFETY,
    fromIdentity: STATE_SCHEMA_V67_IDENTITY,
    migrate: (database) =>
      database.exec(`ALTER TABLE automation_firings ADD COLUMN ${AUTOMATION_FIRING_REV_COLUMN_SQL}`),
  },
  {
    fromVersion: 68,
    toVersion: 69,
    name: "keep quick capture's desk",
    safety: STATE_SCHEMA_MIGRATION_SAFETY,
    fromIdentity: STATE_SCHEMA_V68_IDENTITY,
    migrate: (database) => database.exec(VIEW_CAPTURE_DESK_SCHEMA_SQL),
  },
  {
    fromVersion: 69,
    toVersion: 70,
    name: "index mail by its sender",
    safety: STATE_SCHEMA_MIGRATION_SAFETY,
    fromIdentity: STATE_SCHEMA_V69_IDENTITY,
    migrate: (database) => database.exec(WORK_MESSAGES_SENDER_INDEX_SQL),
  },
  {
    fromVersion: 70,
    toVersion: 71,
    name: "keep the newest installed copy's authority list",
    safety: STATE_SCHEMA_MIGRATION_SAFETY,
    fromIdentity: STATE_SCHEMA_V70_IDENTITY,
    migrate: (database) => database.exec(FLEET_COPY_LIST_STATE_SCHEMA_SQL),
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
