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

/**
 * Files an agent attached to a signal, in the order given. The bytes are in
 * the content store; a row here is the signal's portable reference to one
 * (digest, length, type, name) and the agent's caption. Rows go with their
 * signal.
 */
export const AGENT_SIGNAL_ATTACHMENTS_STATE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS agent_signal_attachments (
    signal_id TEXT NOT NULL
      REFERENCES agent_signals(signal_id) ON DELETE CASCADE,
    position INTEGER NOT NULL
      CHECK (typeof(position) = 'integer' AND position BETWEEN 0 AND 11),
    sha256 TEXT NOT NULL
      CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^a-f0-9]*'),
    byte_length INTEGER NOT NULL
      CHECK (typeof(byte_length) = 'integer' AND byte_length >= 0),
    media_type TEXT NOT NULL CHECK (length(media_type) BETWEEN 1 AND 255),
    display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 255),
    caption TEXT CHECK (caption IS NULL OR length(caption) BETWEEN 1 AND 120),
    PRIMARY KEY (signal_id, position)
  ) STRICT, WITHOUT ROWID;
`;

/**
 * What a signal carries beside its words, in the order given: a file today,
 * other kinds as they come (`kind` is open so a new one needs no migration).
 * `body_json` is the part itself; for a file, its portable reference in the
 * content store (digest, length, type, name). Nothing bounds how many parts
 * a signal has or how long a caption is. Rows go with their signal.
 *
 * This replaces `agent_signal_attachments`, which capped a signal at twelve
 * files and a caption at 120 characters. That table stays (the chain only
 * expands) and is no longer read or written.
 */
export const AGENT_SIGNAL_PARTS_STATE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS agent_signal_parts (
    signal_id TEXT NOT NULL
      REFERENCES agent_signals(signal_id) ON DELETE CASCADE,
    position INTEGER NOT NULL
      CHECK (typeof(position) = 'integer' AND position >= 0),
    kind TEXT NOT NULL CHECK (length(kind) BETWEEN 1 AND 32),
    body_json TEXT NOT NULL CHECK (json_valid(body_json) AND json_type(body_json) = 'object'),
    caption TEXT CHECK (caption IS NULL OR length(caption) >= 1),
    PRIMARY KEY (signal_id, position)
  ) STRICT, WITHOUT ROWID;
`;

/** 10 -> 11: every attachment already held becomes a file part, in place and order. */
export const AGENT_SIGNAL_PARTS_COPY_SQL = `
  INSERT INTO agent_signal_parts(signal_id, position, kind, body_json, caption)
  SELECT signal_id, position, 'file',
    json_object('sha256', sha256, 'byteLength', byte_length, 'mediaType', media_type, 'displayName', display_name),
    caption
  FROM agent_signal_attachments;
`;
