/**
 * The durable work schema: the journal (`work_events`, `work_facts`), the
 * allocation of its sequences, and the rows materialized from it.
 *
 * A record is identified by `(event_home, entity_home, seq)`. Both homes name
 * the installation that wrote it, and only that installation appends under
 * its id. The journal is immutable; every other table here can be rebuilt
 * from it or holds a reader's own position.
 */

/**
 * The mail a seat sent sits in its recipients' mailboxes, found by the
 * sender's stamp (`readMailSentBy`, for onboard and `junto since`). Without
 * this the read walks every mail on the canvas and parses its metadata;
 * node_id and position serve its order.
 * The expression must stay the one that query filters on, the same JSON
 * path included, or SQLite does not use the index.
 */
export const WORK_MESSAGES_SENDER_INDEX_SQL = `CREATE INDEX IF NOT EXISTS work_messages_sender
    ON work_messages(canvas_name, json_extract(metadata_json,'$.senderNodeId'), node_id, position);`;

export const WORK_STATE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS work_event_sequences (
    event_home TEXT NOT NULL,
    entity_home TEXT NOT NULL,
    last_seq TEXT NOT NULL
      CHECK (
        length(last_seq) BETWEEN 1 AND 32
        AND last_seq NOT GLOB '*[^0-9]*'
        AND (last_seq = '0' OR substr(last_seq, 1, 1) <> '0')
      ),
    PRIMARY KEY (event_home, entity_home),
    FOREIGN KEY (event_home)
      REFERENCES known_installations(installation_id)
      ON DELETE RESTRICT
      ON UPDATE RESTRICT,
    FOREIGN KEY (entity_home)
      REFERENCES known_installations(installation_id)
      ON DELETE RESTRICT
      ON UPDATE RESTRICT
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS work_events (
    event_home TEXT NOT NULL,
    entity_home TEXT NOT NULL,
    seq TEXT NOT NULL
      CHECK (
        length(seq) BETWEEN 1 AND 32
        AND seq NOT GLOB '*[^0-9]*'
        AND substr(seq, 1, 1) <> '0'
      ),
    protocol TEXT NOT NULL CHECK (protocol = 'junto/work/v1'),
    record_type TEXT NOT NULL CHECK (record_type = 'fact'),
    item_kind TEXT NOT NULL CHECK (length(item_kind) BETWEEN 1 AND 32),
    item_id TEXT NOT NULL CHECK (length(item_id) BETWEEN 1 AND 256),
    item_canvas_name TEXT NOT NULL
      CHECK (length(item_canvas_name) BETWEEN 1 AND 256),
    item_node_id TEXT NOT NULL
      CHECK (length(item_node_id) BETWEEN 1 AND 256),
    operation TEXT NOT NULL CHECK (length(operation) BETWEEN 1 AND 64),
    content_sha256 TEXT NOT NULL
      CHECK (
        length(content_sha256) = 64
        AND content_sha256 NOT GLOB '*[^a-f0-9]*'
      ),
    origin_at TEXT NOT NULL CHECK (length(origin_at) BETWEEN 1 AND 64),
    received_at TEXT NOT NULL CHECK (length(received_at) BETWEEN 1 AND 64),
    PRIMARY KEY (event_home, entity_home, seq),
    UNIQUE (event_home, entity_home, seq, record_type),
    CHECK (event_home = entity_home),
    FOREIGN KEY (event_home, entity_home)
      REFERENCES work_event_sequences(event_home, entity_home)
      ON DELETE RESTRICT
      ON UPDATE RESTRICT,
    FOREIGN KEY (event_home)
      REFERENCES known_installations(installation_id)
      ON DELETE RESTRICT
      ON UPDATE RESTRICT,
    FOREIGN KEY (entity_home)
      REFERENCES known_installations(installation_id)
      ON DELETE RESTRICT
      ON UPDATE RESTRICT
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS work_facts (
    event_home TEXT NOT NULL,
    entity_home TEXT NOT NULL,
    seq TEXT NOT NULL,
    record_type TEXT NOT NULL DEFAULT 'fact'
      CHECK (record_type = 'fact'),
    predecessor_event_home TEXT,
    predecessor_entity_home TEXT,
    predecessor_seq TEXT
      CHECK (
        predecessor_seq IS NULL
        OR (
          length(predecessor_seq) BETWEEN 1 AND 32
          AND predecessor_seq NOT GLOB '*[^0-9]*'
          AND substr(predecessor_seq, 1, 1) <> '0'
        )
      ),
    result_json TEXT NOT NULL
      CHECK (
        length(result_json) BETWEEN 2 AND 262144
        AND json_valid(result_json)
      ),
    basis_kind TEXT NOT NULL CHECK (basis_kind IN ('canvas', 'historical')),
    basis_canvas_name TEXT,
    basis_canvas_seq INTEGER CHECK (
      basis_canvas_seq IS NULL OR basis_canvas_seq BETWEEN 0 AND 9007199254740991
    ),
    PRIMARY KEY (event_home, entity_home, seq),
    CHECK (event_home = entity_home),
    CHECK (
      (
        basis_kind = 'historical'
        AND basis_canvas_name IS NULL
        AND basis_canvas_seq IS NULL
      )
      OR
      (
        basis_kind = 'canvas'
        AND basis_canvas_name IS NOT NULL
        AND basis_canvas_seq IS NOT NULL
      )
    ),
    CHECK (
      (
        predecessor_event_home IS NULL
        AND predecessor_entity_home IS NULL
        AND predecessor_seq IS NULL
      )
      OR
      (
        predecessor_event_home IS NOT NULL
        AND predecessor_entity_home IS NOT NULL
        AND predecessor_seq IS NOT NULL
        AND predecessor_entity_home = entity_home
      )
    ),
    FOREIGN KEY (event_home, entity_home, seq, record_type)
      REFERENCES work_events(event_home, entity_home, seq, record_type)
      ON DELETE RESTRICT
      ON UPDATE RESTRICT,
    FOREIGN KEY (
      predecessor_event_home,
      predecessor_entity_home,
      predecessor_seq
    ) REFERENCES work_facts(event_home, entity_home, seq)
      ON DELETE RESTRICT
      ON UPDATE RESTRICT
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS work_tasks (
    canvas_name TEXT NOT NULL CHECK (length(canvas_name) BETWEEN 1 AND 256),
    node_id TEXT NOT NULL CHECK (length(node_id) BETWEEN 1 AND 256),
    task_id TEXT NOT NULL CHECK (length(task_id) BETWEEN 1 AND 256),
    entity_home TEXT NOT NULL,
    actor_seat_id TEXT
      CHECK (
        actor_seat_id IS NULL
        OR (
          length(actor_seat_id) = 69
          AND substr(actor_seat_id, 1, 5) = 'seat_'
          AND substr(actor_seat_id, 6) NOT GLOB '*[^a-f0-9]*'
        )
      ),
    fact_event_home TEXT NOT NULL,
    fact_entity_home TEXT NOT NULL,
    fact_seq TEXT NOT NULL,
    state TEXT NOT NULL
      CHECK (
        state IN (
          'submitted',
          'working',
          'input-required',
          'auth-required',
          'completed',
          'canceled',
          'failed',
          'rejected',
          'archived'
        )
      ),
    brief_message_id TEXT NOT NULL
      CHECK (length(brief_message_id) BETWEEN 1 AND 256),
    artifact_ids_json TEXT
      CHECK (artifact_ids_json IS NULL OR json_valid(artifact_ids_json)),
    metadata_json TEXT
      CHECK (
        metadata_json IS NULL
        OR (
          json_valid(metadata_json)
          AND json_type(metadata_json, '$.claimedBy') IS NULL
        )
      ),
    reason TEXT,
    response TEXT,
    created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 1 AND 64),
    updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 1 AND 64),
    origin_at TEXT NOT NULL CHECK (length(origin_at) BETWEEN 1 AND 64),
    received_at TEXT NOT NULL CHECK (length(received_at) BETWEEN 1 AND 64),
    PRIMARY KEY (canvas_name, node_id, task_id),
    UNIQUE (canvas_name, node_id, task_id, entity_home),
    UNIQUE (fact_event_home, fact_entity_home, fact_seq),
    CHECK (entity_home = fact_entity_home),
    CHECK (fact_event_home = fact_entity_home),
    CHECK (
      (state = 'submitted' AND actor_seat_id IS NULL)
      OR state IN ('completed', 'canceled', 'failed', 'rejected', 'archived')
      OR (
        state IN ('working', 'input-required', 'auth-required')
        AND actor_seat_id IS NOT NULL
      )
    ),
    FOREIGN KEY (entity_home)
      REFERENCES known_installations(installation_id)
      ON DELETE RESTRICT
      ON UPDATE RESTRICT,
    FOREIGN KEY (fact_event_home, fact_entity_home, fact_seq)
      REFERENCES work_facts(event_home, entity_home, seq)
      ON DELETE RESTRICT
      ON UPDATE RESTRICT
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS work_task_messages (
    canvas_name TEXT NOT NULL CHECK (length(canvas_name) BETWEEN 1 AND 256),
    node_id TEXT NOT NULL CHECK (length(node_id) BETWEEN 1 AND 256),
    parent_lane TEXT NOT NULL CHECK (parent_lane IN ('task')),
    item_id TEXT NOT NULL CHECK (length(item_id) BETWEEN 1 AND 256),
    message_id TEXT NOT NULL CHECK (length(message_id) BETWEEN 1 AND 256),
    position INTEGER NOT NULL CHECK (position >= 0),
    message_kind TEXT NOT NULL CHECK (message_kind IN ('brief', 'history')),
    entity_home TEXT NOT NULL,
    fact_event_home TEXT NOT NULL,
    fact_entity_home TEXT NOT NULL,
    fact_seq TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'agent')),
    parts_json TEXT NOT NULL CHECK (json_valid(parts_json)),
    context_id TEXT,
    reference_task_ids_json TEXT
      CHECK (
        reference_task_ids_json IS NULL
        OR json_valid(reference_task_ids_json)
      ),
    metadata_json TEXT
      CHECK (metadata_json IS NULL OR json_valid(metadata_json)),
    origin_at TEXT NOT NULL CHECK (length(origin_at) BETWEEN 1 AND 64),
    received_at TEXT NOT NULL CHECK (length(received_at) BETWEEN 1 AND 64),
    PRIMARY KEY (
      canvas_name,
      node_id,
      parent_lane,
      item_id,
      message_id
    ),
    UNIQUE (canvas_name, node_id, parent_lane, item_id, position),
    CHECK (entity_home = fact_entity_home),
    CHECK (fact_event_home = fact_entity_home),
    FOREIGN KEY (entity_home)
      REFERENCES known_installations(installation_id)
      ON DELETE RESTRICT
      ON UPDATE RESTRICT,
    FOREIGN KEY (fact_event_home, fact_entity_home, fact_seq)
      REFERENCES work_facts(event_home, entity_home, seq)
      ON DELETE RESTRICT
      ON UPDATE RESTRICT
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS work_messages (
    canvas_name TEXT NOT NULL CHECK (length(canvas_name) BETWEEN 1 AND 256),
    node_id TEXT NOT NULL CHECK (length(node_id) BETWEEN 1 AND 256),
    message_id TEXT NOT NULL CHECK (length(message_id) BETWEEN 1 AND 256),
    position INTEGER NOT NULL CHECK (position >= 0),
    entity_home TEXT NOT NULL,
    actor_seat_id TEXT NOT NULL
      CHECK (
        length(actor_seat_id) = 69
        AND substr(actor_seat_id, 1, 5) = 'seat_'
        AND substr(actor_seat_id, 6) NOT GLOB '*[^a-f0-9]*'
      ),
    fact_event_home TEXT NOT NULL,
    fact_entity_home TEXT NOT NULL,
    fact_seq TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'agent')),
    parts_json TEXT NOT NULL CHECK (json_valid(parts_json)),
    task_id TEXT
      CHECK (
        task_id IS NULL
        OR length(task_id) BETWEEN 1 AND 256
      ),
    context_id TEXT,
    reference_task_ids_json TEXT
      CHECK (
        reference_task_ids_json IS NULL
        OR json_valid(reference_task_ids_json)
      ),
    metadata_json TEXT
      CHECK (metadata_json IS NULL OR json_valid(metadata_json)),
    origin_at TEXT NOT NULL CHECK (length(origin_at) BETWEEN 1 AND 64),
    received_at TEXT NOT NULL CHECK (length(received_at) BETWEEN 1 AND 64),
    PRIMARY KEY (canvas_name, node_id, message_id),
    UNIQUE (canvas_name, node_id, position),
    UNIQUE (fact_event_home, fact_entity_home, fact_seq),
    CHECK (entity_home = fact_entity_home),
    CHECK (fact_event_home = fact_entity_home),
    FOREIGN KEY (entity_home)
      REFERENCES known_installations(installation_id)
      ON DELETE RESTRICT
      ON UPDATE RESTRICT,
    FOREIGN KEY (fact_event_home, fact_entity_home, fact_seq)
      REFERENCES work_facts(event_home, entity_home, seq)
      ON DELETE RESTRICT
      ON UPDATE RESTRICT
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS work_artifacts (
    canvas_name TEXT NOT NULL CHECK (length(canvas_name) BETWEEN 1 AND 256),
    node_id TEXT NOT NULL CHECK (length(node_id) BETWEEN 1 AND 256),
    artifact_id TEXT NOT NULL CHECK (length(artifact_id) BETWEEN 1 AND 256),
    entity_home TEXT NOT NULL,
    actor_seat_id TEXT NOT NULL
      CHECK (
        length(actor_seat_id) = 69
        AND substr(actor_seat_id, 1, 5) = 'seat_'
        AND substr(actor_seat_id, 6) NOT GLOB '*[^a-f0-9]*'
      ),
    fact_event_home TEXT NOT NULL,
    fact_entity_home TEXT NOT NULL,
    fact_seq TEXT NOT NULL,
    name TEXT,
    parts_json TEXT NOT NULL CHECK (json_valid(parts_json)),
    task_canvas_name TEXT
      CHECK (
        task_canvas_name IS NULL
        OR length(task_canvas_name) BETWEEN 1 AND 256
      ),
    task_node_id TEXT
      CHECK (
        task_node_id IS NULL
        OR length(task_node_id) BETWEEN 1 AND 256
      ),
    task_id TEXT
      CHECK (
        task_id IS NULL
        OR length(task_id) BETWEEN 1 AND 256
      ),
    task_entity_home TEXT,
    metadata_json TEXT
      CHECK (metadata_json IS NULL OR json_valid(metadata_json)),
    origin_at TEXT NOT NULL CHECK (length(origin_at) BETWEEN 1 AND 64),
    received_at TEXT NOT NULL CHECK (length(received_at) BETWEEN 1 AND 64),
    PRIMARY KEY (canvas_name, node_id, artifact_id),
    UNIQUE (fact_event_home, fact_entity_home, fact_seq),
    CHECK (entity_home = fact_entity_home),
    CHECK (fact_event_home = fact_entity_home),
    CHECK (
      (
        task_canvas_name IS NULL
        AND task_node_id IS NULL
        AND task_id IS NULL
        AND task_entity_home IS NULL
      )
      OR
      (
        task_canvas_name IS NOT NULL
        AND task_node_id IS NOT NULL
        AND task_id IS NOT NULL
        AND task_entity_home IS NOT NULL
      )
    ),
    CHECK (
      task_entity_home IS NULL
      OR task_entity_home = entity_home
    ),
    FOREIGN KEY (entity_home)
      REFERENCES known_installations(installation_id)
      ON DELETE RESTRICT
      ON UPDATE RESTRICT,
    FOREIGN KEY (
      task_canvas_name,
      task_node_id,
      task_id,
      task_entity_home
    ) REFERENCES work_tasks(
      canvas_name,
      node_id,
      task_id,
      entity_home
    )
      ON DELETE RESTRICT
      ON UPDATE RESTRICT,
    FOREIGN KEY (fact_event_home, fact_entity_home, fact_seq)
      REFERENCES work_facts(event_home, entity_home, seq)
      ON DELETE RESTRICT
      ON UPDATE RESTRICT
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS work_task_transitions (
    canvas_name TEXT NOT NULL CHECK (length(canvas_name) BETWEEN 1 AND 256),
    node_id TEXT NOT NULL CHECK (length(node_id) BETWEEN 1 AND 256),
    item_id TEXT NOT NULL CHECK (length(item_id) BETWEEN 1 AND 256),
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    lane TEXT NOT NULL CHECK (lane IN ('task')),
    entity_home TEXT NOT NULL,
    actor_seat_id TEXT
      CHECK (
        actor_seat_id IS NULL
        OR (
          length(actor_seat_id) = 69
          AND substr(actor_seat_id, 1, 5) = 'seat_'
          AND substr(actor_seat_id, 6) NOT GLOB '*[^a-f0-9]*'
        )
      ),
    fact_event_home TEXT NOT NULL,
    fact_entity_home TEXT NOT NULL,
    fact_seq TEXT NOT NULL,
    operation TEXT NOT NULL
      CHECK (
        operation IN (
          'task.create',
          'task.describe',
          'task.transition',
          'task.claim'
        )
      ),
    from_state TEXT,
    to_state TEXT NOT NULL
      CHECK (
        to_state IN (
          'submitted',
          'working',
          'input-required',
          'auth-required',
          'completed',
          'canceled',
          'failed',
          'rejected',
          'archived'
        )
      ),
    origin_at TEXT NOT NULL CHECK (length(origin_at) BETWEEN 1 AND 64),
    received_at TEXT NOT NULL CHECK (length(received_at) BETWEEN 1 AND 64),
    PRIMARY KEY (canvas_name, node_id, item_id, lane, ordinal),
    UNIQUE (fact_event_home, fact_entity_home, fact_seq),
    CHECK (
      from_state IS NULL
      OR from_state IN (
        'submitted',
        'working',
        'input-required',
        'auth-required',
        'completed',
        'canceled',
        'failed',
        'rejected',
        'archived'
      )
    ),
    CHECK (
      to_state NOT IN ('working', 'input-required', 'auth-required')
      OR actor_seat_id IS NOT NULL
    ),
    CHECK (entity_home = fact_entity_home),
    CHECK (fact_event_home = fact_entity_home),
    FOREIGN KEY (entity_home)
      REFERENCES known_installations(installation_id)
      ON DELETE RESTRICT
      ON UPDATE RESTRICT,
    FOREIGN KEY (fact_event_home, fact_entity_home, fact_seq)
      REFERENCES work_facts(event_home, entity_home, seq)
      ON DELETE RESTRICT
      ON UPDATE RESTRICT
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS work_delivery_receipts (
    delivery_id TEXT NOT NULL CHECK (length(delivery_id) BETWEEN 1 AND 256),
    delivered_item_kind TEXT NOT NULL
      CHECK (
        delivered_item_kind IN (
          'task',
          'request',
          'message',
          'artifact',
          'delivery'
        )
      ),
    delivered_item_id TEXT NOT NULL
      CHECK (length(delivered_item_id) BETWEEN 1 AND 256),
    delivered_canvas_name TEXT NOT NULL
      CHECK (length(delivered_canvas_name) BETWEEN 1 AND 256),
    delivered_node_id TEXT NOT NULL
      CHECK (length(delivered_node_id) BETWEEN 1 AND 256),
    actor_seat_id TEXT NOT NULL
      CHECK (
        length(actor_seat_id) = 69
        AND substr(actor_seat_id, 1, 5) = 'seat_'
        AND substr(actor_seat_id, 6) NOT GLOB '*[^a-f0-9]*'
      ),
    actor_canvas_name TEXT NOT NULL
      CHECK (length(actor_canvas_name) BETWEEN 1 AND 256),
    actor_node_id TEXT NOT NULL
      CHECK (length(actor_node_id) BETWEEN 1 AND 256),
    entity_home TEXT NOT NULL,
    fact_event_home TEXT NOT NULL,
    fact_entity_home TEXT NOT NULL,
    fact_seq TEXT NOT NULL,
    accepted_at TEXT NOT NULL CHECK (length(accepted_at) BETWEEN 1 AND 64),
    received_at TEXT NOT NULL CHECK (length(received_at) BETWEEN 1 AND 64),
    PRIMARY KEY (
      delivered_canvas_name,
      delivered_node_id,
      delivery_id
    ),
    UNIQUE (fact_event_home, fact_entity_home, fact_seq),
    CHECK (entity_home = fact_entity_home),
    CHECK (fact_event_home = fact_entity_home),
    FOREIGN KEY (entity_home)
      REFERENCES known_installations(installation_id)
      ON DELETE RESTRICT
      ON UPDATE RESTRICT,
    FOREIGN KEY (fact_event_home, fact_entity_home, fact_seq)
      REFERENCES work_facts(event_home, entity_home, seq)
      ON DELETE RESTRICT
      ON UPDATE RESTRICT
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS work_task_dependencies (
    canvas_name TEXT NOT NULL CHECK (length(canvas_name) BETWEEN 1 AND 256),
    node_id TEXT NOT NULL CHECK (length(node_id) BETWEEN 1 AND 256),
    task_id TEXT NOT NULL CHECK (length(task_id) BETWEEN 1 AND 256),
    depends_on_task_id TEXT NOT NULL
      CHECK (length(depends_on_task_id) BETWEEN 1 AND 256),
    position INTEGER NOT NULL CHECK (position >= 0),
    PRIMARY KEY (canvas_name, node_id, task_id, depends_on_task_id),
    FOREIGN KEY (canvas_name, node_id, task_id)
      REFERENCES work_tasks(canvas_name, node_id, task_id)
      ON DELETE CASCADE
      ON UPDATE RESTRICT
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS work_task_finish (
    canvas_name TEXT NOT NULL CHECK (length(canvas_name) BETWEEN 1 AND 256),
    node_id TEXT NOT NULL CHECK (length(node_id) BETWEEN 1 AND 256),
    task_id TEXT NOT NULL CHECK (length(task_id) BETWEEN 1 AND 256),
    finish_criteria_json TEXT
      CHECK (finish_criteria_json IS NULL OR json_valid(finish_criteria_json)),
    completion_evidence_json TEXT
      CHECK (
        completion_evidence_json IS NULL
        OR json_valid(completion_evidence_json)
      ),
    PRIMARY KEY (canvas_name, node_id, task_id),
    FOREIGN KEY (canvas_name, node_id, task_id)
      REFERENCES work_tasks(canvas_name, node_id, task_id)
      ON DELETE CASCADE
      ON UPDATE RESTRICT
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS work_canvas_revisions (
    canvas_name TEXT NOT NULL
      PRIMARY KEY
      CHECK (length(canvas_name) BETWEEN 1 AND 256),
    revision INTEGER NOT NULL CHECK (revision >= 0)
  ) STRICT, WITHOUT ROWID;

  CREATE INDEX IF NOT EXISTS work_tasks_node
    ON work_tasks(canvas_name, node_id, created_at, task_id);

  CREATE UNIQUE INDEX IF NOT EXISTS work_tasks_one_active_per_actor
    ON work_tasks(actor_seat_id)
    WHERE
      actor_seat_id IS NOT NULL
      AND state IN ('working', 'input-required', 'auth-required');

  CREATE INDEX IF NOT EXISTS work_task_messages_thread
    ON work_task_messages(
      canvas_name,
      node_id,
      parent_lane,
      item_id,
      position
    );

  CREATE UNIQUE INDEX IF NOT EXISTS work_task_messages_sink_identity
    ON work_task_messages(canvas_name, node_id, message_id);

  CREATE INDEX IF NOT EXISTS work_messages_inbox
    ON work_messages(canvas_name, node_id, position);

  ${WORK_MESSAGES_SENDER_INDEX_SQL}

  CREATE INDEX IF NOT EXISTS work_artifacts_node
    ON work_artifacts(canvas_name, node_id, artifact_id);

  CREATE INDEX IF NOT EXISTS work_delivery_receipts_actor
    ON work_delivery_receipts(
      actor_seat_id,
      accepted_at,
      delivery_id
    );

  CREATE INDEX IF NOT EXISTS work_task_dependencies_dep
    ON work_task_dependencies(canvas_name, node_id, depends_on_task_id);

  CREATE INDEX IF NOT EXISTS work_events_item_history
    ON work_events(
      item_canvas_name,
      item_node_id,
      item_kind,
      item_id,
      entity_home,
      length(seq),
      seq
    );

  CREATE INDEX IF NOT EXISTS work_events_route_order
    ON work_events(event_home, entity_home, length(seq), seq);

  CREATE TRIGGER IF NOT EXISTS work_tasks_home_immutable
  BEFORE UPDATE OF entity_home ON work_tasks
  WHEN
    OLD.entity_home <> NEW.entity_home
    AND NOT (
      OLD.state = 'submitted'
      AND OLD.actor_seat_id IS NULL
      AND NEW.state = 'working'
      AND NEW.actor_seat_id IS NOT NULL
      AND NEW.entity_home = NEW.fact_entity_home
      AND NEW.fact_event_home = NEW.fact_entity_home
    )
  BEGIN
    SELECT RAISE(
      ABORT,
      'work task home is immutable except for first claim adoption'
    );
  END;

  CREATE TRIGGER IF NOT EXISTS work_tasks_actor_immutable
  BEFORE UPDATE OF actor_seat_id ON work_tasks
  WHEN
    OLD.actor_seat_id IS NOT NULL
    AND OLD.actor_seat_id IS NOT NEW.actor_seat_id
    AND NOT (
      NEW.actor_seat_id IS NULL
      AND NEW.state = 'submitted'
    )
  BEGIN
    SELECT RAISE(
      ABORT,
      'work task actor seat is immutable except for operator release'
    );
  END;

  CREATE TRIGGER IF NOT EXISTS work_task_messages_home_immutable
  BEFORE UPDATE OF entity_home ON work_task_messages
  WHEN OLD.entity_home <> NEW.entity_home
  BEGIN
    SELECT RAISE(ABORT, 'work task message home is immutable');
  END;

  CREATE TRIGGER IF NOT EXISTS work_task_messages_require_exact_parent
  BEFORE INSERT ON work_task_messages
  WHEN NOT (
    (
      NEW.parent_lane = 'task'
      AND EXISTS (
        SELECT 1
        FROM work_tasks
        WHERE canvas_name = NEW.canvas_name
          AND node_id = NEW.node_id
          AND task_id = NEW.item_id
          AND entity_home = NEW.entity_home
      )
    )
  )
  BEGIN
    SELECT RAISE(
      ABORT,
      'work task message requires an exact same-home parent'
    );
  END;

  CREATE TRIGGER IF NOT EXISTS work_messages_home_immutable
  BEFORE UPDATE OF entity_home ON work_messages
  WHEN OLD.entity_home <> NEW.entity_home
  BEGIN
    SELECT RAISE(ABORT, 'work message home is immutable');
  END;

  CREATE TRIGGER IF NOT EXISTS work_messages_actor_immutable
  BEFORE UPDATE OF actor_seat_id ON work_messages
  WHEN OLD.actor_seat_id <> NEW.actor_seat_id
  BEGIN
    SELECT RAISE(ABORT, 'work message actor seat is immutable');
  END;

  CREATE TRIGGER IF NOT EXISTS work_artifacts_home_immutable
  BEFORE UPDATE OF entity_home ON work_artifacts
  WHEN OLD.entity_home <> NEW.entity_home
  BEGIN
    SELECT RAISE(ABORT, 'work artifact home is immutable');
  END;

  CREATE TRIGGER IF NOT EXISTS work_artifacts_actor_immutable
  BEFORE UPDATE OF actor_seat_id ON work_artifacts
  WHEN OLD.actor_seat_id <> NEW.actor_seat_id
  BEGIN
    SELECT RAISE(ABORT, 'work artifact actor seat is immutable');
  END;

  CREATE TRIGGER IF NOT EXISTS work_artifacts_require_claimed_task
  BEFORE INSERT ON work_artifacts
  WHEN
    NEW.task_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM work_tasks
      WHERE canvas_name = NEW.task_canvas_name
        AND node_id = NEW.task_node_id
        AND task_id = NEW.task_id
        AND entity_home = NEW.task_entity_home
    )
    AND NOT EXISTS (
      SELECT 1
      FROM work_tasks
      WHERE canvas_name = NEW.task_canvas_name
        AND node_id = NEW.task_node_id
        AND task_id = NEW.task_id
        AND entity_home = NEW.task_entity_home
        AND actor_seat_id IS NOT NULL
    )
  BEGIN
    SELECT RAISE(
      ABORT,
      'work artifact requires an exact claimed same-home task'
    );
  END;

  CREATE TRIGGER IF NOT EXISTS work_artifacts_task_reference_immutable
  BEFORE UPDATE OF
    task_canvas_name,
    task_node_id,
    task_id,
    task_entity_home
  ON work_artifacts
  WHEN
    OLD.task_canvas_name IS NOT NEW.task_canvas_name
    OR OLD.task_node_id IS NOT NEW.task_node_id
    OR OLD.task_id IS NOT NEW.task_id
    OR OLD.task_entity_home IS NOT NEW.task_entity_home
  BEGIN
    SELECT RAISE(ABORT, 'work artifact task reference is immutable');
  END;

  CREATE TRIGGER IF NOT EXISTS work_task_transitions_home_immutable
  BEFORE UPDATE OF entity_home ON work_task_transitions
  WHEN OLD.entity_home <> NEW.entity_home
  BEGIN
    SELECT RAISE(ABORT, 'work transition home is immutable');
  END;

  CREATE TRIGGER IF NOT EXISTS work_delivery_receipts_home_immutable
  BEFORE UPDATE OF entity_home ON work_delivery_receipts
  WHEN OLD.entity_home <> NEW.entity_home
  BEGIN
    SELECT RAISE(ABORT, 'work delivery receipt home is immutable');
  END;

  CREATE TRIGGER IF NOT EXISTS work_canvas_revision_tasks_insert
    AFTER INSERT ON work_tasks
    BEGIN
      INSERT INTO work_canvas_revisions(canvas_name, revision)
      VALUES (NEW.canvas_name, 1)
      ON CONFLICT(canvas_name) DO UPDATE
        SET revision = work_canvas_revisions.revision + 1;
    END;

  CREATE TRIGGER IF NOT EXISTS work_canvas_revision_tasks_update
    AFTER UPDATE ON work_tasks
    BEGIN
      INSERT INTO work_canvas_revisions(canvas_name, revision)
      VALUES (NEW.canvas_name, 1)
      ON CONFLICT(canvas_name) DO UPDATE
        SET revision = work_canvas_revisions.revision + 1;
    END;

  CREATE TRIGGER IF NOT EXISTS work_canvas_revision_tasks_delete
    AFTER DELETE ON work_tasks
    BEGIN
      INSERT INTO work_canvas_revisions(canvas_name, revision)
      VALUES (OLD.canvas_name, 1)
      ON CONFLICT(canvas_name) DO UPDATE
        SET revision = work_canvas_revisions.revision + 1;
    END;

  CREATE TRIGGER IF NOT EXISTS work_canvas_revision_messages_insert
    AFTER INSERT ON work_messages
    BEGIN
      INSERT INTO work_canvas_revisions(canvas_name, revision)
      VALUES (NEW.canvas_name, 1)
      ON CONFLICT(canvas_name) DO UPDATE
        SET revision = work_canvas_revisions.revision + 1;
    END;

  CREATE TRIGGER IF NOT EXISTS work_canvas_revision_messages_update
    AFTER UPDATE ON work_messages
    BEGIN
      INSERT INTO work_canvas_revisions(canvas_name, revision)
      VALUES (NEW.canvas_name, 1)
      ON CONFLICT(canvas_name) DO UPDATE
        SET revision = work_canvas_revisions.revision + 1;
    END;

  CREATE TRIGGER IF NOT EXISTS work_canvas_revision_messages_delete
    AFTER DELETE ON work_messages
    BEGIN
      INSERT INTO work_canvas_revisions(canvas_name, revision)
      VALUES (OLD.canvas_name, 1)
      ON CONFLICT(canvas_name) DO UPDATE
        SET revision = work_canvas_revisions.revision + 1;
    END;

  CREATE TRIGGER IF NOT EXISTS work_canvas_revision_task_messages_insert
    AFTER INSERT ON work_task_messages
    BEGIN
      INSERT INTO work_canvas_revisions(canvas_name, revision)
      VALUES (NEW.canvas_name, 1)
      ON CONFLICT(canvas_name) DO UPDATE
        SET revision = work_canvas_revisions.revision + 1;
    END;

  CREATE TRIGGER IF NOT EXISTS work_canvas_revision_task_messages_update
    AFTER UPDATE ON work_task_messages
    BEGIN
      INSERT INTO work_canvas_revisions(canvas_name, revision)
      VALUES (NEW.canvas_name, 1)
      ON CONFLICT(canvas_name) DO UPDATE
        SET revision = work_canvas_revisions.revision + 1;
    END;

  CREATE TRIGGER IF NOT EXISTS work_canvas_revision_task_messages_delete
    AFTER DELETE ON work_task_messages
    BEGIN
      INSERT INTO work_canvas_revisions(canvas_name, revision)
      VALUES (OLD.canvas_name, 1)
      ON CONFLICT(canvas_name) DO UPDATE
        SET revision = work_canvas_revisions.revision + 1;
    END;

  CREATE TRIGGER IF NOT EXISTS work_canvas_revision_task_dependencies_insert
    AFTER INSERT ON work_task_dependencies
    BEGIN
      INSERT INTO work_canvas_revisions(canvas_name, revision)
      VALUES (NEW.canvas_name, 1)
      ON CONFLICT(canvas_name) DO UPDATE
        SET revision = work_canvas_revisions.revision + 1;
    END;

  CREATE TRIGGER IF NOT EXISTS work_canvas_revision_task_dependencies_update
    AFTER UPDATE ON work_task_dependencies
    BEGIN
      INSERT INTO work_canvas_revisions(canvas_name, revision)
      VALUES (NEW.canvas_name, 1)
      ON CONFLICT(canvas_name) DO UPDATE
        SET revision = work_canvas_revisions.revision + 1;
    END;

  CREATE TRIGGER IF NOT EXISTS work_canvas_revision_task_dependencies_delete
    AFTER DELETE ON work_task_dependencies
    BEGIN
      INSERT INTO work_canvas_revisions(canvas_name, revision)
      VALUES (OLD.canvas_name, 1)
      ON CONFLICT(canvas_name) DO UPDATE
        SET revision = work_canvas_revisions.revision + 1;
    END;

  CREATE TRIGGER IF NOT EXISTS work_canvas_revision_task_finish_insert
    AFTER INSERT ON work_task_finish
    BEGIN
      INSERT INTO work_canvas_revisions(canvas_name, revision)
      VALUES (NEW.canvas_name, 1)
      ON CONFLICT(canvas_name) DO UPDATE
        SET revision = work_canvas_revisions.revision + 1;
    END;

  CREATE TRIGGER IF NOT EXISTS work_canvas_revision_task_finish_update
    AFTER UPDATE ON work_task_finish
    BEGIN
      INSERT INTO work_canvas_revisions(canvas_name, revision)
      VALUES (NEW.canvas_name, 1)
      ON CONFLICT(canvas_name) DO UPDATE
        SET revision = work_canvas_revisions.revision + 1;
    END;

  CREATE TRIGGER IF NOT EXISTS work_canvas_revision_task_finish_delete
    AFTER DELETE ON work_task_finish
    BEGIN
      INSERT INTO work_canvas_revisions(canvas_name, revision)
      VALUES (OLD.canvas_name, 1)
      ON CONFLICT(canvas_name) DO UPDATE
        SET revision = work_canvas_revisions.revision + 1;
    END;

  CREATE TRIGGER IF NOT EXISTS work_canvas_revision_artifacts_insert
    AFTER INSERT ON work_artifacts
    BEGIN
      INSERT INTO work_canvas_revisions(canvas_name, revision)
      VALUES (NEW.canvas_name, 1)
      ON CONFLICT(canvas_name) DO UPDATE
        SET revision = work_canvas_revisions.revision + 1;
    END;

  CREATE TRIGGER IF NOT EXISTS work_canvas_revision_artifacts_update
    AFTER UPDATE ON work_artifacts
    BEGIN
      INSERT INTO work_canvas_revisions(canvas_name, revision)
      VALUES (NEW.canvas_name, 1)
      ON CONFLICT(canvas_name) DO UPDATE
        SET revision = work_canvas_revisions.revision + 1;
    END;

  CREATE TRIGGER IF NOT EXISTS work_canvas_revision_artifacts_delete
    AFTER DELETE ON work_artifacts
    BEGIN
      INSERT INTO work_canvas_revisions(canvas_name, revision)
      VALUES (OLD.canvas_name, 1)
      ON CONFLICT(canvas_name) DO UPDATE
        SET revision = work_canvas_revisions.revision + 1;
    END;

  CREATE TRIGGER IF NOT EXISTS work_canvas_revision_delivery_receipts_insert
    AFTER INSERT ON work_delivery_receipts
    BEGIN
      INSERT INTO work_canvas_revisions(canvas_name, revision)
      VALUES (NEW.delivered_canvas_name, 1)
      ON CONFLICT(canvas_name) DO UPDATE
        SET revision = work_canvas_revisions.revision + 1;
    END;

  CREATE TRIGGER IF NOT EXISTS work_canvas_revision_delivery_receipts_update
    AFTER UPDATE ON work_delivery_receipts
    BEGIN
      INSERT INTO work_canvas_revisions(canvas_name, revision)
      VALUES (NEW.delivered_canvas_name, 1)
      ON CONFLICT(canvas_name) DO UPDATE
        SET revision = work_canvas_revisions.revision + 1;
    END;

  CREATE TRIGGER IF NOT EXISTS work_canvas_revision_delivery_receipts_delete
    AFTER DELETE ON work_delivery_receipts
    BEGIN
      INSERT INTO work_canvas_revisions(canvas_name, revision)
      VALUES (OLD.delivered_canvas_name, 1)
      ON CONFLICT(canvas_name) DO UPDATE
        SET revision = work_canvas_revisions.revision + 1;
    END;

  CREATE TRIGGER IF NOT EXISTS work_canvas_revision_events_insert
    AFTER INSERT ON work_events
    BEGIN
      INSERT INTO work_canvas_revisions(canvas_name, revision)
      VALUES (NEW.item_canvas_name, 1)
      ON CONFLICT(canvas_name) DO UPDATE
        SET revision = work_canvas_revisions.revision + 1;
    END;

  CREATE TRIGGER IF NOT EXISTS work_events_immutable_delete
  BEFORE DELETE ON work_events
  BEGIN
    SELECT RAISE(ABORT, 'work records are immutable');
  END;

  CREATE TRIGGER IF NOT EXISTS work_events_immutable_update
  BEFORE UPDATE ON work_events
  BEGIN
    SELECT RAISE(ABORT, 'work records are immutable');
  END;

  CREATE TRIGGER IF NOT EXISTS work_facts_immutable_delete
  BEFORE DELETE ON work_facts
  BEGIN
    SELECT RAISE(ABORT, 'work fact records are immutable');
  END;

  CREATE TRIGGER IF NOT EXISTS work_facts_immutable_update
  BEFORE UPDATE ON work_facts
  BEGIN
    SELECT RAISE(ABORT, 'work fact records are immutable');
  END;
`;
