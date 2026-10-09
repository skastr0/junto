/**
 * The frozen state schemas, version 1 through version 16, built only from
 * frozen text and frozen steps so no later schema change can move a
 * historical witness.
 * Version 14 is its frozen fragments. Each earlier version is the next one
 * with that step undone: a later fragment left out, the mail trigger of
 * version 13 put back, the canvas and work tables of version 12 put back, and
 * for version 1 the mail delivery ledger put back. Tests build historical
 * databases from these to prove each step.
 */
import {
  PROPOSAL_STORAGE_V14_TEXTS,
  STATE_SCHEMA_V14_FRAGMENTS,
} from "./v14-fragments";
import { WORK_STATE_SCHEMA_HEAD_BASIS_SQL } from "./work-head-schema";
import { DatabaseSync } from "node:sqlite";
import { migrateOneMachineLog } from "../../../src/main/junto/work/migrate-one-machine-log";
import { WORK_EXCHANGE_STATE_SCHEMA_SQL } from "../../../src/main/junto/work/exchange/state-schema";
import { CANVAS_AUTHORITY_SCHEMA_SQL } from "./canvas-schema";
import { ENTITIES_STATE_SCHEMA_SQL } from "../domain-cutover/entities-schema";

const {
  model: MODEL_STATE_SCHEMA_SQL,
  work: WORK_STATE_SCHEMA_CANVAS_BASIS_SQL,
  signals: AGENT_SIGNALS_STATE_SCHEMA_SQL,
  squads: SQUADS_STATE_SCHEMA_SQL,
  portraits: PORTRAIT_OVERRIDES_STATE_SCHEMA_SQL,
  companion: COMPANION_DEVICES_STATE_SCHEMA_SQL,
  seatGuidance: SEAT_GUIDANCE_STATE_SCHEMA_SQL,
  profiles: AGENT_PROFILES_STATE_SCHEMA_SQL,
  seatSessions: SEAT_SESSIONS_STATE_SCHEMA_SQL,
  signalAttachments: AGENT_SIGNAL_ATTACHMENTS_STATE_SCHEMA_SQL,
  seatSessionDrains: SEAT_SESSION_DRAINS_STATE_SCHEMA_SQL,
  signalParts: AGENT_SIGNAL_PARTS_STATE_SCHEMA_SQL,
  appTexts: APP_TEXTS_STATE_SCHEMA_SQL,
} = STATE_SCHEMA_V14_FRAGMENTS;

const STATE_SCHEMA_FRAGMENTS: ReadonlyArray<string> = Object.values(STATE_SCHEMA_V14_FRAGMENTS);

/** Every composition leaves the proposal storage out, by exact text. */
const withoutProposalStorage = (sql: string): string => {
  let corrected = sql;
  for (const text of PROPOSAL_STORAGE_V14_TEXTS) {
    if (!corrected.includes(text)) throw new Error("frozen schema composition lost a proposal storage text");
    corrected = corrected.replace(text, "");
  }
  return corrected;
};

export const STATE_SCHEMA_V14_SQL = withoutProposalStorage(STATE_SCHEMA_FRAGMENTS.join("\n"));

/**
 * A later version is the earlier one with that step's own migration run on
 * it. A step never follows the head, so the result is frozen with the step.
 */
const stepped = (
  sql: string,
  migrate: (database: DatabaseSync) => void,
): string => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec("PRAGMA foreign_keys = OFF");
    database.exec(sql);
    migrate(database);
    return (
      database
        .prepare("SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*' ORDER BY rowid")
        .all()
        .map((row) => `${String(row.sql)};`)
        .join("\n")
    );
  } finally {
    database.close();
  }
};

// Version 15 dropped the tables that carried tasks between machines (14 -> 15).
export const STATE_SCHEMA_V15_SQL = stepped(STATE_SCHEMA_V14_SQL, migrateOneMachineLog);

// Version 16 added the row exchange cursors (15 -> 16).
export const STATE_SCHEMA_V16_SQL = stepped(STATE_SCHEMA_V15_SQL, (database) => {
  database.exec(WORK_EXCHANGE_STATE_SCHEMA_SQL);
});

// Version 14 dropped this trigger (13 -> 14), so version 13 is version 14 with it.
const MAIL_HOME_TRIGGER_V13_SQL = `
  CREATE TRIGGER IF NOT EXISTS work_messages_require_cc_home
  BEFORE INSERT ON work_messages
  WHEN
    NOT EXISTS (
      SELECT 1
      FROM station_configuration AS configuration
      JOIN station_installation AS installation
        ON installation.singleton = configuration.singleton
      WHERE configuration.singleton = 1
        AND configuration.role = 'command-center'
        AND NEW.entity_home = installation.installation_id
    )
  BEGIN
    SELECT RAISE(
      ABORT,
      'work mailbox messages must be Command Center-homed'
    );
  END;
`;
export const STATE_SCHEMA_V13_SQL = `${STATE_SCHEMA_V14_SQL}\n${MAIL_HOME_TRIGGER_V13_SQL}`;

