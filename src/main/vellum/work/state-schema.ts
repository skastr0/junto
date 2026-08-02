export const WORK_PROPOSAL_STATE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS work_proposal_events (
    event_home TEXT NOT NULL,
    entity_home TEXT NOT NULL,
    seq TEXT NOT NULL
      CHECK (
        length(seq) BETWEEN 1 AND 32
        AND seq NOT GLOB '*[^0-9]*'
        AND substr(seq, 1, 1) <> '0'
      ),
    record_type TEXT NOT NULL
      CHECK (record_type IN ('command', 'fact', 'disposition')),
    canvas_name TEXT NOT NULL CHECK (length(canvas_name) BETWEEN 1 AND 256),
    node_id TEXT NOT NULL CHECK (length(node_id) BETWEEN 1 AND 256),
    proposal_id TEXT NOT NULL CHECK (length(proposal_id) BETWEEN 1 AND 256),
    operation TEXT NOT NULL
      CHECK (operation IN ('proposal.create', 'proposal.approve')),
    content_sha256 TEXT NOT NULL
      CHECK (
        length(content_sha256) = 64
        AND content_sha256 NOT GLOB '*[^a-f0-9]*'
      ),
    record_json TEXT NOT NULL
      CHECK (
        length(record_json) BETWEEN 2 AND 262144
        AND json_valid(record_json)
      ),
    origin_at TEXT NOT NULL CHECK (length(origin_at) BETWEEN 1 AND 64),
    received_at TEXT NOT NULL CHECK (length(received_at) BETWEEN 1 AND 64),
    PRIMARY KEY (event_home, entity_home, seq),
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

  CREATE TABLE IF NOT EXISTS work_pending_proposal_commands (
    event_home TEXT NOT NULL,
    entity_home TEXT NOT NULL,
    seq TEXT NOT NULL,
    canvas_name TEXT NOT NULL,
    node_id TEXT NOT NULL,
    proposal_id TEXT NOT NULL,
    operation TEXT NOT NULL
      CHECK (operation IN ('proposal.create', 'proposal.approve')),
    resolution_status TEXT
      CHECK (
        resolution_status IS NULL
        OR resolution_status IN ('applied', 'rejected')
      ),
    resolution_event_home TEXT,
    resolution_entity_home TEXT,
    resolution_seq TEXT,
    created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 1 AND 64),
    resolved_at TEXT,
    PRIMARY KEY (event_home, entity_home, seq),
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
      REFERENCES work_proposal_events(event_home, entity_home, seq)
      ON DELETE RESTRICT
      ON UPDATE RESTRICT
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS work_task_proposals (
    canvas_name TEXT NOT NULL CHECK (length(canvas_name) BETWEEN 1 AND 256),
    node_id TEXT NOT NULL CHECK (length(node_id) BETWEEN 1 AND 256),
    proposal_id TEXT NOT NULL CHECK (length(proposal_id) BETWEEN 1 AND 256),
    entity_home TEXT NOT NULL,
    fact_event_home TEXT NOT NULL,
    fact_entity_home TEXT NOT NULL,
    fact_seq TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'rejected')),
    brief_json TEXT NOT NULL CHECK (json_valid(brief_json)),
    proposer_seat_id TEXT NOT NULL
      CHECK (
        length(proposer_seat_id) = 69
        AND substr(proposer_seat_id, 1, 5) = 'seat_'
        AND substr(proposer_seat_id, 6) NOT GLOB '*[^a-f0-9]*'
      ),
    proposer_canvas_name TEXT NOT NULL
      CHECK (length(proposer_canvas_name) BETWEEN 1 AND 256),
    proposer_node_id TEXT NOT NULL
      CHECK (length(proposer_node_id) BETWEEN 1 AND 256),
    approved_task_id TEXT,
    metadata_json TEXT CHECK (metadata_json IS NULL OR json_valid(metadata_json)),
    reason TEXT,
    created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 1 AND 64),
    updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 1 AND 64),
    origin_at TEXT NOT NULL CHECK (length(origin_at) BETWEEN 1 AND 64),
    received_at TEXT NOT NULL CHECK (length(received_at) BETWEEN 1 AND 64),
    PRIMARY KEY (canvas_name, node_id, proposal_id),
    UNIQUE (fact_event_home, fact_entity_home, fact_seq),
    CHECK (entity_home = fact_entity_home),
    CHECK (fact_event_home = fact_entity_home),
    CHECK (
      (state = 'approved' AND approved_task_id IS NOT NULL)
      OR (state <> 'approved' AND approved_task_id IS NULL)
    ),
    FOREIGN KEY (entity_home)
      REFERENCES station_known_installations(installation_id)
      ON DELETE RESTRICT
      ON UPDATE RESTRICT,
    FOREIGN KEY (fact_event_home, fact_entity_home, fact_seq)
      REFERENCES work_proposal_events(event_home, entity_home, seq)
      ON DELETE RESTRICT
      ON UPDATE RESTRICT
  ) STRICT, WITHOUT ROWID;

  CREATE INDEX IF NOT EXISTS work_task_proposals_node
    ON work_task_proposals(canvas_name, node_id, created_at, proposal_id);
  CREATE INDEX IF NOT EXISTS work_pending_proposal_commands_route
    ON work_pending_proposal_commands(
      event_home,
      entity_home,
      length(seq),
      seq
    )
    WHERE resolution_event_home IS NULL;

  CREATE TRIGGER IF NOT EXISTS work_proposal_events_immutable_update
  BEFORE UPDATE ON work_proposal_events
  BEGIN
    SELECT RAISE(ABORT, 'proposal records are immutable');
  END;
  CREATE TRIGGER IF NOT EXISTS work_proposal_events_immutable_delete
  BEFORE DELETE ON work_proposal_events
  BEGIN
    SELECT RAISE(ABORT, 'proposal records are immutable');
  END;
  CREATE TRIGGER IF NOT EXISTS work_task_proposals_home_immutable
  BEFORE UPDATE OF entity_home ON work_task_proposals
  WHEN OLD.entity_home <> NEW.entity_home
  BEGIN
    SELECT RAISE(ABORT, 'task proposal home is immutable');
  END;
  CREATE TRIGGER IF NOT EXISTS work_task_proposals_proposer_immutable
  BEFORE UPDATE OF proposer_seat_id, proposer_canvas_name, proposer_node_id
  ON work_task_proposals
  WHEN
    OLD.proposer_seat_id <> NEW.proposer_seat_id
    OR OLD.proposer_canvas_name <> NEW.proposer_canvas_name
    OR OLD.proposer_node_id <> NEW.proposer_node_id
  BEGIN
    SELECT RAISE(ABORT, 'task proposal author is immutable');
  END;
