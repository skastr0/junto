/**
 * The frozen version-1, version-2, and version-3 state schemas. Version 4
 * added squads (3 -> 4), so version 3 is the current composition without
 * that fragment. Version 3 added agent signals (2 -> 3), so version 2 is
 * version 3 without that fragment. Version 2 dropped the mail delivery ledger
 * (1 -> 2), so version 1 is version 2 plus that ledger's DDL, exactly as it
 * shipped. Tests build historical databases from these to prove each step.
 */
import { STATE_SCHEMA_FRAGMENTS } from "../../../src/main/junto/state/schema";
import { AGENT_SIGNALS_STATE_SCHEMA_SQL } from "../../../src/main/junto/signals/state-schema";
import { SQUADS_STATE_SCHEMA_SQL } from "../../../src/main/junto/squads/state-schema";
import { withoutProposalStorage } from "../../../src/main/junto/work/state-schema";

const composedWithout = (retired: ReadonlyArray<string>): string =>
  withoutProposalStorage(
    STATE_SCHEMA_FRAGMENTS.filter((fragment) => !retired.includes(fragment)).join("\n"),
  );

export const STATE_SCHEMA_V3_SQL = composedWithout([SQUADS_STATE_SCHEMA_SQL]);

export const STATE_SCHEMA_V2_SQL = composedWithout([
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
