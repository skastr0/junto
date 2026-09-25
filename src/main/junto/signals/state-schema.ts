/**
 * Agent signals: a seat's declared claim that it needs the operator
 * (`@shared/agent-signals`). Durable because each one waits for an operator
 * response; closed rows stay as the seat's history. A row is open until it is
 * answered (response present), dismissed, or withdrawn by its own seat.
 */
export const AGENT_SIGNALS_STATE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS agent_signals (
    signal_id TEXT PRIMARY KEY CHECK (length(signal_id) BETWEEN 1 AND 64),
    canvas_name TEXT NOT NULL
      CHECK (
        length(canvas_name) BETWEEN 1 AND 64
        AND canvas_name GLOB '[a-z0-9]*'
        AND canvas_name NOT GLOB '*[^a-z0-9_-]*'
      ),
    node_id TEXT NOT NULL CHECK (length(node_id) BETWEEN 1 AND 1024),
    kind TEXT NOT NULL CHECK (kind IN ('escalate', 'blocked', 'feedback')),
    text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 280),
    detail TEXT CHECK (detail IS NULL OR length(detail) BETWEEN 1 AND 8000),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    state TEXT NOT NULL
      CHECK (state IN ('open', 'answered', 'dismissed', 'withdrawn')),
    response_text TEXT
      CHECK (response_text IS NULL OR length(response_text) BETWEEN 1 AND 8000),
    response_at INTEGER,
    closed_at INTEGER,
    CHECK ((state = 'open') = (closed_at IS NULL)),
    CHECK ((state = 'answered') = (response_text IS NOT NULL)),
    CHECK ((response_text IS NULL) = (response_at IS NULL))
  ) STRICT, WITHOUT ROWID;

  CREATE INDEX IF NOT EXISTS agent_signals_by_seat
    ON agent_signals(canvas_name, node_id, state);
`;