`;

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
    basis_kind TEXT NOT NULL
      CHECK (
        basis_kind IN (
          'authorial-intent',
          'projected-intent',
          'command'
        )
      ),
    basis_authorial_generation TEXT
      CHECK (
        basis_authorial_generation IS NULL
        OR (
          length(basis_authorial_generation) BETWEEN 1 AND 32
          AND basis_authorial_generation NOT GLOB '*[^0-9]*'
          AND (
            basis_authorial_generation = '0'
            OR substr(basis_authorial_generation, 1, 1) <> '0'
          )
        )
      ),
    basis_authorial_content_sha256 TEXT
      CHECK (
        basis_authorial_content_sha256 IS NULL
        OR (
          length(basis_authorial_content_sha256) = 64
          AND basis_authorial_content_sha256 NOT GLOB '*[^a-f0-9]*'
        )
      ),
    basis_projected_generation TEXT
      CHECK (
        basis_projected_generation IS NULL
        OR (
          length(basis_projected_generation) BETWEEN 1 AND 32
          AND basis_projected_generation NOT GLOB '*[^0-9]*'
          AND (
            basis_projected_generation = '0'
            OR substr(basis_projected_generation, 1, 1) <> '0'
          )
        )
      ),
    basis_projected_content_sha256 TEXT
      CHECK (
        basis_projected_content_sha256 IS NULL
        OR (
          length(basis_projected_content_sha256) = 64
          AND basis_projected_content_sha256 NOT GLOB '*[^a-f0-9]*'
        )
      ),
    basis_command_event_home TEXT,
    basis_command_entity_home TEXT,
    basis_command_seq TEXT
      CHECK (
        basis_command_seq IS NULL
        OR (
          length(basis_command_seq) BETWEEN 1 AND 32
          AND basis_command_seq NOT GLOB '*[^0-9]*'
          AND substr(basis_command_seq, 1, 1) <> '0'
        )
      ),
    basis_command_sha256 TEXT
      CHECK (
        basis_command_sha256 IS NULL
        OR (
          length(basis_command_sha256) = 64
          AND basis_command_sha256 NOT GLOB '*[^a-f0-9]*'
        )
      ),
    PRIMARY KEY (event_home, entity_home, seq),
    CHECK (event_home = entity_home),
    CHECK (
      (
        basis_kind = 'authorial-intent'
        AND basis_authorial_generation IS NOT NULL
        AND basis_authorial_content_sha256 IS NOT NULL
        AND basis_projected_generation IS NULL
        AND basis_projected_content_sha256 IS NULL
        AND basis_command_event_home IS NULL
        AND basis_command_entity_home IS NULL
        AND basis_command_seq IS NULL
        AND basis_command_sha256 IS NULL
      )
      OR
      (
        basis_kind = 'projected-intent'
        AND basis_authorial_generation IS NULL
        AND basis_authorial_content_sha256 IS NULL
        AND basis_projected_generation IS NOT NULL
        AND basis_projected_content_sha256 IS NOT NULL
        AND basis_command_event_home IS NULL
        AND basis_command_entity_home IS NULL
        AND basis_command_seq IS NULL
        AND basis_command_sha256 IS NULL
      )
      OR
      (
        basis_kind = 'command'
        AND basis_authorial_generation IS NULL
        AND basis_authorial_content_sha256 IS NULL
        AND basis_projected_generation IS NULL
        AND basis_projected_content_sha256 IS NULL
        AND basis_command_event_home IS NOT NULL
        AND basis_command_entity_home IS NOT NULL
        AND basis_command_seq IS NOT NULL
        AND basis_command_sha256 IS NOT NULL
        AND basis_command_entity_home = entity_home
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
      ON UPDATE RESTRICT,
    FOREIGN KEY (basis_authorial_generation)
      REFERENCES canvas_generations(generation)
      ON DELETE RESTRICT
      ON UPDATE RESTRICT,
    FOREIGN KEY (
      basis_projected_generation,
      basis_projected_content_sha256
    ) REFERENCES station_projection_versions(generation, content_sha256)
      ON DELETE RESTRICT
      ON UPDATE RESTRICT,
    FOREIGN KEY (
      basis_command_event_home,
      basis_command_entity_home,
      basis_command_seq
    ) REFERENCES work_commands(event_home, entity_home, seq)
      ON DELETE RESTRICT
      ON UPDATE RESTRICT,
    FOREIGN KEY (
      basis_command_event_home,
      basis_command_entity_home,
      basis_command_seq,
      basis_command_sha256
    ) REFERENCES work_events(
      event_home,
      entity_home,
      seq,
      content_sha256
    )
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
    UNIQUE (canvas_name, node_id, task_id, entity_home),
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
      REFERENCES station_known_installations(installation_id)
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
  CREATE UNIQUE INDEX IF NOT EXISTS work_task_messages_sink_identity
    ON work_task_messages(canvas_name, node_id, message_id);
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

  CREATE TRIGGER IF NOT EXISTS work_fact_authorial_basis_resolves
  BEFORE INSERT ON work_facts
  WHEN
    NEW.basis_kind = 'authorial-intent'
    AND NOT EXISTS (
      SELECT 1
      FROM canvas_generations AS generation
      JOIN canvas_generation_documents AS document
        ON document.generation = generation.generation
      JOIN work_events AS record
        ON record.event_home = NEW.event_home
        AND record.entity_home = NEW.entity_home
        AND record.seq = NEW.seq
      WHERE generation.generation = NEW.basis_authorial_generation
        AND generation.intent_sha256 =
          NEW.basis_authorial_content_sha256
        AND document.name = record.item_canvas_name
    )
  BEGIN
    SELECT RAISE(
      ABORT,
      'authorial fact basis must resolve its exact sink canvas generation'
    );
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

  CREATE TRIGGER IF NOT EXISTS work_applied_disposition_fact_basis_matches
  BEFORE INSERT ON work_dispositions
  WHEN
    NEW.status = 'applied'
    AND NOT EXISTS (
      SELECT 1
      FROM work_facts AS fact
      WHERE fact.event_home = NEW.fact_event_home
        AND fact.entity_home = NEW.fact_entity_home
        AND fact.seq = NEW.fact_seq
        AND fact.basis_kind = 'command'
        AND fact.basis_command_event_home = NEW.command_event_home
        AND fact.basis_command_entity_home = NEW.command_entity_home
        AND fact.basis_command_seq = NEW.command_seq
        AND fact.basis_command_sha256 = NEW.command_sha256
    )
  BEGIN
    SELECT RAISE(
      ABORT,
      'applied disposition fact must carry its exact command basis'
    );
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
    OR
    (
      NEW.parent_lane = 'request'
      AND EXISTS (
        SELECT 1
        FROM work_requests
        WHERE canvas_name = NEW.canvas_name
          AND node_id = NEW.node_id
          AND request_id = NEW.item_id
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
  ${WORK_PROPOSAL_STATE_SCHEMA_SQL}
`;

