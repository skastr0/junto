/**
 * Exact-current durable Work v2 schema.
 *
 * Every durable record has the full route identity
 * `(event_home, entity_home, seq)`. Both homes reference the Station
 * installation registry; HostId and the retired Command Center sentinel are
 * not representable here. The common envelope and the command/fact/disposition
 * variants are stored separately so record semantics never collapse into an
 * opaque kind plus repository-private JSON.
 */
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
      REFERENCES station_known_installations(installation_id)
      ON DELETE RESTRICT
      ON UPDATE RESTRICT,
    FOREIGN KEY (entity_home)
      REFERENCES station_known_installations(installation_id)
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
    protocol TEXT NOT NULL CHECK (protocol = 'vellum/work/v2'),
    record_type TEXT NOT NULL
      CHECK (record_type IN ('command', 'fact', 'disposition')),
    item_kind TEXT NOT NULL
      CHECK (
        item_kind IN ('task', 'request', 'message', 'artifact', 'delivery')
      ),
    item_id TEXT NOT NULL CHECK (length(item_id) BETWEEN 1 AND 256),
    item_canvas_name TEXT NOT NULL
      CHECK (length(item_canvas_name) BETWEEN 1 AND 256),
    item_node_id TEXT NOT NULL
      CHECK (length(item_node_id) BETWEEN 1 AND 256),
    operation TEXT NOT NULL
      CHECK (
        operation IN (
          'task.create',
          'task.describe',
          'task.transition',
          'task.claim',
          'request.create',
          'request.resolve',
          'message.append',
          'artifact.publish',
          'delivery.accepted'
        )
      ),
    content_sha256 TEXT NOT NULL
      CHECK (
        length(content_sha256) = 64
        AND content_sha256 NOT GLOB '*[^a-f0-9]*'
      ),
    origin_at TEXT NOT NULL CHECK (length(origin_at) BETWEEN 1 AND 64),
    received_at TEXT NOT NULL CHECK (length(received_at) BETWEEN 1 AND 64),
    PRIMARY KEY (event_home, entity_home, seq),
    UNIQUE (event_home, entity_home, seq, record_type),
    UNIQUE (event_home, entity_home, seq, content_sha256),
    FOREIGN KEY (event_home, entity_home)
      REFERENCES work_event_sequences(event_home, entity_home)
      ON DELETE RESTRICT
      ON UPDATE RESTRICT,
    FOREIGN KEY (event_home)
      REFERENCES station_known_installations(installation_id)
      ON DELETE RESTRICT
      ON UPDATE RESTRICT,
    FOREIGN KEY (entity_home)
      REFERENCES station_known_installations(installation_id)
      ON DELETE RESTRICT
      ON UPDATE RESTRICT
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS work_commands (
    event_home TEXT NOT NULL,
    entity_home TEXT NOT NULL,
    seq TEXT NOT NULL,
    record_type TEXT NOT NULL DEFAULT 'command'
      CHECK (record_type = 'command'),
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
    action_json TEXT NOT NULL
      CHECK (
        length(action_json) BETWEEN 2 AND 262144
        AND json_valid(action_json)
      ),
    PRIMARY KEY (event_home, entity_home, seq),
    CHECK (event_home <> entity_home),
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
    PRIMARY KEY (event_home, entity_home, seq),
    CHECK (event_home = entity_home),
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

  CREATE TABLE IF NOT EXISTS work_dispositions (
    event_home TEXT NOT NULL,
    entity_home TEXT NOT NULL,
    seq TEXT NOT NULL,
    record_type TEXT NOT NULL DEFAULT 'disposition'
      CHECK (record_type = 'disposition'),
    status TEXT NOT NULL CHECK (status IN ('applied', 'rejected')),
    command_event_home TEXT NOT NULL,
    command_entity_home TEXT NOT NULL,
    command_seq TEXT NOT NULL,
    command_sha256 TEXT NOT NULL
      CHECK (
        length(command_sha256) = 64
        AND command_sha256 NOT GLOB '*[^a-f0-9]*'
      ),
    fact_event_home TEXT,
    fact_entity_home TEXT,
    fact_seq TEXT,
    fact_sha256 TEXT
      CHECK (
        fact_sha256 IS NULL
        OR (
          length(fact_sha256) = 64
          AND fact_sha256 NOT GLOB '*[^a-f0-9]*'
        )
      ),
    rejection_reason TEXT
      CHECK (
        rejection_reason IS NULL
        OR rejection_reason IN (
          'authority-mismatch',
          'capability-denied',
          'causal-conflict',
          'claim-contention',
          'identity-conflict',
          'invalid-transition',
          'locality-mismatch',
          'missing-entity',
          'projection-conflict',
          'target-mismatch'
        )
      ),
    rejection_message TEXT
      CHECK (
        rejection_message IS NULL
        OR length(rejection_message) BETWEEN 1 AND 2048
      ),
    PRIMARY KEY (event_home, entity_home, seq),
    UNIQUE (event_home, entity_home, seq, status),
    CHECK (event_home = entity_home),
    CHECK (command_entity_home = entity_home),
    CHECK (
      (
        status = 'applied'
        AND fact_event_home IS NOT NULL
        AND fact_entity_home IS NOT NULL
        AND fact_seq IS NOT NULL
        AND fact_sha256 IS NOT NULL
        AND fact_event_home = event_home
        AND fact_entity_home = entity_home
        AND rejection_reason IS NULL
        AND rejection_message IS NULL
      )
      OR
      (
        status = 'rejected'
        AND fact_event_home IS NULL
        AND fact_entity_home IS NULL
        AND fact_seq IS NULL
        AND fact_sha256 IS NULL
        AND rejection_reason IS NOT NULL
        AND rejection_message IS NOT NULL
      )
    ),
    FOREIGN KEY (event_home, entity_home, seq, record_type)
      REFERENCES work_events(event_home, entity_home, seq, record_type)
      ON DELETE RESTRICT
      ON UPDATE RESTRICT,
    FOREIGN KEY (command_event_home, command_entity_home, command_seq)
      REFERENCES work_commands(event_home, entity_home, seq)
      ON DELETE RESTRICT
      ON UPDATE RESTRICT,
    FOREIGN KEY (
      command_event_home,
      command_entity_home,
      command_seq,
      command_sha256
    ) REFERENCES work_events(event_home, entity_home, seq, content_sha256)
      ON DELETE RESTRICT
      ON UPDATE RESTRICT,
    FOREIGN KEY (fact_event_home, fact_entity_home, fact_seq)
      REFERENCES work_facts(event_home, entity_home, seq)
      ON DELETE RESTRICT
      ON UPDATE RESTRICT,
    FOREIGN KEY (
      fact_event_home,
      fact_entity_home,
      fact_seq,
      fact_sha256
    ) REFERENCES work_events(event_home, entity_home, seq, content_sha256)
      ON DELETE RESTRICT
      ON UPDATE RESTRICT
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS work_pending_commands (
    event_home TEXT NOT NULL,
    entity_home TEXT NOT NULL,
    seq TEXT NOT NULL,
    operation TEXT NOT NULL
      CHECK (
        operation IN (
          'task.create',
          'task.describe',
          'task.transition',
          'task.claim',
          'request.create',
          'request.resolve',
          'message.append',
          'artifact.publish',
          'delivery.accepted'
        )
      ),
    item_kind TEXT NOT NULL
      CHECK (
        item_kind IN ('task', 'request', 'message', 'artifact', 'delivery')
      ),
    item_canvas_name TEXT NOT NULL
      CHECK (length(item_canvas_name) BETWEEN 1 AND 256),
    item_node_id TEXT NOT NULL
      CHECK (length(item_node_id) BETWEEN 1 AND 256),
    item_id TEXT NOT NULL CHECK (length(item_id) BETWEEN 1 AND 256),
    claim_actor_seat_id TEXT
      CHECK (
        claim_actor_seat_id IS NULL
        OR (
          length(claim_actor_seat_id) = 69
          AND substr(claim_actor_seat_id, 1, 5) = 'seat_'
          AND substr(claim_actor_seat_id, 6) NOT GLOB '*[^a-f0-9]*'
        )
      ),
    resolution_status TEXT
      CHECK (
        resolution_status IS NULL
        OR resolution_status IN ('applied', 'rejected')
      ),
    resolution_event_home TEXT,
    resolution_entity_home TEXT,
    resolution_seq TEXT,
    created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 1 AND 64),
    resolved_at TEXT
      CHECK (resolved_at IS NULL OR length(resolved_at) BETWEEN 1 AND 64),
    PRIMARY KEY (event_home, entity_home, seq),
    CHECK (
      (
        operation = 'task.claim'
        AND item_kind = 'task'
        AND claim_actor_seat_id IS NOT NULL
      )
      OR
      (
        operation <> 'task.claim'
        AND claim_actor_seat_id IS NULL
      )
    ),
    CHECK (
      (
        resolution_status IS NULL
        AND resolution_event_home IS NULL
        AND resolution_entity_home IS NULL
        AND resolution_seq IS NULL
        AND resolved_at IS NULL
      )
      OR
      (
        resolution_status IS NOT NULL
        AND resolution_event_home IS NOT NULL
        AND resolution_entity_home IS NOT NULL
        AND resolution_seq IS NOT NULL
        AND resolved_at IS NOT NULL
      )
    ),
    FOREIGN KEY (event_home, entity_home, seq)
      REFERENCES work_commands(event_home, entity_home, seq)
      ON DELETE RESTRICT
      ON UPDATE RESTRICT,
    FOREIGN KEY (
      resolution_event_home,
      resolution_entity_home,
      resolution_seq,
      resolution_status
    ) REFERENCES work_dispositions(event_home, entity_home, seq, status)
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
          'rejected'
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
    UNIQUE (fact_event_home, fact_entity_home, fact_seq),
    CHECK (entity_home = fact_entity_home),
    CHECK (fact_event_home = fact_entity_home),
    CHECK (
      (state = 'submitted' AND actor_seat_id IS NULL)
      OR state IN ('completed', 'canceled', 'failed', 'rejected')
      OR (
        state IN ('working', 'input-required', 'auth-required')
        AND actor_seat_id IS NOT NULL
      )
    ),
    FOREIGN KEY (entity_home)
      REFERENCES station_known_installations(installation_id)
      ON DELETE RESTRICT
      ON UPDATE RESTRICT,
    FOREIGN KEY (fact_event_home, fact_entity_home, fact_seq)
      REFERENCES work_facts(event_home, entity_home, seq)
      ON DELETE RESTRICT
      ON UPDATE RESTRICT
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS work_requests (
    canvas_name TEXT NOT NULL CHECK (length(canvas_name) BETWEEN 1 AND 256),
    node_id TEXT NOT NULL CHECK (length(node_id) BETWEEN 1 AND 256),
    request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 1 AND 256),
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
    state TEXT NOT NULL
      CHECK (
        state IN (
          'input-required',
          'auth-required',
          'completed',
          'rejected'
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
    PRIMARY KEY (canvas_name, node_id, request_id),
    UNIQUE (fact_event_home, fact_entity_home, fact_seq),
    CHECK (entity_home = fact_entity_home),
    CHECK (fact_event_home = fact_entity_home),
    FOREIGN KEY (entity_home)
      REFERENCES station_known_installations(installation_id)
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
    parent_lane TEXT NOT NULL CHECK (parent_lane IN ('task', 'request')),
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
      REFERENCES station_known_installations(installation_id)
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
      REFERENCES station_known_installations(installation_id)
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
    task_id TEXT,
    metadata_json TEXT
      CHECK (metadata_json IS NULL OR json_valid(metadata_json)),
    origin_at TEXT NOT NULL CHECK (length(origin_at) BETWEEN 1 AND 64),
    received_at TEXT NOT NULL CHECK (length(received_at) BETWEEN 1 AND 64),
    PRIMARY KEY (canvas_name, node_id, artifact_id),
    UNIQUE (fact_event_home, fact_entity_home, fact_seq),
    CHECK (entity_home = fact_entity_home),
    CHECK (fact_event_home = fact_entity_home),
    FOREIGN KEY (entity_home)
      REFERENCES station_known_installations(installation_id)
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
    lane TEXT NOT NULL CHECK (lane IN ('task', 'request')),
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
          'task.claim',
          'request.create',
          'request.resolve'
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
          'rejected'
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
        'rejected'
      )
    ),
    CHECK (
      to_state NOT IN ('working', 'input-required', 'auth-required')
      OR actor_seat_id IS NOT NULL
    ),
    CHECK (entity_home = fact_entity_home),
    CHECK (fact_event_home = fact_entity_home),
    FOREIGN KEY (entity_home)
      REFERENCES station_known_installations(installation_id)
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
      REFERENCES station_known_installations(installation_id)
      ON DELETE RESTRICT
      ON UPDATE RESTRICT,
    FOREIGN KEY (fact_event_home, fact_entity_home, fact_seq)
      REFERENCES work_facts(event_home, entity_home, seq)
      ON DELETE RESTRICT
      ON UPDATE RESTRICT
  ) STRICT, WITHOUT ROWID;

  CREATE INDEX IF NOT EXISTS work_events_route_order
    ON work_events(event_home, entity_home, length(seq), seq);
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
  CREATE INDEX IF NOT EXISTS work_pending_commands_route
    ON work_pending_commands(
      event_home,
      entity_home,
      length(seq),
      seq
    )
    WHERE resolution_event_home IS NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS work_pending_task_claim_item
    ON work_pending_commands(
      item_canvas_name,
      item_node_id,
      item_id
    )
    WHERE
      operation = 'task.claim'
      AND resolution_event_home IS NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS work_pending_task_claim_actor
    ON work_pending_commands(claim_actor_seat_id)
    WHERE
      operation = 'task.claim'
      AND resolution_event_home IS NULL;
  CREATE INDEX IF NOT EXISTS work_tasks_node
    ON work_tasks(canvas_name, node_id, created_at, task_id);
  CREATE UNIQUE INDEX IF NOT EXISTS work_tasks_one_active_per_actor
    ON work_tasks(actor_seat_id)
    WHERE
      actor_seat_id IS NOT NULL
      AND state IN ('working', 'input-required', 'auth-required');
  CREATE INDEX IF NOT EXISTS work_requests_node
    ON work_requests(canvas_name, node_id, created_at, request_id);
  CREATE INDEX IF NOT EXISTS work_task_messages_thread
    ON work_task_messages(
      canvas_name,
      node_id,
      parent_lane,
      item_id,
      position
    );
  CREATE INDEX IF NOT EXISTS work_messages_inbox
    ON work_messages(canvas_name, node_id, position);
  CREATE INDEX IF NOT EXISTS work_artifacts_node
    ON work_artifacts(canvas_name, node_id, artifact_id);
  CREATE INDEX IF NOT EXISTS work_delivery_receipts_actor
    ON work_delivery_receipts(
      actor_seat_id,
      accepted_at,
      delivery_id
    );

  CREATE TRIGGER IF NOT EXISTS work_events_immutable_update
  BEFORE UPDATE ON work_events
  BEGIN
    SELECT RAISE(ABORT, 'work records are immutable');
  END;

  CREATE TRIGGER IF NOT EXISTS work_events_immutable_delete
  BEFORE DELETE ON work_events
  BEGIN
    SELECT RAISE(ABORT, 'work records are immutable');
  END;

  CREATE TRIGGER IF NOT EXISTS work_commands_immutable_update
  BEFORE UPDATE ON work_commands
  BEGIN
    SELECT RAISE(ABORT, 'work command records are immutable');
  END;

  CREATE TRIGGER IF NOT EXISTS work_commands_immutable_delete
  BEFORE DELETE ON work_commands
  BEGIN
    SELECT RAISE(ABORT, 'work command records are immutable');
  END;

  CREATE TRIGGER IF NOT EXISTS work_facts_immutable_update
  BEFORE UPDATE ON work_facts
  BEGIN
    SELECT RAISE(ABORT, 'work fact records are immutable');
  END;

  CREATE TRIGGER IF NOT EXISTS work_facts_immutable_delete
  BEFORE DELETE ON work_facts
  BEGIN
    SELECT RAISE(ABORT, 'work fact records are immutable');
  END;

  CREATE TRIGGER IF NOT EXISTS work_dispositions_immutable_update
  BEFORE UPDATE ON work_dispositions
  BEGIN
    SELECT RAISE(ABORT, 'work disposition records are immutable');
  END;

  CREATE TRIGGER IF NOT EXISTS work_dispositions_immutable_delete
  BEFORE DELETE ON work_dispositions
  BEGIN
    SELECT RAISE(ABORT, 'work disposition records are immutable');
  END;

  CREATE TRIGGER IF NOT EXISTS work_pending_command_matches_record
  BEFORE INSERT ON work_pending_commands
  WHEN NOT EXISTS (
    SELECT 1
    FROM work_events AS record
    WHERE record.event_home = NEW.event_home
      AND record.entity_home = NEW.entity_home
      AND record.seq = NEW.seq
      AND record.record_type = 'command'
      AND record.operation = NEW.operation
      AND record.item_kind = NEW.item_kind
      AND record.item_canvas_name = NEW.item_canvas_name
      AND record.item_node_id = NEW.item_node_id
      AND record.item_id = NEW.item_id
  )
  BEGIN
    SELECT RAISE(ABORT, 'pending command metadata must match its Work command');
  END;

  CREATE TRIGGER IF NOT EXISTS work_pending_command_identity_immutable
  BEFORE UPDATE OF
    event_home,
    entity_home,
    seq,
    operation,
    item_kind,
    item_canvas_name,
    item_node_id,
    item_id,
    claim_actor_seat_id
  ON work_pending_commands
  WHEN
    OLD.event_home IS NOT NEW.event_home
    OR OLD.entity_home IS NOT NEW.entity_home
    OR OLD.seq IS NOT NEW.seq
    OR OLD.operation IS NOT NEW.operation
    OR OLD.item_kind IS NOT NEW.item_kind
    OR OLD.item_canvas_name IS NOT NEW.item_canvas_name
    OR OLD.item_node_id IS NOT NEW.item_node_id
    OR OLD.item_id IS NOT NEW.item_id
    OR OLD.claim_actor_seat_id IS NOT NEW.claim_actor_seat_id
  BEGIN
    SELECT RAISE(ABORT, 'pending command identity is immutable');
  END;

  CREATE TRIGGER IF NOT EXISTS work_pending_command_initial_resolution_matches
  BEFORE INSERT ON work_pending_commands
  WHEN
    NEW.resolution_event_home IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM work_dispositions AS disposition
      WHERE disposition.event_home = NEW.resolution_event_home
        AND disposition.entity_home = NEW.resolution_entity_home
        AND disposition.seq = NEW.resolution_seq
        AND disposition.status = NEW.resolution_status
        AND disposition.command_event_home = NEW.event_home
        AND disposition.command_entity_home = NEW.entity_home
        AND disposition.command_seq = NEW.seq
    )
  BEGIN
    SELECT RAISE(
      ABORT,
      'pending command resolution must reference its causal disposition'
    );
  END;

  CREATE TRIGGER IF NOT EXISTS work_pending_command_resolution_matches
  BEFORE UPDATE OF
    resolution_status,
    resolution_event_home,
    resolution_entity_home,
    resolution_seq,
    resolved_at
  ON work_pending_commands
  WHEN
    NEW.resolution_event_home IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM work_dispositions AS disposition
      WHERE disposition.event_home = NEW.resolution_event_home
        AND disposition.entity_home = NEW.resolution_entity_home
        AND disposition.seq = NEW.resolution_seq
        AND disposition.status = NEW.resolution_status
        AND disposition.command_event_home = OLD.event_home
        AND disposition.command_entity_home = OLD.entity_home
        AND disposition.command_seq = OLD.seq
    )
  BEGIN
    SELECT RAISE(
      ABORT,
      'pending command resolution must reference its causal disposition'
    );
  END;

  CREATE TRIGGER IF NOT EXISTS work_pending_command_resolution_once
  BEFORE UPDATE OF
    resolution_status,
    resolution_event_home,
    resolution_entity_home,
    resolution_seq,
    resolved_at
  ON work_pending_commands
  WHEN
    OLD.resolution_event_home IS NOT NULL
    AND (
      OLD.resolution_status IS NOT NEW.resolution_status
      OR OLD.resolution_event_home IS NOT NEW.resolution_event_home
      OR OLD.resolution_entity_home IS NOT NEW.resolution_entity_home
      OR OLD.resolution_seq IS NOT NEW.resolution_seq
      OR OLD.resolved_at IS NOT NEW.resolved_at
    )
  BEGIN
    SELECT RAISE(ABORT, 'pending command resolution is immutable');
  END;

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
  BEGIN
    SELECT RAISE(ABORT, 'work task actor seat is immutable after first claim');
  END;

  CREATE TRIGGER IF NOT EXISTS work_requests_home_immutable
  BEFORE UPDATE OF entity_home ON work_requests
  WHEN OLD.entity_home <> NEW.entity_home
  BEGIN
    SELECT RAISE(ABORT, 'work request home is immutable');
  END;

  CREATE TRIGGER IF NOT EXISTS work_requests_actor_immutable
  BEFORE UPDATE OF actor_seat_id ON work_requests
  WHEN OLD.actor_seat_id <> NEW.actor_seat_id
  BEGIN
    SELECT RAISE(ABORT, 'work request actor seat is immutable');
  END;

  CREATE TRIGGER IF NOT EXISTS work_task_messages_home_immutable
  BEFORE UPDATE OF entity_home ON work_task_messages
  WHEN OLD.entity_home <> NEW.entity_home
  BEGIN
    SELECT RAISE(ABORT, 'work task message home is immutable');
  END;

  CREATE TRIGGER IF NOT EXISTS work_messages_home_immutable
  BEFORE UPDATE OF entity_home ON work_messages
  WHEN OLD.entity_home <> NEW.entity_home
  BEGIN
    SELECT RAISE(ABORT, 'work message home is immutable');
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
`;
