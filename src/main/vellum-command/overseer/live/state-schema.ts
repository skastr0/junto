/** App-owned requests and effect receipts; audio and provider secrets never belong here. */
export const OVERSEER_LIVE_STATE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS overseer_live_sessions (
    session_id TEXT PRIMARY KEY CHECK (length(session_id) BETWEEN 1 AND 256),
    seat_node_ref TEXT NOT NULL CHECK (length(seat_node_ref) BETWEEN 1 AND 4096),
    occupant_generation TEXT NOT NULL CHECK (length(occupant_generation) BETWEEN 1 AND 256),
    authority_epoch TEXT NOT NULL CHECK (length(authority_epoch) BETWEEN 1 AND 256),
    status TEXT NOT NULL CHECK (status IN ('active', 'closed', 'interrupted')),
    backend_conversation_id TEXT,
    provider_session_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;
  CREATE UNIQUE INDEX IF NOT EXISTS overseer_live_sessions_one_active_seat
    ON overseer_live_sessions(seat_node_ref) WHERE status = 'active';
  CREATE TRIGGER IF NOT EXISTS overseer_live_sessions_immutable_binding
  BEFORE UPDATE OF session_id, seat_node_ref, occupant_generation, authority_epoch, created_at
  ON overseer_live_sessions
  BEGIN
    SELECT RAISE(ABORT, 'Live session authority binding is immutable');
  END;

  CREATE TABLE IF NOT EXISTS overseer_live_requests (
    request_id TEXT PRIMARY KEY CHECK (length(request_id) BETWEEN 1 AND 256),
    session_id TEXT NOT NULL REFERENCES overseer_live_sessions(session_id),
    provider_delegation_id TEXT,
    intent_revision INTEGER NOT NULL CHECK (intent_revision >= 1),
    status TEXT NOT NULL CHECK (status IN (
      'queued', 'interpreting', 'waiting-approval', 'running', 'completed',
      'failed', 'cancelled', 'superseded', 'interrupted'
    )),
    text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 32768),
    captured_context_json TEXT NOT NULL CHECK (json_valid(captured_context_json)),
    transcript_refs_json TEXT NOT NULL CHECK (json_valid(transcript_refs_json)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(session_id, provider_delegation_id)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS overseer_live_requests_session
    ON overseer_live_requests(session_id, created_at, request_id);

  CREATE TABLE IF NOT EXISTS overseer_live_operations (
    operation_id TEXT PRIMARY KEY CHECK (length(operation_id) BETWEEN 1 AND 256),
    request_id TEXT NOT NULL REFERENCES overseer_live_requests(request_id),
    intent_revision INTEGER NOT NULL CHECK (intent_revision >= 1),
    operation TEXT NOT NULL CHECK (length(operation) BETWEEN 1 AND 256),
    args_json TEXT NOT NULL CHECK (json_valid(args_json)),
    args_sha256 TEXT NOT NULL CHECK (
      length(args_sha256) = 64 AND args_sha256 NOT GLOB '*[^a-f0-9]*'
    ),
    target_refs_json TEXT NOT NULL CHECK (json_valid(target_refs_json)),
    target_revision TEXT,
    status TEXT NOT NULL CHECK (status IN (
      'proposed', 'awaiting-approval', 'admitted', 'dispatched',
      'applied', 'failed', 'partial', 'unknown'
    )),
    outcome_json TEXT CHECK (outcome_json IS NULL OR json_valid(outcome_json)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS overseer_live_operations_request
    ON overseer_live_operations(request_id, created_at, operation_id);
  CREATE TRIGGER IF NOT EXISTS overseer_live_operations_immutable_intent
  BEFORE UPDATE OF operation_id, request_id, intent_revision, operation, args_json,
    args_sha256, target_refs_json, target_revision, created_at
  ON overseer_live_operations
  BEGIN
    SELECT RAISE(ABORT, 'Live operation intent is immutable');
  END;
  CREATE TRIGGER IF NOT EXISTS overseer_live_operations_no_delete
  BEFORE DELETE ON overseer_live_operations
  BEGIN
    SELECT RAISE(ABORT, 'Live operation receipts are retained');
  END;

  CREATE TABLE IF NOT EXISTS overseer_live_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES overseer_live_sessions(session_id),
    request_id TEXT REFERENCES overseer_live_requests(request_id),
    operation_id TEXT REFERENCES overseer_live_operations(operation_id),
    kind TEXT NOT NULL CHECK (length(kind) BETWEEN 1 AND 256),
    detail_json TEXT NOT NULL CHECK (json_valid(detail_json)),
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS overseer_live_events_session_sequence
    ON overseer_live_events(session_id, sequence);
  CREATE TRIGGER IF NOT EXISTS overseer_live_events_no_update
  BEFORE UPDATE ON overseer_live_events
  BEGIN
    SELECT RAISE(ABORT, 'Live event journal is append-only');
  END;
  CREATE TRIGGER IF NOT EXISTS overseer_live_events_no_delete
  BEFORE DELETE ON overseer_live_events
  BEGIN
    SELECT RAISE(ABORT, 'Live event journal is append-only');
  END;
`;