// Version 13 replaced the canvas tables and the work fact basis (12 -> 13), so
// version 12 is version 13 with the earlier canvas, entity and work DDL.
const LEGACY_STATE_SCHEMA_FRAGMENTS = [
  ...STATE_SCHEMA_FRAGMENTS.map((fragment) => fragment === MODEL_STATE_SCHEMA_SQL
    ? CANVAS_AUTHORITY_SCHEMA_SQL : fragment === WORK_STATE_SCHEMA_CANVAS_BASIS_SQL
    ? WORK_STATE_SCHEMA_HEAD_BASIS_SQL : fragment),
  ENTITIES_STATE_SCHEMA_SQL,
];
export const STATE_SCHEMA_V12_SQL = withoutProposalStorage(LEGACY_STATE_SCHEMA_FRAGMENTS.join("\n"));

const composedWithout = (retired: ReadonlyArray<string>): string =>
  withoutProposalStorage(
    LEGACY_STATE_SCHEMA_FRAGMENTS.filter((fragment) => !retired.includes(fragment)).join("\n"),
  );

// Version 12 added app texts (11 -> 12), so version 11 is version 12 without it.
const V12_FRAGMENTS = [APP_TEXTS_STATE_SCHEMA_SQL];

export const STATE_SCHEMA_V11_SQL = composedWithout(V12_FRAGMENTS);

const V11_FRAGMENTS = [...V12_FRAGMENTS, AGENT_SIGNAL_PARTS_STATE_SCHEMA_SQL];

export const STATE_SCHEMA_V10_SQL = composedWithout(V11_FRAGMENTS);

const V10_FRAGMENTS = [...V11_FRAGMENTS, SEAT_SESSION_DRAINS_STATE_SCHEMA_SQL];

export const STATE_SCHEMA_V9_SQL = composedWithout(V10_FRAGMENTS);

const V9_FRAGMENTS = [...V10_FRAGMENTS, AGENT_SIGNAL_ATTACHMENTS_STATE_SCHEMA_SQL];

export const STATE_SCHEMA_V8_SQL = composedWithout(V9_FRAGMENTS);

const V8_FRAGMENTS = [...V9_FRAGMENTS, SEAT_SESSIONS_STATE_SCHEMA_SQL];

export const STATE_SCHEMA_V7_SQL = composedWithout(V8_FRAGMENTS);

const V7_FRAGMENTS = [...V8_FRAGMENTS, SEAT_GUIDANCE_STATE_SCHEMA_SQL, AGENT_PROFILES_STATE_SCHEMA_SQL];

export const STATE_SCHEMA_V6_SQL = composedWithout(V7_FRAGMENTS);

export const STATE_SCHEMA_V5_SQL = composedWithout([...V7_FRAGMENTS, COMPANION_DEVICES_STATE_SCHEMA_SQL]);

export const STATE_SCHEMA_V4_SQL = composedWithout([
  ...V7_FRAGMENTS,
  COMPANION_DEVICES_STATE_SCHEMA_SQL,
  PORTRAIT_OVERRIDES_STATE_SCHEMA_SQL,
]);

export const STATE_SCHEMA_V3_SQL = composedWithout([
  ...V7_FRAGMENTS,
  COMPANION_DEVICES_STATE_SCHEMA_SQL,
  PORTRAIT_OVERRIDES_STATE_SCHEMA_SQL,
  SQUADS_STATE_SCHEMA_SQL,
]);

export const STATE_SCHEMA_V2_SQL = composedWithout([
  ...V7_FRAGMENTS,
  COMPANION_DEVICES_STATE_SCHEMA_SQL,
  PORTRAIT_OVERRIDES_STATE_SCHEMA_SQL,
  SQUADS_STATE_SCHEMA_SQL,
  AGENT_SIGNALS_STATE_SCHEMA_SQL,
]);

