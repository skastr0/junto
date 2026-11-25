import type { StateSchemaMigrationDatabase } from "../state/migrations";

/**
 * An answer and a withdrawal that cross each other between machines are both
 * kept (0.12, remote-work's terms for step 77). On the seat's machine an
 * answer that arrives after the seat withdrew is kept beside the withdrawn
 * state; on the editing machine a withdrawal that arrives after the operator
 * answered is kept as `withdrawn_at` beside the answered state. `closed_at`
 * stays the time of the first closing; the two are not ordered against each
 * other, since the seat may withdraw before the answer reaches it and the
 * machines' clocks differ.
 *
 * SQLite relaxes a CHECK no other way, so `agent_signals` is rebuilt: its
 * three state CHECKs become five that admit every row the three admitted,
 * and `withdrawn_at` is added, empty on every row held. Every row is copied
 * as it was, its four indexes are made again as step 76 left them, and the
 * rows that name a signal (`agent_signal_parts`, `agent_signal_attachments`,
 * `agent_signal_depends`) are not touched: foreign keys are off for the
 * step, so the drop cascades nothing. The DDL below is this step's own copy.
 */
export const SIGNAL_WITHDRAWN_REPLACED_TABLES = ["agent_signals"] as const;

const ULID_OR_NULL = (column: string) =>
  `${column} IS NULL OR (length(${column}) = 26 AND ${column} NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')`;

const AGENT_SIGNALS_V77_SQL = `
  CREATE TABLE IF NOT EXISTS agent_signals (
    signal_id TEXT PRIMARY KEY CHECK (length(signal_id) BETWEEN 1 AND 64),
    canvas_name TEXT NOT NULL
      CHECK (
        length(canvas_name) BETWEEN 1 AND 64
        AND canvas_name GLOB '[a-z0-9]*'
        AND canvas_name NOT GLOB '*[^a-z0-9_-]*'
      ),
    node_id TEXT NOT NULL CHECK (length(node_id) BETWEEN 1 AND 1024),
    kind TEXT NOT NULL CHECK (kind IN ('escalate', 'blocked', 'feedback', 'notice', 'work')),
    text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 280),
    detail TEXT CHECK (detail IS NULL OR length(detail) BETWEEN 1 AND 8000),
    source_json TEXT CHECK (
      source_json IS NULL OR (json_valid(source_json) AND json_type(source_json) = 'object')
    ),
    work_json TEXT CHECK (
      work_json IS NULL OR (json_valid(work_json) AND json_type(work_json) = 'object')
    ),
    form_json TEXT CHECK (
      form_json IS NULL OR (json_valid(form_json) AND json_type(form_json) = 'object')
    ),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    state TEXT NOT NULL
      CHECK (state IN ('open', 'answered', 'dismissed', 'withdrawn')),
    response_text TEXT
      CHECK (response_text IS NULL OR length(response_text) BETWEEN 1 AND 8000),
    response_at INTEGER,
    closed_at INTEGER,
    thread_id TEXT CHECK (${ULID_OR_NULL("thread_id")}),
    message_id TEXT CHECK ((${ULID_OR_NULL("message_id")}) AND (message_id IS NULL OR thread_id IS NOT NULL)),
    follows_signal_id TEXT CHECK (${ULID_OR_NULL("follows_signal_id")}),
    withdrawn_at INTEGER,
    CHECK ((state = 'open') = (closed_at IS NULL)),
    CHECK (state <> 'answered' OR response_text IS NOT NULL),
    CHECK (response_text IS NULL OR state IN ('answered', 'withdrawn')),
    CHECK ((response_text IS NULL) = (response_at IS NULL)),
    CHECK (withdrawn_at IS NULL OR (state = 'answered' AND typeof(withdrawn_at) = 'integer' AND withdrawn_at >= 0))
  ) STRICT, WITHOUT ROWID;

  CREATE INDEX IF NOT EXISTS agent_signals_by_seat
    ON agent_signals(canvas_name, node_id, state);

  CREATE UNIQUE INDEX IF NOT EXISTS agent_signals_by_message
    ON agent_signals(message_id)
    WHERE message_id IS NOT NULL;

  CREATE INDEX IF NOT EXISTS agent_signals_by_thread
    ON agent_signals(canvas_name, node_id, thread_id, created_at)
    WHERE thread_id IS NOT NULL;

  CREATE INDEX IF NOT EXISTS agent_signals_by_seat_newest
    ON agent_signals(canvas_name, node_id, created_at);
`;

/** Every column a row held at step 76; `withdrawn_at` starts empty. */
const KEPT_COLUMNS = [
  "signal_id",
  "canvas_name",
  "node_id",
  "kind",
  "text",
  "detail",
  "source_json",
  "work_json",
  "form_json",
  "created_at",
  "state",
  "response_text",
  "response_at",
  "closed_at",
  "thread_id",
  "message_id",
  "follows_signal_id",
] as const;

export const migrateSignalWithdrawn = (database: StateSchemaMigrationDatabase): void => {
  const stored = database
    .prepare(`SELECT ${KEPT_COLUMNS.join(", ")} FROM agent_signals ORDER BY signal_id`)
    .all() as unknown as ReadonlyArray<Record<(typeof KEPT_COLUMNS)[number], string | number | null>>;

  database.exec("DROP TABLE agent_signals");
  database.exec(AGENT_SIGNALS_V77_SQL);
  const insert = database.prepare(
    `INSERT INTO agent_signals(${KEPT_COLUMNS.join(", ")}) VALUES (${KEPT_COLUMNS.map(() => "?").join(", ")})`,
  );
  for (const row of stored) insert.run(...KEPT_COLUMNS.map((column) => row[column]));
  const kept = Number(database.prepare("SELECT count(*) AS n FROM agent_signals").get()!.n);
  if (kept !== stored.length) throw new Error("a signal did not survive the withdrawn step");
};