/**
 * Same-sink hard task prerequisites (expand-only side table).
 * Does not alter work_tasks columns so historical schema witnesses stay frozen.
 * Empty set ⇒ no rows; claim readiness is derived in shared/task-deps.
 */
export const WORK_TASK_DEPENDENCIES_STATE_SCHEMA_SQL = `
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

  CREATE INDEX IF NOT EXISTS work_task_dependencies_dep
    ON work_task_dependencies(canvas_name, node_id, depends_on_task_id);
`;

/**
 * Finish criteria + completion evidence (expand-only side table).
 * Kept off work_tasks CREATE so v1–v7 historical witnesses stay frozen.
 */
export const WORK_TASK_FINISH_STATE_SCHEMA_SQL = `
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
`;

/**
 * Planning arms on proposals (dependsOn + finishCriteria). Expand-only side
 * table so work_task_proposals CREATE (v5 witness) stays frozen. Media lives
 * on brief_json already.
 */
export const WORK_PROPOSAL_PLANNING_STATE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS work_proposal_planning (
    canvas_name TEXT NOT NULL CHECK (length(canvas_name) BETWEEN 1 AND 256),
    node_id TEXT NOT NULL CHECK (length(node_id) BETWEEN 1 AND 256),
    proposal_id TEXT NOT NULL CHECK (length(proposal_id) BETWEEN 1 AND 256),
    depends_on_json TEXT
      CHECK (depends_on_json IS NULL OR json_valid(depends_on_json)),
    finish_criteria_json TEXT
      CHECK (finish_criteria_json IS NULL OR json_valid(finish_criteria_json)),
    PRIMARY KEY (canvas_name, node_id, proposal_id),
    FOREIGN KEY (canvas_name, node_id, proposal_id)
      REFERENCES work_task_proposals(canvas_name, node_id, proposal_id)
      ON DELETE CASCADE
      ON UPDATE RESTRICT
  ) STRICT, WITHOUT ROWID;
