import type { StateSchemaMigrationDatabase } from "./migrations";

/**
 * Review verdicts that are also task stamps (plan 04, stamps on the verdict
 * tables, ruling 1b). A verdict now names its reviewer's kind: a seat, as
 * before, or the operator, whose approval counts too. The operator has no
 * seat ids or node and only judges a task. A seat's verdict on a commit
 * carries its seat ids; a seat's stamp on a task is keyed by its node and
 * carries none (`task-stamps.ts`), while a crew verdict on a task from before
 * this step keeps the seat ids it was posted with. approve and changes are
 * written as green and blocking, so the one gate and its subject-hash binding
 * stay.
 *
 * `REVIEW_VERDICTS_SCHEMA_SQL` is the table with its indexes and trigger as
 * the crew schema declares it from this step on.
 */
const VERDICTS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS work_review_verdicts (
    verdict_id TEXT NOT NULL CHECK (length(verdict_id) BETWEEN 1 AND 256),
    kind TEXT NOT NULL CHECK (kind IN ('green', 'blocking')),
    reviewer_kind TEXT NOT NULL CHECK (reviewer_kind IN ('seat', 'operator')),
    reviewer_seat_id TEXT
      CHECK (
        reviewer_seat_id IS NULL
        OR (
          length(reviewer_seat_id) = 69
          AND substr(reviewer_seat_id, 1, 5) = 'seat_'
          AND substr(reviewer_seat_id, 6) NOT GLOB '*[^a-f0-9]*'
        )
      ),
    reviewer_node_id TEXT
      CHECK (reviewer_node_id IS NULL OR length(reviewer_node_id) BETWEEN 1 AND 256),
    author_seat_id TEXT
      CHECK (
        author_seat_id IS NULL
        OR (
          length(author_seat_id) = 69
          AND substr(author_seat_id, 1, 5) = 'seat_'
          AND substr(author_seat_id, 6) NOT GLOB '*[^a-f0-9]*'
        )
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
    CHECK ((reviewer_seat_id IS NULL) = (author_seat_id IS NULL)),
    CHECK (
      (
        reviewer_kind = 'operator'
        AND subject_kind = 'task'
        AND reviewer_seat_id IS NULL
        AND reviewer_node_id IS NULL
      )
      OR (reviewer_kind = 'seat' AND subject_kind = 'commit' AND reviewer_seat_id IS NOT NULL)
      OR (
        reviewer_kind = 'seat'
        AND subject_kind = 'task'
        AND (reviewer_node_id IS NOT NULL OR reviewer_seat_id IS NOT NULL)
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
`;

const VERDICTS_TRIGGER_SQL = `
  -- Canvas-revision invalidation: a task verdict changes what the seat's
  -- canvas projection reads, so bump work_canvas_revisions for its subject
  -- task's sink and the warm Canvases cache re-reads (a commit verdict has no
  -- canvas and does not fire).
  CREATE TRIGGER IF NOT EXISTS work_canvas_revision_review_verdicts_insert
    AFTER INSERT ON work_review_verdicts
    WHEN NEW.subject_kind = 'task'
    BEGIN
      INSERT INTO work_canvas_revisions(canvas_name, revision)
      VALUES (NEW.subject_task_canvas, 1)
      ON CONFLICT(canvas_name) DO UPDATE
        SET revision = work_canvas_revisions.revision + 1;
    END;
`;

export const REVIEW_VERDICTS_SCHEMA_SQL = VERDICTS_TABLE_SQL + VERDICTS_TRIGGER_SQL;

/** Every column the table keeps across the step; reviewer_kind is new. */
const KEPT_COLUMNS = [
  "verdict_id",
  "kind",
  "reviewer_seat_id",
  "reviewer_node_id",
  "author_seat_id",
  "subject_kind",
  "subject_task_installation",
  "subject_task_canvas",
  "subject_task_node",
  "subject_task_item",
  "subject_epoch",
  "subject_sha",
  "subject_checkout",
  "subject_hash",
  "epoch",
  "findings_json",
  "refs_json",
  "posted_at_ms",
].join(", ");

/**
 * Rebuild `work_review_verdicts` with a reviewer kind. Every stored verdict
 * was a seat's, and is copied as one.
 */
export const migrateReviewStamps = (database: StateSchemaMigrationDatabase): void => {
  database.exec(`
    CREATE TABLE work_review_verdicts_before_stamps AS SELECT ${KEPT_COLUMNS} FROM work_review_verdicts;
    DROP TABLE work_review_verdicts;
  `);
  database.exec(VERDICTS_TABLE_SQL);
  database.exec(`
    INSERT INTO work_review_verdicts (reviewer_kind, ${KEPT_COLUMNS})
      SELECT 'seat', ${KEPT_COLUMNS} FROM work_review_verdicts_before_stamps;
    DROP TABLE work_review_verdicts_before_stamps;
  `);
  // After the copy, so copying bumps no canvas revision.
  database.exec(VERDICTS_TRIGGER_SQL);
};
