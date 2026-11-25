import type { StateSchemaMigrationDatabase } from "../state/migrations";

/**
 * A seat deleted on the canvas ends its session with the reason `removed`
 * (050a4f949): the seat is gone, not offboarded, reseated or replaced. The
 * end reason type admitted it but the table's CHECK never did, so every
 * delete finish failed its session write and the delete hold it was to
 * release piled up (remote-verify receipt 13). SQLite relaxes a CHECK no
 * other way, so `seat_sessions` is rebuilt: the end_reason CHECK admits
 * `removed` beside the three it had, every row is copied as it was, and the
 * one-open index is made again. The DDL below is this step's own copy.
 */
export const SEAT_SESSIONS_REMOVED_REPLACED_TABLES = ["seat_sessions"] as const;

const SEAT_SESSIONS_V79_SQL = `
  CREATE TABLE IF NOT EXISTS seat_sessions (
    seat_id TEXT NOT NULL CHECK (length(seat_id) BETWEEN 1 AND 1024),
    session_id TEXT NOT NULL CHECK (length(session_id) BETWEEN 1 AND 512),
    harness TEXT NOT NULL CHECK (length(harness) BETWEEN 1 AND 64),
    cwd TEXT CHECK (cwd IS NULL OR length(cwd) BETWEEN 1 AND 4096),
    transcript_path TEXT
      CHECK (transcript_path IS NULL OR length(transcript_path) BETWEEN 1 AND 4096),
    gist TEXT CHECK (gist IS NULL OR length(gist) BETWEEN 1 AND 200),
    notes TEXT CHECK (notes IS NULL OR length(notes) >= 1),
    continuation TEXT
      CHECK (continuation IS NULL OR length(continuation) >= 1),
    started_at INTEGER NOT NULL CHECK (started_at >= 0),
    ended_at INTEGER CHECK (ended_at IS NULL OR ended_at >= 0),
    end_reason TEXT
      CHECK (end_reason IS NULL OR end_reason IN ('offboard', 'reseat', 'replaced', 'removed')),
    ended_by TEXT CHECK (ended_by IS NULL OR ended_by IN ('operator', 'overseer', 'automatic')),
    offboarded_at INTEGER CHECK (offboarded_at IS NULL OR offboarded_at >= 0),
    onboarded_at INTEGER CHECK (onboarded_at IS NULL OR onboarded_at >= 0),
    binding_id TEXT CHECK (binding_id IS NULL OR length(binding_id) BETWEEN 1 AND 1024),
    PRIMARY KEY (seat_id, session_id),
    CHECK ((ended_at IS NULL) = (end_reason IS NULL))
  ) STRICT, WITHOUT ROWID;
  CREATE UNIQUE INDEX IF NOT EXISTS seat_sessions_one_open
    ON seat_sessions(seat_id) WHERE ended_at IS NULL;
`;

/** Every column a row held at step 78. */
const KEPT_COLUMNS = [
  "seat_id",
  "session_id",
  "harness",
  "cwd",
  "transcript_path",
  "gist",
  "notes",
  "continuation",
  "started_at",
  "ended_at",
  "end_reason",
  "ended_by",
  "offboarded_at",
  "onboarded_at",
  "binding_id",
] as const;

export const migrateSeatSessionEndReasonRemoved = (database: StateSchemaMigrationDatabase): void => {
  const stored = database
    .prepare(`SELECT ${KEPT_COLUMNS.join(", ")} FROM seat_sessions ORDER BY seat_id, session_id`)
    .all() as unknown as ReadonlyArray<Record<(typeof KEPT_COLUMNS)[number], string | number | null>>;

  database.exec("DROP TABLE seat_sessions");
  database.exec(SEAT_SESSIONS_V79_SQL);
  const insert = database.prepare(
    `INSERT INTO seat_sessions(${KEPT_COLUMNS.join(", ")}) VALUES (${KEPT_COLUMNS.map(() => "?").join(", ")})`,
  );
  for (const row of stored) insert.run(...KEPT_COLUMNS.map((column) => row[column]));
  const kept = Number(database.prepare("SELECT count(*) AS n FROM seat_sessions").get()!.n);
  if (kept !== stored.length) throw new Error("a seat session did not survive the end_reason step");
};