`;

/**
 * Bulletin board sink (expand-only). Command Center-homed global sink —
 * mailbox residency: material rows only on CC; Remotes enqueue
 * board.topic.create / board.post.append and keep event/disposition only
 * (no second material replica).
 */
export const WORK_BOARD_STATE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS work_board_topics (
    canvas_name TEXT NOT NULL CHECK (length(canvas_name) BETWEEN 1 AND 256),
    node_id TEXT NOT NULL CHECK (length(node_id) BETWEEN 1 AND 256),
    topic_id TEXT NOT NULL CHECK (length(topic_id) BETWEEN 1 AND 256),
    title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 512),
    state TEXT NOT NULL CHECK (state IN ('open', 'archived')),
    author_kind TEXT NOT NULL CHECK (author_kind IN ('operator', 'actor')),
    author_seat_id TEXT
      CHECK (
        author_seat_id IS NULL
        OR (
          length(author_seat_id) = 69
          AND substr(author_seat_id, 1, 5) = 'seat_'
          AND substr(author_seat_id, 6) NOT GLOB '*[^a-f0-9]*'
        )
      ),
    author_node_id TEXT
      CHECK (author_node_id IS NULL OR length(author_node_id) BETWEEN 1 AND 256),
    author_label TEXT
      CHECK (author_label IS NULL OR length(author_label) BETWEEN 1 AND 256),
    parts_json TEXT NOT NULL CHECK (json_valid(parts_json)),
    post_count INTEGER NOT NULL DEFAULT 0 CHECK (post_count >= 0),
    last_activity_at TEXT NOT NULL CHECK (length(last_activity_at) BETWEEN 1 AND 64),
    created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 1 AND 64),
    updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 1 AND 64),
    PRIMARY KEY (canvas_name, node_id, topic_id)
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS work_board_posts (
    canvas_name TEXT NOT NULL CHECK (length(canvas_name) BETWEEN 1 AND 256),
    node_id TEXT NOT NULL CHECK (length(node_id) BETWEEN 1 AND 256),
    topic_id TEXT NOT NULL CHECK (length(topic_id) BETWEEN 1 AND 256),
    post_id TEXT NOT NULL CHECK (length(post_id) BETWEEN 1 AND 256),
    position INTEGER NOT NULL CHECK (position >= 0),
    author_kind TEXT NOT NULL CHECK (author_kind IN ('operator', 'actor')),
    author_seat_id TEXT
      CHECK (
        author_seat_id IS NULL
        OR (
          length(author_seat_id) = 69
          AND substr(author_seat_id, 1, 5) = 'seat_'
          AND substr(author_seat_id, 6) NOT GLOB '*[^a-f0-9]*'
        )
      ),
    author_node_id TEXT
      CHECK (author_node_id IS NULL OR length(author_node_id) BETWEEN 1 AND 256),
    author_label TEXT
      CHECK (author_label IS NULL OR length(author_label) BETWEEN 1 AND 256),
    parts_json TEXT NOT NULL CHECK (json_valid(parts_json)),
    created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 1 AND 64),
    PRIMARY KEY (canvas_name, node_id, topic_id, post_id),
    UNIQUE (canvas_name, node_id, topic_id, position),
    FOREIGN KEY (canvas_name, node_id, topic_id)
      REFERENCES work_board_topics(canvas_name, node_id, topic_id)
      ON DELETE RESTRICT
      ON UPDATE RESTRICT
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS work_board_read_cursors (
    canvas_name TEXT NOT NULL CHECK (length(canvas_name) BETWEEN 1 AND 256),
    node_id TEXT NOT NULL CHECK (length(node_id) BETWEEN 1 AND 256),
    topic_id TEXT NOT NULL CHECK (length(topic_id) BETWEEN 1 AND 256),
    principal_key TEXT NOT NULL CHECK (length(principal_key) BETWEEN 1 AND 256),
    last_read_position INTEGER NOT NULL CHECK (last_read_position >= -1),
    updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 1 AND 64),
    PRIMARY KEY (canvas_name, node_id, topic_id, principal_key)
  ) STRICT, WITHOUT ROWID;

  CREATE INDEX IF NOT EXISTS work_board_topics_node
    ON work_board_topics(canvas_name, node_id, last_activity_at, topic_id);
  CREATE INDEX IF NOT EXISTS work_board_posts_thread
    ON work_board_posts(canvas_name, node_id, topic_id, position);
`;

