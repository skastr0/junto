/**
 * Tasks (plan 04): one head row per task holding its current layer, one
 * immutable row per closed layer, the canvas's next task number, and the
 * local ruler's rulings on task commands.
 *
 * - `task_heads` is what list and the ruler read: the task as it stands, on
 *   the node it sits on now. Keyed by canvas and task id (a ULID); the number
 *   is unique per canvas and never reused.
 * - `task_layers` keeps every layer a task closed by being sent on, in order,
 *   as the layer stood when it closed.
 * - `task_numbers` is the next number the ruler mints on a canvas.
 * - `task_rulings` answers a retried command (same writer, same opId) with
 *   its first ruling, until the shared ruling store of plan 02 lands.
 *
 * Reviewers, stamps and dependencies are JSON on the head while their home is
 * decided (stamps on the verdict tables, 04).
 */
export const TASKS_STATE_SCHEMA_SQL = `
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
    stamps_json TEXT NOT NULL CHECK (json_valid(stamps_json)),
    depends_on_json TEXT NOT NULL CHECK (json_valid(depends_on_json)),
    next_node_id TEXT CHECK (next_node_id IS NULL OR length(next_node_id) BETWEEN 1 AND 256),
    updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
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

  CREATE TABLE IF NOT EXISTS task_layers (
    canvas_name TEXT NOT NULL,
    task_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    node_id TEXT NOT NULL CHECK (length(node_id) BETWEEN 1 AND 256),
    layer_json TEXT NOT NULL CHECK (json_valid(layer_json)),
    closed_at INTEGER NOT NULL CHECK (closed_at >= 0),
    PRIMARY KEY (canvas_name, task_id, ordinal),
    FOREIGN KEY (canvas_name, task_id)
      REFERENCES task_heads (canvas_name, task_id)
      ON DELETE CASCADE
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS task_numbers (
    canvas_name TEXT NOT NULL PRIMARY KEY CHECK (length(canvas_name) BETWEEN 1 AND 256),
    next_number INTEGER NOT NULL CHECK (next_number >= 1)
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS task_rulings (
    canvas_name TEXT NOT NULL CHECK (length(canvas_name) BETWEEN 1 AND 256),
    writer TEXT NOT NULL CHECK (length(writer) BETWEEN 1 AND 256),
    op_id TEXT NOT NULL CHECK (length(op_id) = 26),
    ruling_json TEXT NOT NULL CHECK (json_valid(ruling_json)),
    at INTEGER NOT NULL CHECK (at >= 0),
    PRIMARY KEY (canvas_name, writer, op_id)
  ) STRICT, WITHOUT ROWID;
`;