const MAIL_LEDGER_V1_SQL = `
  CREATE TABLE IF NOT EXISTS work_mail_attempts (
    canvas_name TEXT NOT NULL CHECK (length(canvas_name) BETWEEN 1 AND 256),
    node_id TEXT NOT NULL CHECK (length(node_id) BETWEEN 1 AND 256),
    message_id TEXT NOT NULL CHECK (length(message_id) BETWEEN 1 AND 256),
    recipient_seat_id TEXT NOT NULL
      CHECK (
        length(recipient_seat_id) = 69
        AND substr(recipient_seat_id, 1, 5) = 'seat_'
        AND substr(recipient_seat_id, 6) NOT GLOB '*[^a-f0-9]*'
      ),
    recipient_generation TEXT NOT NULL
      CHECK (length(recipient_generation) BETWEEN 1 AND 256),
    policy TEXT NOT NULL CHECK (policy IN ('notice', 'immediate')),
    batch_id TEXT CHECK (batch_id IS NULL OR length(batch_id) BETWEEN 1 AND 256),
    queued_at TEXT NOT NULL CHECK (length(queued_at) BETWEEN 1 AND 64),
    attempted_at TEXT
      CHECK (attempted_at IS NULL OR length(attempted_at) BETWEEN 1 AND 64),
    notified_at TEXT
      CHECK (notified_at IS NULL OR length(notified_at) BETWEEN 1 AND 64),
    unresolved_at TEXT
      CHECK (unresolved_at IS NULL OR length(unresolved_at) BETWEEN 1 AND 64),
    refused_at TEXT
      CHECK (refused_at IS NULL OR length(refused_at) BETWEEN 1 AND 64),
    refused_reason TEXT
      CHECK (
        refused_reason IS NULL
        OR refused_reason IN (
          'seat-busy',
          'composer-draft',
          'composer-unreadable',
          'operator-interlock',
          'not-idle',
          'not-settled',
          'paused',
          'no-lease',
          'seat-gone',
          'oversize',
          'written-no-evidence'
        )
      ),
    -- Open/close intent versioning, separate from the monotonic outcome facts.
    -- Each physical attempt opens (attempt_seq += 1); its outcome closes
    -- (resolved_seq = attempt_seq). Recovery reopens any attempt_seq >
    -- resolved_seq as unresolved WITHOUT clearing a prior refused_at, so a
    -- retry after a refusal that crashes is never lost as terminal.
    attempt_seq INTEGER NOT NULL DEFAULT 0 CHECK (attempt_seq >= 0),
    resolved_seq INTEGER NOT NULL DEFAULT 0 CHECK (resolved_seq >= 0),
    writes_before INTEGER
      CHECK (writes_before IS NULL OR writes_before >= 0),
    writes_after INTEGER
      CHECK (writes_after IS NULL OR writes_after >= 0),
    write_at TEXT
      CHECK (write_at IS NULL OR length(write_at) BETWEEN 1 AND 64),
    updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 1 AND 64),
    PRIMARY KEY (
      canvas_name,
      node_id,
      message_id,
      recipient_seat_id,
      recipient_generation
    )
  ) STRICT, WITHOUT ROWID;

  CREATE INDEX IF NOT EXISTS work_mail_attempts_message
    ON work_mail_attempts (canvas_name, node_id, message_id);

  -- Durable notice fallback: a prompt-kind row is explicit-only until an
  -- authorizing deferral (a failed explicit prompt attempt) persists this
  -- marker, which re-admits the row to the ordinary notice path. Seat-scoped
  -- (no generation): the operator's intent follows the message until it is
  -- notified, and the notified check still suppresses every re-paste.
  CREATE TABLE IF NOT EXISTS work_mail_notice_fallback (
    canvas_name TEXT NOT NULL CHECK (length(canvas_name) BETWEEN 1 AND 256),
    node_id TEXT NOT NULL CHECK (length(node_id) BETWEEN 1 AND 256),
    message_id TEXT NOT NULL CHECK (length(message_id) BETWEEN 1 AND 256),
    recipient_seat_id TEXT NOT NULL
      CHECK (
        length(recipient_seat_id) = 69
        AND substr(recipient_seat_id, 1, 5) = 'seat_'
        AND substr(recipient_seat_id, 6) NOT GLOB '*[^a-f0-9]*'
      ),
    reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 64),
    granted_at TEXT NOT NULL CHECK (length(granted_at) BETWEEN 1 AND 64),
    updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 1 AND 64),
    PRIMARY KEY (
      canvas_name,
      node_id,
      message_id,
      recipient_seat_id
    )
  ) STRICT, WITHOUT ROWID;

  CREATE TRIGGER IF NOT EXISTS work_canvas_revision_mail_attempts_insert
    AFTER INSERT ON work_mail_attempts
    BEGIN
      INSERT INTO work_canvas_revisions(canvas_name, revision)
      VALUES (NEW.canvas_name, 1)
      ON CONFLICT(canvas_name) DO UPDATE
        SET revision = work_canvas_revisions.revision + 1;
    END;

  CREATE TRIGGER IF NOT EXISTS work_canvas_revision_mail_attempts_update
    AFTER UPDATE ON work_mail_attempts
    BEGIN
      INSERT INTO work_canvas_revisions(canvas_name, revision)
      VALUES (NEW.canvas_name, 1)
      ON CONFLICT(canvas_name) DO UPDATE
        SET revision = work_canvas_revisions.revision + 1;
    END;
`;

export const STATE_SCHEMA_V1_SQL = `${STATE_SCHEMA_V2_SQL}\n${MAIL_LEDGER_V1_SQL}`;