/**
 * Work schema with board event vocabulary (topic/post kinds + board ops).
 * Used only at CURRENT composition so V5–V9 frozen identities stay immutable.
 */
export const WORK_STATE_SCHEMA_BOARD_VOCAB_SQL = WORK_STATE_SCHEMA_SQL
  .replaceAll(
    "item_kind IN ('task', 'request', 'message', 'artifact', 'delivery')",
    "item_kind IN ('task', 'request', 'message', 'artifact', 'delivery', 'topic', 'post')",
  )
  .replaceAll(
    `'delivery.accepted'
        )`,
    `'delivery.accepted',
          'board.topic.create',
          'board.post.append'
        )`,
  );

/**
 * Board vocab + proposal.reject on work_proposal_events /
 * work_pending_proposal_commands. V5–V13 keep create/approve-only CHECKs.
 */
export const WORK_STATE_SCHEMA_PROPOSAL_REJECT_SQL =
  WORK_STATE_SCHEMA_BOARD_VOCAB_SQL.replaceAll(
    "operation IN ('proposal.create', 'proposal.approve')",
    "operation IN ('proposal.create', 'proposal.approve', 'proposal.reject')",
  );

/**
 * V14 + task `archived` soft-delete state on work_tasks and
 * work_task_transitions. Requests lane is unchanged (no board-archive).
 * Historical V5–V14 keep the pre-archived task state vocabulary.
 */
