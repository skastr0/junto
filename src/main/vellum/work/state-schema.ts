/**
 * Durable work-plane schema.
 *
 * Entity placement and event authorship are deliberately separate:
 *
 * - `home_station` / `entity_home` is the one installation host that executes
 *   the row.
 * - `event_home` is the installation that authored a mutation.
 *
 * That distinction lets a Command Center issue a command while an offline
 * Remote records execution progress without either installation allocating
 * numbers in the other's logical stream.
 */
export const WORK_STATE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS work_event_sequences (
    event_home TEXT NOT NULL CHECK (length(event_home) > 0),
    entity_home TEXT NOT NULL CHECK (length(entity_home) > 0),
    last_seq TEXT NOT NULL
      CHECK (
        length(last_seq) > 0
        AND last_seq NOT GLOB '*[^0-9]*'
        AND (last_seq = '0' OR substr(last_seq, 1, 1) <> '0')
      ),
    PRIMARY KEY (event_home, entity_home)
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS work_events (
    event_home TEXT NOT NULL CHECK (length(event_home) > 0),
    seq TEXT NOT NULL
      CHECK (
        length(seq) > 0
        AND seq NOT GLOB '*[^0-9]*'
        AND (seq = '0' OR substr(seq, 1, 1) <> '0')
      ),
    entity_home TEXT NOT NULL CHECK (length(entity_home) > 0),
    canvas_name TEXT NOT NULL CHECK (length(canvas_name) > 0),
    node_id TEXT NOT NULL CHECK (length(node_id) > 0),
    entity_kind TEXT NOT NULL
      CHECK (
        entity_kind IN ('task', 'request', 'message', 'artifact', 'receipt')
      ),
    entity_id TEXT NOT NULL CHECK (length(entity_id) > 0),
    operation TEXT NOT NULL CHECK (length(operation) > 0),
    origin_at TEXT NOT NULL CHECK (length(origin_at) > 0),
    received_at TEXT NOT NULL CHECK (length(received_at) > 0),
    payload_json TEXT NOT NULL CHECK (length(payload_json) > 0),
    content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
    PRIMARY KEY (event_home, entity_home, seq),
    FOREIGN KEY (event_home, entity_home)
      REFERENCES work_event_sequences(event_home, entity_home)
      ON DELETE RESTRICT
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS work_pending_commands (
    event_home TEXT NOT NULL CHECK (length(event_home) > 0),
    entity_home TEXT NOT NULL CHECK (length(entity_home) > 0),
    seq TEXT NOT NULL
      CHECK (
        length(seq) > 0
        AND seq NOT GLOB '*[^0-9]*'
        AND (seq = '0' OR substr(seq, 1, 1) <> '0')
      ),
    status TEXT NOT NULL
      CHECK (status IN ('pending', 'applied', 'rejected')),
    acknowledged_by TEXT,
    resolved_at TEXT,
    PRIMARY KEY (event_home, entity_home, seq),
    CHECK (
      (
        status = 'pending'
        AND acknowledged_by IS NULL
        AND resolved_at IS NULL
      )
      OR
      (
        status IN ('applied', 'rejected')
        AND acknowledged_by IS NOT NULL
        AND length(acknowledged_by) > 0
        AND resolved_at IS NOT NULL
        AND length(resolved_at) > 0
      )
    ),
    FOREIGN KEY (event_home, entity_home, seq)
      REFERENCES work_events(event_home, entity_home, seq)
      ON DELETE RESTRICT
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS work_tasks (
    canvas_name TEXT NOT NULL CHECK (length(canvas_name) > 0),
    node_id TEXT NOT NULL CHECK (length(node_id) > 0),
    task_id TEXT NOT NULL CHECK (length(task_id) > 0),
    home_station TEXT NOT NULL CHECK (length(home_station) > 0),
    event_home TEXT NOT NULL CHECK (length(event_home) > 0),
    event_seq TEXT NOT NULL
      CHECK (
        length(event_seq) > 0
        AND event_seq NOT GLOB '*[^0-9]*'
        AND (event_seq = '0' OR substr(event_seq, 1, 1) <> '0')
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
    UNIQUE (event_home, home_station, event_seq),
    FOREIGN KEY (event_home, home_station, event_seq)
      REFERENCES work_events(event_home, entity_home, seq)
      ON DELETE RESTRICT
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS work_requests (
    canvas_name TEXT NOT NULL CHECK (length(canvas_name) > 0),
    node_id TEXT NOT NULL CHECK (length(node_id) > 0),
    task_id TEXT NOT NULL CHECK (length(task_id) > 0),
    home_station TEXT NOT NULL CHECK (length(home_station) > 0),
    event_home TEXT NOT NULL CHECK (length(event_home) > 0),
    event_seq TEXT NOT NULL
      CHECK (
        length(event_seq) > 0
        AND event_seq NOT GLOB '*[^0-9]*'
        AND (event_seq = '0' OR substr(event_seq, 1, 1) <> '0')
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
    UNIQUE (event_home, home_station, event_seq),
    FOREIGN KEY (event_home, home_station, event_seq)
      REFERENCES work_events(event_home, entity_home, seq)
      ON DELETE RESTRICT
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS work_task_messages (
    canvas_name TEXT NOT NULL CHECK (length(canvas_name) > 0),
    node_id TEXT NOT NULL CHECK (length(node_id) > 0),
    parent_lane TEXT NOT NULL CHECK (parent_lane IN ('task', 'request')),
    task_id TEXT NOT NULL CHECK (length(task_id) > 0),
    message_id TEXT NOT NULL CHECK (length(message_id) > 0),
    position INTEGER NOT NULL CHECK (position >= 0),
    message_kind TEXT NOT NULL CHECK (message_kind IN ('brief', 'history')),
    entity_home TEXT NOT NULL CHECK (length(entity_home) > 0),
    event_home TEXT NOT NULL CHECK (length(event_home) > 0),
    event_seq TEXT NOT NULL
      CHECK (
        length(event_seq) > 0
        AND event_seq NOT GLOB '*[^0-9]*'
        AND (event_seq = '0' OR substr(event_seq, 1, 1) <> '0')
      ),
    role TEXT NOT NULL CHECK (role IN ('user', 'agent')),
    parts_json TEXT NOT NULL,
    context_id TEXT,
    reference_task_ids_json TEXT,
    metadata_json TEXT,
    origin_at TEXT NOT NULL CHECK (length(origin_at) > 0),
    received_at TEXT NOT NULL CHECK (length(received_at) > 0),
    PRIMARY KEY (canvas_name, node_id, parent_lane, task_id, message_id),
    UNIQUE (canvas_name, node_id, parent_lane, task_id, position),
    FOREIGN KEY (event_home, entity_home, event_seq)
      REFERENCES work_events(event_home, entity_home, seq)
      ON DELETE RESTRICT
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS work_messages (
    canvas_name TEXT NOT NULL CHECK (length(canvas_name) > 0),
    node_id TEXT NOT NULL CHECK (length(node_id) > 0),
    message_id TEXT NOT NULL CHECK (length(message_id) > 0),
    position INTEGER NOT NULL CHECK (position >= 0),
    home_station TEXT NOT NULL
      CHECK (home_station = 'vellum:command-center'),
    event_home TEXT NOT NULL CHECK (length(event_home) > 0),
    event_seq TEXT NOT NULL
      CHECK (
        length(event_seq) > 0
        AND event_seq NOT GLOB '*[^0-9]*'
        AND (event_seq = '0' OR substr(event_seq, 1, 1) <> '0')
      ),
    role TEXT NOT NULL CHECK (role IN ('user', 'agent')),
    parts_json TEXT NOT NULL,
    context_id TEXT,
    reference_task_ids_json TEXT,
    metadata_json TEXT,
    origin_at TEXT NOT NULL CHECK (length(origin_at) > 0),
    received_at TEXT NOT NULL CHECK (length(received_at) > 0),
    PRIMARY KEY (canvas_name, node_id, message_id),
    UNIQUE (event_home, home_station, event_seq),
    UNIQUE (canvas_name, node_id, position),
    FOREIGN KEY (event_home, home_station, event_seq)
      REFERENCES work_events(event_home, entity_home, seq)
      ON DELETE RESTRICT
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS work_artifacts (
    canvas_name TEXT NOT NULL CHECK (length(canvas_name) > 0),
    node_id TEXT NOT NULL CHECK (length(node_id) > 0),
    artifact_id TEXT NOT NULL CHECK (length(artifact_id) > 0),
    home_station TEXT NOT NULL CHECK (length(home_station) > 0),
    event_home TEXT NOT NULL CHECK (length(event_home) > 0),
    event_seq TEXT NOT NULL
      CHECK (
        length(event_seq) > 0
        AND event_seq NOT GLOB '*[^0-9]*'
        AND (event_seq = '0' OR substr(event_seq, 1, 1) <> '0')
      ),
    name TEXT,
    parts_json TEXT NOT NULL,
    task_id TEXT,
    metadata_json TEXT,
    origin_at TEXT NOT NULL CHECK (length(origin_at) > 0),
    received_at TEXT NOT NULL CHECK (length(received_at) > 0),
    PRIMARY KEY (canvas_name, node_id, artifact_id),
    UNIQUE (event_home, home_station, event_seq),
    FOREIGN KEY (event_home, home_station, event_seq)
      REFERENCES work_events(event_home, entity_home, seq)
      ON DELETE RESTRICT
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS work_task_transitions (
    canvas_name TEXT NOT NULL CHECK (length(canvas_name) > 0),
    node_id TEXT NOT NULL CHECK (length(node_id) > 0),
    task_id TEXT NOT NULL CHECK (length(task_id) > 0),
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    lane TEXT NOT NULL CHECK (lane IN ('task', 'request')),
    home_station TEXT NOT NULL CHECK (length(home_station) > 0),
    event_home TEXT NOT NULL CHECK (length(event_home) > 0),
    event_seq TEXT NOT NULL
      CHECK (
        length(event_seq) > 0
        AND event_seq NOT GLOB '*[^0-9]*'
        AND (event_seq = '0' OR substr(event_seq, 1, 1) <> '0')
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
    UNIQUE (event_home, home_station, event_seq),
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
    FOREIGN KEY (event_home, home_station, event_seq)
      REFERENCES work_events(event_home, entity_home, seq)
      ON DELETE RESTRICT
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS work_rejections (
    rejected_event_home TEXT NOT NULL CHECK (length(rejected_event_home) > 0),
    rejected_entity_home TEXT NOT NULL
      CHECK (length(rejected_entity_home) > 0),
    rejected_seq TEXT NOT NULL
      CHECK (
        length(rejected_seq) > 0
        AND rejected_seq NOT GLOB '*[^0-9]*'
        AND (rejected_seq = '0' OR substr(rejected_seq, 1, 1) <> '0')
      ),
    rejected_content_sha256 TEXT NOT NULL
      CHECK (length(rejected_content_sha256) = 64),
    rejected_payload_json TEXT,
    reason TEXT NOT NULL CHECK (reason = 'causal-conflict'),
    message TEXT NOT NULL CHECK (length(message) > 0),
    reported_by TEXT NOT NULL CHECK (length(reported_by) > 0),
    receipt_event_home TEXT NOT NULL CHECK (length(receipt_event_home) > 0),
    receipt_event_seq TEXT NOT NULL
      CHECK (
        length(receipt_event_seq) > 0
        AND receipt_event_seq NOT GLOB '*[^0-9]*'
        AND (
          receipt_event_seq = '0'
          OR substr(receipt_event_seq, 1, 1) <> '0'
        )
      ),
    received_at TEXT NOT NULL CHECK (length(received_at) > 0),
    PRIMARY KEY (
      rejected_event_home,
      rejected_entity_home,
      rejected_seq,
      reported_by
    ),
    FOREIGN KEY (
      receipt_event_home,
      rejected_entity_home,
      receipt_event_seq
    ) REFERENCES work_events(event_home, entity_home, seq)
      ON DELETE RESTRICT
  ) STRICT, WITHOUT ROWID;

  CREATE INDEX IF NOT EXISTS work_events_route_order
    ON work_events(event_home, entity_home, length(seq), seq);
  CREATE INDEX IF NOT EXISTS work_pending_commands_route
    ON work_pending_commands(
      event_home,
      entity_home,
      status,
      length(seq),
      seq
    );
  CREATE INDEX IF NOT EXISTS work_tasks_node
    ON work_tasks(canvas_name, node_id, created_at, task_id);
  CREATE INDEX IF NOT EXISTS work_requests_node
    ON work_requests(canvas_name, node_id, created_at, task_id);
  CREATE INDEX IF NOT EXISTS work_task_messages_thread
    ON work_task_messages(
      canvas_name,
      node_id,
      parent_lane,
      task_id,
      position
    );
  CREATE INDEX IF NOT EXISTS work_messages_inbox
    ON work_messages(canvas_name, node_id, position);
  CREATE INDEX IF NOT EXISTS work_artifacts_node
    ON work_artifacts(canvas_name, node_id, artifact_id);
  CREATE INDEX IF NOT EXISTS work_rejections_route
    ON work_rejections(
      rejected_entity_home,
      reported_by,
      length(rejected_seq),
      rejected_seq
    );

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
