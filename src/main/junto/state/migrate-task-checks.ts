import type { StateSchemaMigrationDatabase } from "./migrations";

/**
 * Check runs on a task's current layer (plan 04, task check): `task_heads`
 * rebuilt with `checks_json`. No task holds a run yet, so each starts with
 * none.
 */

/** `task_heads` and its indexes as this step creates them. Frozen. */
export const TASK_HEADS_CHECKS_SQL = `
  CREATE TABLE IF NOT EXISTS task_heads (
    canvas_name TEXT NOT NULL CHECK (length(canvas_name) BETWEEN 1 AND 256),
    task_id TEXT NOT NULL CHECK (length(task_id) = 26),
    number INTEGER NOT NULL CHECK (number >= 1),
    node_id TEXT NOT NULL CHECK (length(node_id) BETWEEN 1 AND 256),
    title TEXT NOT NULL CHECK (length(title) >= 1),
    body TEXT,
    state TEXT NOT NULL
      CHECK (state IN ('backlog', 'assigned', 'working', 'input-required', 'in-review', 'done', 'canceled', 'archived')),
    assignee_node_id TEXT CHECK (assignee_node_id IS NULL OR length(assignee_node_id) BETWEEN 1 AND 256),
    epoch INTEGER NOT NULL CHECK (epoch >= 0),
    stamps_required INTEGER NOT NULL CHECK (stamps_required >= 0),
    reviewers_json TEXT NOT NULL CHECK (json_valid(reviewers_json)),
    checks_json TEXT NOT NULL CHECK (json_valid(checks_json)),
    depends_on_json TEXT NOT NULL CHECK (json_valid(depends_on_json)),
    next_node_id TEXT CHECK (next_node_id IS NULL OR length(next_node_id) BETWEEN 1 AND 256),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
    state_since INTEGER NOT NULL CHECK (state_since BETWEEN created_at AND updated_at),
    PRIMARY KEY (canvas_name, task_id),
    UNIQUE (canvas_name, number),
    CHECK ((state IN ('assigned', 'working', 'input-required', 'in-review')) = (assignee_node_id IS NOT NULL)
      OR state IN ('done', 'canceled', 'archived')),
    CHECK (next_node_id IS NULL OR state = 'in-review')
  ) STRICT, WITHOUT ROWID;

  CREATE INDEX IF NOT EXISTS task_heads_by_node
    ON task_heads (canvas_name, node_id, updated_at DESC);

  CREATE INDEX IF NOT EXISTS task_heads_by_assignee
    ON task_heads (canvas_name, assignee_node_id)
    WHERE assignee_node_id IS NOT NULL;
`;

const KEPT_COLUMNS = "canvas_name, task_id, number, node_id, title, body, state, assignee_node_id, epoch, stamps_required, reviewers_json, depends_on_json, next_node_id, created_at, updated_at, state_since";

export const migrateTaskChecks = (database: StateSchemaMigrationDatabase): void => {
  database.exec(`
    CREATE TABLE task_heads_before_checks AS SELECT ${KEPT_COLUMNS} FROM task_heads;
    DROP TABLE task_heads;
  `);
  database.exec(TASK_HEADS_CHECKS_SQL);
  database.exec(`
    INSERT INTO task_heads (${KEPT_COLUMNS}, checks_json)
      SELECT ${KEPT_COLUMNS}, '[]' FROM task_heads_before_checks;
    DROP TABLE task_heads_before_checks;
  `);
};