export const WORK_STATE_SCHEMA_TASK_ARCHIVED_SQL =
  WORK_STATE_SCHEMA_PROPOSAL_REJECT_SQL
    .replaceAll(
      `'completed',
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
    PRIMARY KEY (canvas_name, node_id, task_id),`,
      `'completed',
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
    PRIMARY KEY (canvas_name, node_id, task_id),`,
    )
    .replaceAll(
      "OR state IN ('completed', 'canceled', 'failed', 'rejected')",
      "OR state IN ('completed', 'canceled', 'failed', 'rejected', 'archived')",
    )
    .replaceAll(
      `to_state IN (
          'submitted',
          'working',
          'input-required',
          'auth-required',
          'completed',
          'canceled',
          'failed',
          'rejected'
        )`,
      `to_state IN (
          'submitted',
          'working',
          'input-required',
          'auth-required',
          'completed',
          'canceled',
          'failed',
          'rejected',
          'archived'
        )`,
    )
    .replaceAll(
      `from_state IN (
        'submitted',
        'working',
        'input-required',
        'auth-required',
        'completed',
        'canceled',
        'failed',
        'rejected'
      )`,
      `from_state IN (
        'submitted',
        'working',
        'input-required',
        'auth-required',
        'completed',
        'canceled',
        'failed',
        'rejected',
        'archived'
      )`,
    );

/**
 * Proposal event tables only, with reject in the operation CHECK. Used by the
 * v13→v14 rebuild (drop + recreate + copy-forward). work_task_proposals is
 * IF NOT EXISTS so material rows and their already-allowed rejected state stay.
 */
export const WORK_PROPOSAL_EVENTS_REJECT_VOCAB_SQL =
  WORK_PROPOSAL_STATE_SCHEMA_SQL.replaceAll(
    "operation IN ('proposal.create', 'proposal.approve')",
    "operation IN ('proposal.create', 'proposal.approve', 'proposal.reject')",
  );

/**
 * Historical Work schema embedded in state schema versions 1–3.
 * Kept as an exact forward-migration witness; fresh installs use the current
 * trigger above. This avoids duplicating the rest of the large Work schema.
 */
export const WORK_STATE_SCHEMA_V3_SQL = WORK_STATE_SCHEMA_SQL
  .replace(`  ${WORK_PROPOSAL_STATE_SCHEMA_SQL}\n`, "")
  .replace(
  `  CREATE TRIGGER IF NOT EXISTS work_tasks_actor_immutable
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
  END;`,
  `  CREATE TRIGGER IF NOT EXISTS work_tasks_actor_immutable
  BEFORE UPDATE OF actor_seat_id ON work_tasks
  WHEN
    OLD.actor_seat_id IS NOT NULL
    AND OLD.actor_seat_id IS NOT NEW.actor_seat_id
  BEGIN
    SELECT RAISE(ABORT, 'work task actor seat is immutable after first claim');
  END;`,
  );
