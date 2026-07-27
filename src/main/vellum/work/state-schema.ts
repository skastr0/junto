/**
 * Durable work-plane schema.
 *
 * This module is deliberately SQL-only so the StateEngine bootstrap can
 * compose it without importing WorkService, repository adapters, or the
 * authorial canvas model.
 */
export const WORK_STATE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS work_home_sequences (
    home_station TEXT PRIMARY KEY CHECK (length(home_station) > 0),
    last_seq TEXT NOT NULL
      CHECK (
        length(last_seq) > 0
        AND last_seq NOT GLOB '*[^0-9]*'
        AND (last_seq = '0' OR substr(last_seq, 1, 1) <> '0')
      )
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS work_events (
    home_station TEXT NOT NULL CHECK (length(home_station) > 0),
    seq TEXT NOT NULL
      CHECK (
        length(seq) > 0
        AND seq NOT GLOB '*[^0-9]*'
        AND (seq = '0' OR substr(seq, 1, 1) <> '0')
      ),
    canvas_name TEXT NOT NULL CHECK (length(canvas_name) > 0),
    node_id TEXT NOT NULL CHECK (length(node_id) > 0),
    entity_kind TEXT NOT NULL
      CHECK (entity_kind IN ('task', 'request', 'message', 'artifact')),
    entity_id TEXT NOT NULL CHECK (length(entity_id) > 0),
    operation TEXT NOT NULL CHECK (length(operation) > 0),
    origin_at TEXT NOT NULL CHECK (length(origin_at) > 0),
    received_at TEXT NOT NULL CHECK (length(received_at) > 0),
    payload_json TEXT NOT NULL CHECK (length(payload_json) > 0),
    content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
    PRIMARY KEY (home_station, seq),
    FOREIGN KEY (home_station)
      REFERENCES work_home_sequences(home_station) ON DELETE RESTRICT
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS work_tasks (
    canvas_name TEXT NOT NULL CHECK (length(canvas_name) > 0),
    node_id TEXT NOT NULL CHECK (length(node_id) > 0),
    task_id TEXT NOT NULL CHECK (length(task_id) > 0),
    home_station TEXT NOT NULL CHECK (length(home_station) > 0),
    seq TEXT NOT NULL
      CHECK (
        length(seq) > 0
        AND seq NOT GLOB '*[^0-9]*'
        AND (seq = '0' OR substr(seq, 1, 1) <> '0')
      ),
    state TEXT NOT NULL
      CHECK (
        state IN (
          'submitted',
          'working',
          'input-required',
          'completed',
          'canceled',
          'failed',
          'rejected',
          'auth-required'
        )
      ),
    brief_message_id TEXT NOT NULL CHECK (length(brief_message_id) > 0),
    artifact_ids_json TEXT,
    metadata_json TEXT,
    reason TEXT,
    response TEXT,
    created_at TEXT NOT NULL CHECK (length(created_at) > 0),
    updated_at TEXT NOT NULL CHECK (length(updated_at) > 0),
    origin_at TEXT NOT NULL CHECK (length(origin_at) > 0),
    received_at TEXT NOT NULL CHECK (length(received_at) > 0),
    PRIMARY KEY (canvas_name, node_id, task_id),
    UNIQUE (home_station, seq),
    FOREIGN KEY (home_station, seq)
      REFERENCES work_events(home_station, seq) ON DELETE RESTRICT
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS work_requests (
    canvas_name TEXT NOT NULL CHECK (length(canvas_name) > 0),
    node_id TEXT NOT NULL CHECK (length(node_id) > 0),
    task_id TEXT NOT NULL CHECK (length(task_id) > 0),
    home_station TEXT NOT NULL CHECK (length(home_station) > 0),
    seq TEXT NOT NULL
      CHECK (
        length(seq) > 0
        AND seq NOT GLOB '*[^0-9]*'
        AND (seq = '0' OR substr(seq, 1, 1) <> '0')
      ),
    state TEXT NOT NULL
      CHECK (
        state IN (
          'submitted',
          'working',
          'input-required',
          'completed',
          'canceled',
          'failed',
          'rejected',
          'auth-required'
        )
      ),
    brief_message_id TEXT NOT NULL CHECK (length(brief_message_id) > 0),
    artifact_ids_json TEXT,
    metadata_json TEXT,
    reason TEXT,
    response TEXT,
    created_at TEXT NOT NULL CHECK (length(created_at) > 0),
    updated_at TEXT NOT NULL CHECK (length(updated_at) > 0),
    origin_at TEXT NOT NULL CHECK (length(origin_at) > 0),
    received_at TEXT NOT NULL CHECK (length(received_at) > 0),
    PRIMARY KEY (canvas_name, node_id, task_id),
    UNIQUE (home_station, seq),
    FOREIGN KEY (home_station, seq)
      REFERENCES work_events(home_station, seq) ON DELETE RESTRICT
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS work_messages (
    canvas_name TEXT NOT NULL CHECK (length(canvas_name) > 0),
    node_id TEXT NOT NULL CHECK (length(node_id) > 0),
    message_id TEXT NOT NULL CHECK (length(message_id) > 0),
    parent_lane TEXT
      CHECK (parent_lane IS NULL OR parent_lane IN ('task', 'request')),
    task_id TEXT,
    position INTEGER NOT NULL CHECK (position >= 0),
    message_kind TEXT NOT NULL
      CHECK (message_kind IN ('brief', 'history', 'inbox')),
    home_station TEXT NOT NULL
      CHECK (home_station = 'vellum:command-center'),
    seq TEXT NOT NULL
      CHECK (
        length(seq) > 0
        AND seq NOT GLOB '*[^0-9]*'
        AND (seq = '0' OR substr(seq, 1, 1) <> '0')
      ),
    role TEXT NOT NULL CHECK (role IN ('user', 'agent')),
    parts_json TEXT NOT NULL,
    context_id TEXT,
    reference_task_ids_json TEXT,
    metadata_json TEXT,
    origin_at TEXT NOT NULL CHECK (length(origin_at) > 0),
    received_at TEXT NOT NULL CHECK (length(received_at) > 0),
    PRIMARY KEY (canvas_name, node_id, message_id),
    UNIQUE (home_station, seq),
    UNIQUE (canvas_name, node_id, parent_lane, task_id, position),
    CHECK (
      (
        parent_lane IS NULL
        AND task_id IS NULL
        AND message_kind = 'inbox'
      )
      OR
      (
        parent_lane IS NOT NULL
        AND task_id IS NOT NULL
        AND message_kind IN ('brief', 'history')
      )
    ),
    FOREIGN KEY (home_station, seq)
      REFERENCES work_events(home_station, seq) ON DELETE RESTRICT
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS work_artifacts (
    canvas_name TEXT NOT NULL CHECK (length(canvas_name) > 0),
    node_id TEXT NOT NULL CHECK (length(node_id) > 0),
    artifact_id TEXT NOT NULL CHECK (length(artifact_id) > 0),
    home_station TEXT NOT NULL CHECK (length(home_station) > 0),
    seq TEXT NOT NULL
      CHECK (
        length(seq) > 0
        AND seq NOT GLOB '*[^0-9]*'
        AND (seq = '0' OR substr(seq, 1, 1) <> '0')
      ),
    name TEXT,
    parts_json TEXT NOT NULL,
    task_id TEXT,
    metadata_json TEXT,
    origin_at TEXT NOT NULL CHECK (length(origin_at) > 0),
    received_at TEXT NOT NULL CHECK (length(received_at) > 0),
    PRIMARY KEY (canvas_name, node_id, artifact_id),
    UNIQUE (home_station, seq),
    FOREIGN KEY (home_station, seq)
      REFERENCES work_events(home_station, seq) ON DELETE RESTRICT
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS work_task_transitions (
    canvas_name TEXT NOT NULL CHECK (length(canvas_name) > 0),
    node_id TEXT NOT NULL CHECK (length(node_id) > 0),
    task_id TEXT NOT NULL CHECK (length(task_id) > 0),
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    lane TEXT NOT NULL CHECK (lane IN ('task', 'request')),
    home_station TEXT NOT NULL CHECK (length(home_station) > 0),
    seq TEXT NOT NULL
      CHECK (
        length(seq) > 0
        AND seq NOT GLOB '*[^0-9]*'
        AND (seq = '0' OR substr(seq, 1, 1) <> '0')
      ),
    operation TEXT NOT NULL CHECK (length(operation) > 0),
    from_state TEXT,
    to_state TEXT NOT NULL
      CHECK (
        to_state IN (
          'submitted',
          'working',
          'input-required',
          'completed',
          'canceled',
          'failed',
          'rejected',
          'auth-required'
        )
      ),
    origin_at TEXT NOT NULL CHECK (length(origin_at) > 0),
    received_at TEXT NOT NULL CHECK (length(received_at) > 0),
    PRIMARY KEY (canvas_name, node_id, task_id, lane, ordinal),
    UNIQUE (home_station, seq),
    CHECK (
      from_state IS NULL
      OR from_state IN (
        'submitted',
        'working',
        'input-required',
        'completed',
        'canceled',
        'failed',
        'rejected',
        'auth-required'
      )
    ),
    FOREIGN KEY (home_station, seq)
      REFERENCES work_events(home_station, seq) ON DELETE RESTRICT
  ) STRICT, WITHOUT ROWID;

  CREATE INDEX IF NOT EXISTS work_events_home_order
    ON work_events(home_station, length(seq), seq);
  CREATE INDEX IF NOT EXISTS work_tasks_node
    ON work_tasks(canvas_name, node_id, created_at, task_id);
  CREATE INDEX IF NOT EXISTS work_requests_node
    ON work_requests(canvas_name, node_id, created_at, task_id);
  CREATE INDEX IF NOT EXISTS work_messages_thread
    ON work_messages(canvas_name, node_id, parent_lane, task_id, position);
  CREATE UNIQUE INDEX IF NOT EXISTS work_messages_inbox_position
    ON work_messages(canvas_name, node_id, position)
    WHERE parent_lane IS NULL AND task_id IS NULL;
  CREATE INDEX IF NOT EXISTS work_artifacts_node
    ON work_artifacts(canvas_name, node_id, artifact_id);

  CREATE TRIGGER IF NOT EXISTS work_tasks_home_immutable
  BEFORE UPDATE OF home_station ON work_tasks
  WHEN OLD.home_station <> NEW.home_station
  BEGIN
    SELECT RAISE(ABORT, 'work task home is immutable; use explicit re-home');
  END;

  CREATE TRIGGER IF NOT EXISTS work_requests_home_immutable
  BEFORE UPDATE OF home_station ON work_requests
  WHEN OLD.home_station <> NEW.home_station
  BEGIN
    SELECT RAISE(ABORT, 'work request home is immutable; use explicit re-home');
  END;

  CREATE TRIGGER IF NOT EXISTS work_artifacts_home_immutable
  BEFORE UPDATE OF home_station ON work_artifacts
  WHEN OLD.home_station <> NEW.home_station
  BEGIN
    SELECT RAISE(ABORT, 'work artifact home is immutable; use explicit re-home');
  END;
`;
