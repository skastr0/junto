import type { StateSchemaMigrationDatabase } from "../state/migrations";

/**
 * A signal may now carry a notice or work raised by an automation, a form the
 * operator answers it with, and when that work is due (0.11/07, N1). SQLite
 * widens a CHECK no other way, so `agent_signals` is rebuilt with `notice`
 * and `work` in its kind CHECK and three nullable JSON columns beside it:
 * `source_json` (who raised it), `work_json` (its due time and urgent mark)
 * and `form_json` (the reply it asks for). Every row is copied as it was, and
 * a signal raised before this step reads as a seat's own, with no timing and
 * no form. The DDL below is this step's own copy.
 */
export const SIGNAL_KINDS_REPLACED_TABLES = ["agent_signals"] as const;

const AGENT_SIGNALS_SQL = `
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
    CHECK ((state = 'open') = (closed_at IS NULL)),
    CHECK ((state = 'answered') = (response_text IS NOT NULL)),
    CHECK ((response_text IS NULL) = (response_at IS NULL))
  ) STRICT, WITHOUT ROWID;

  CREATE INDEX IF NOT EXISTS agent_signals_by_seat
    ON agent_signals(canvas_name, node_id, state);
`;

/** The columns a row held before the step; the three new ones start empty. */
const KEPT_COLUMNS = [
  "signal_id",
  "canvas_name",
  "node_id",
  "kind",
  "text",
  "detail",
  "created_at",
  "state",
  "response_text",
  "response_at",
  "closed_at",
] as const;

export const migrateSignalKinds = (database: StateSchemaMigrationDatabase): void => {
  const stored = database
    .prepare(`SELECT ${KEPT_COLUMNS.join(", ")} FROM agent_signals ORDER BY signal_id`)
    .all() as unknown as ReadonlyArray<Record<(typeof KEPT_COLUMNS)[number], string | number | null>>;

  database.exec("DROP TABLE agent_signals");
  database.exec(AGENT_SIGNALS_SQL);
  const insert = database.prepare(
    `INSERT INTO agent_signals(${KEPT_COLUMNS.join(", ")}) VALUES (${KEPT_COLUMNS.map(() => "?").join(", ")})`,
  );
  for (const row of stored) insert.run(...KEPT_COLUMNS.map((column) => row[column]));
  const kept = Number(database.prepare("SELECT count(*) AS n FROM agent_signals").get()!.n);
  if (kept !== stored.length) throw new Error("a signal did not survive the signal kinds step");
};
