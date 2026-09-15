/**
 * Durable schema for the crew mail/review additions (state version 24).
 *
 * Two additive tables, created identically on a fresh install (via
 * `STATE_SCHEMA_FRAGMENTS`) and on the 23 -> 24 upgrade (via the migration).
 * Neither touches an existing table: `work_messages`, `work_delivery_receipts`
 * and every prior definition and row survive unchanged.
 *
 *  - `work_mail_attempts`: one row per (message, recipient seat, recipient
 *    generation). Transport truth with independent, set-once fact timestamps
 *    (`queued_at`, `notified_at`, `unresolved_at`, `refused_at`) plus a refusal
 *    reason and physical write evidence. A later refusal never clears a prior
 *    `unresolved_at`, so an accepted-then-failed write stays visible.
 *  - `work_review_verdicts`: immutable, seat-stamped, epoch-bound green/blocking
 *    verdicts on a task or commit subject. The primary key is the deterministic
 *    verdict id, so a re-post at the same (subject, reviewer, epoch) conflicts
 *    and is refused rather than mutating a recorded judgement.
 *
 * `recipient_generation` is an opaque seat terminal generation; `epoch` /
 * `subject_epoch` are task epochs. They are separate columns and never mixed.
 */
export const CREW_STATE_SCHEMA_SQL = `
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

  CREATE TABLE IF NOT EXISTS work_review_verdicts (
    verdict_id TEXT NOT NULL CHECK (length(verdict_id) BETWEEN 1 AND 256),
    kind TEXT NOT NULL CHECK (kind IN ('green', 'blocking')),
    reviewer_seat_id TEXT NOT NULL
      CHECK (
        length(reviewer_seat_id) = 69
        AND substr(reviewer_seat_id, 1, 5) = 'seat_'
        AND substr(reviewer_seat_id, 6) NOT GLOB '*[^a-f0-9]*'
      ),
    reviewer_node_id TEXT
      CHECK (reviewer_node_id IS NULL OR length(reviewer_node_id) BETWEEN 1 AND 256),
    author_seat_id TEXT NOT NULL
      CHECK (
        length(author_seat_id) = 69
        AND substr(author_seat_id, 1, 5) = 'seat_'
        AND substr(author_seat_id, 6) NOT GLOB '*[^a-f0-9]*'
      ),
    subject_kind TEXT NOT NULL CHECK (subject_kind IN ('task', 'commit')),
    subject_task_installation TEXT
      CHECK (subject_task_installation IS NULL OR length(subject_task_installation) BETWEEN 1 AND 256),
    subject_task_canvas TEXT
      CHECK (subject_task_canvas IS NULL OR length(subject_task_canvas) BETWEEN 1 AND 256),
    subject_task_node TEXT
      CHECK (subject_task_node IS NULL OR length(subject_task_node) BETWEEN 1 AND 256),
    subject_task_item TEXT
      CHECK (subject_task_item IS NULL OR length(subject_task_item) BETWEEN 1 AND 256),
    subject_epoch INTEGER
      CHECK (subject_epoch IS NULL OR subject_epoch >= 0),
    subject_sha TEXT
      CHECK (subject_sha IS NULL OR length(subject_sha) BETWEEN 1 AND 256),
    subject_checkout TEXT
      CHECK (subject_checkout IS NULL OR length(subject_checkout) BETWEEN 1 AND 256),
    subject_hash TEXT NOT NULL CHECK (length(subject_hash) BETWEEN 1 AND 256),
    epoch INTEGER NOT NULL CHECK (epoch >= 0),
    findings_json TEXT NOT NULL CHECK (json_valid(findings_json)),
    refs_json TEXT NOT NULL CHECK (json_valid(refs_json)),
    posted_at_ms INTEGER NOT NULL CHECK (posted_at_ms >= 0),
    CHECK (
      (
        subject_kind = 'task'
        AND subject_task_installation IS NOT NULL
        AND subject_task_canvas IS NOT NULL
        AND subject_task_node IS NOT NULL
        AND subject_task_item IS NOT NULL
        AND subject_epoch IS NOT NULL
        AND subject_sha IS NULL
        AND subject_checkout IS NULL
      )
      OR (
        subject_kind = 'commit'
        AND subject_sha IS NOT NULL
        AND subject_task_installation IS NULL
        AND subject_task_canvas IS NULL
        AND subject_task_node IS NULL
        AND subject_task_item IS NULL
        AND subject_epoch IS NULL
      )
    ),
    PRIMARY KEY (verdict_id)
  ) STRICT, WITHOUT ROWID;

  CREATE INDEX IF NOT EXISTS work_review_verdicts_gate
    ON work_review_verdicts (subject_hash, epoch, kind);

  CREATE INDEX IF NOT EXISTS work_review_verdicts_task
    ON work_review_verdicts (subject_task_canvas, subject_task_node, subject_task_item);

  CREATE INDEX IF NOT EXISTS work_review_verdicts_commit
    ON work_review_verdicts (subject_kind, subject_sha);

  CREATE TABLE IF NOT EXISTS work_review_receipts (
    canvas_name TEXT NOT NULL CHECK (length(canvas_name) BETWEEN 1 AND 256),
    source_kind TEXT NOT NULL CHECK (source_kind IN ('task-fact', 'checkout')),
    source_id TEXT NOT NULL CHECK (length(source_id) BETWEEN 1 AND 512),
    ref_sha TEXT NOT NULL CHECK (length(ref_sha) BETWEEN 1 AND 256),
    reviewer_seat_id TEXT NOT NULL
      CHECK (
        length(reviewer_seat_id) = 69
        AND substr(reviewer_seat_id, 1, 5) = 'seat_'
        AND substr(reviewer_seat_id, 6) NOT GLOB '*[^a-f0-9]*'
      ),
    task_id TEXT CHECK (task_id IS NULL OR length(task_id) BETWEEN 1 AND 256),
    author_seat_id TEXT NOT NULL
      CHECK (
        length(author_seat_id) = 69
        AND substr(author_seat_id, 1, 5) = 'seat_'
        AND substr(author_seat_id, 6) NOT GLOB '*[^a-f0-9]*'
      ),
    message_id TEXT CHECK (message_id IS NULL OR length(message_id) BETWEEN 1 AND 256),
    created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 1 AND 64),
    PRIMARY KEY (canvas_name, source_kind, source_id, ref_sha, reviewer_seat_id)
  ) STRICT, WITHOUT ROWID;

  CREATE INDEX IF NOT EXISTS work_review_receipts_sha
    ON work_review_receipts (ref_sha);

  CREATE TABLE IF NOT EXISTS work_review_checkout_observations (
    checkout_key TEXT NOT NULL CHECK (length(checkout_key) BETWEEN 1 AND 512),
    sha TEXT NOT NULL CHECK (length(sha) BETWEEN 1 AND 256),
    seat_id TEXT
      CHECK (
        seat_id IS NULL
        OR (
          length(seat_id) = 69
          AND substr(seat_id, 1, 5) = 'seat_'
          AND substr(seat_id, 6) NOT GLOB '*[^a-f0-9]*'
        )
      ),
    task_id TEXT CHECK (task_id IS NULL OR length(task_id) BETWEEN 1 AND 256),
    attributed_via TEXT
      CHECK (attributed_via IS NULL OR attributed_via IN ('claim-context', 'update-context')),
    observed_at TEXT NOT NULL CHECK (length(observed_at) BETWEEN 1 AND 64),
    PRIMARY KEY (checkout_key, sha)
  ) STRICT, WITHOUT ROWID;
`;
