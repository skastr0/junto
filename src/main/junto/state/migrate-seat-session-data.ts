import type { StateSchemaMigrationDatabase } from "./migrations";

/**
 * State migration 21 -> 22. A session's notes, the note for its next session,
 * who ended it and whether it onboarded were files under `~/.junto/seats`
 * beside a `notes_path` column; the continuation ledger and the offboard
 * clock were files there too. All of it lives in this database now. The step
 * rebuilds `seat_sessions` with the new columns and without `notes_path`, and
 * adds the ledger and clock tables. Every session survives with its history;
 * nothing is read from the old files, which stay on disk untouched.
 *
 * The DDL below is this step's own copy. It never follows the head schema.
 */

const SEAT_SESSIONS_TABLE_SQL = `
  CREATE TABLE seat_sessions (
    seat_id TEXT NOT NULL CHECK (length(seat_id) BETWEEN 1 AND 1024),
    session_id TEXT NOT NULL CHECK (length(session_id) BETWEEN 1 AND 512),
    harness TEXT NOT NULL CHECK (length(harness) BETWEEN 1 AND 64),
    cwd TEXT CHECK (cwd IS NULL OR length(cwd) BETWEEN 1 AND 4096),
    transcript_path TEXT
      CHECK (transcript_path IS NULL OR length(transcript_path) BETWEEN 1 AND 4096),
    gist TEXT CHECK (gist IS NULL OR length(gist) BETWEEN 1 AND 200),
    notes TEXT CHECK (notes IS NULL OR length(notes) BETWEEN 1 AND 16000),
    continuation TEXT
      CHECK (continuation IS NULL OR length(continuation) BETWEEN 1 AND 8000),
    started_at INTEGER NOT NULL CHECK (started_at >= 0),
    ended_at INTEGER CHECK (ended_at IS NULL OR ended_at >= 0),
    end_reason TEXT
      CHECK (end_reason IS NULL OR end_reason IN ('offboard', 'reseat', 'replaced')),
    ended_by TEXT CHECK (ended_by IS NULL OR ended_by IN ('operator', 'overseer', 'automatic')),
    offboarded_at INTEGER CHECK (offboarded_at IS NULL OR offboarded_at >= 0),
    onboarded_at INTEGER CHECK (onboarded_at IS NULL OR onboarded_at >= 0),
    binding_id TEXT CHECK (binding_id IS NULL OR length(binding_id) BETWEEN 1 AND 1024),
    PRIMARY KEY (seat_id, session_id),
    CHECK ((ended_at IS NULL) = (end_reason IS NULL))
  ) STRICT, WITHOUT ROWID;
`;

const SEAT_SESSIONS_OPEN_INDEX_SQL = `
  CREATE UNIQUE INDEX seat_sessions_one_open
    ON seat_sessions(seat_id) WHERE ended_at IS NULL
`;

const SEAT_CONTINUATIONS_OWED_TABLE_SQL = `
  CREATE TABLE seat_continuations_owed (
    seat_id TEXT PRIMARY KEY CHECK (length(seat_id) BETWEEN 1 AND 1024),
    binding_id TEXT NOT NULL UNIQUE CHECK (length(binding_id) BETWEEN 1 AND 1024),
    offboarded_generation TEXT
      CHECK (offboarded_generation IS NULL OR length(offboarded_generation) BETWEEN 1 AND 1024),
    owed_at INTEGER NOT NULL CHECK (owed_at >= 0)
  ) STRICT, WITHOUT ROWID;
`;

const SEAT_OFFBOARD_CLOCK_TABLE_SQL = `
  CREATE TABLE seat_offboard_clock (
    binding_id TEXT PRIMARY KEY CHECK (length(binding_id) BETWEEN 1 AND 1024),
    idle_since INTEGER CHECK (idle_since IS NULL OR idle_since >= 0),
    activity_since INTEGER CHECK (activity_since IS NULL OR activity_since >= 0),
    offboarded INTEGER NOT NULL CHECK (offboarded IN (0, 1)),
    work_ms INTEGER NOT NULL CHECK (work_ms >= 0),
    session_id TEXT CHECK (session_id IS NULL OR length(session_id) BETWEEN 1 AND 512),
    saved_at INTEGER NOT NULL CHECK (saved_at >= 0)
  ) STRICT, WITHOUT ROWID;
`;

/** Every column the step keeps, in both shapes of the table. */
const KEPT = [
  "seat_id",
  "session_id",
  "harness",
  "cwd",
  "transcript_path",
  "gist",
  "started_at",
  "ended_at",
  "end_reason",
  "offboarded_at",
  "binding_id",
] as const;

export const migrateSeatSessionData = (database: StateSchemaMigrationDatabase): void => {
  const stored = database
    .prepare(`SELECT ${KEPT.join(", ")} FROM seat_sessions ORDER BY seat_id, session_id`)
    .all() as unknown as ReadonlyArray<Record<(typeof KEPT)[number], string | number | null>>;

  database.exec("DROP TABLE seat_sessions");
  database.exec(SEAT_SESSIONS_TABLE_SQL);
  const insert = database.prepare(
    `INSERT INTO seat_sessions(${KEPT.join(", ")}) VALUES (${KEPT.map(() => "?").join(", ")})`,
  );
  for (const row of stored) insert.run(...KEPT.map((column) => row[column]));
  database.exec(SEAT_SESSIONS_OPEN_INDEX_SQL);
  database.exec(SEAT_CONTINUATIONS_OWED_TABLE_SQL);
  database.exec(SEAT_OFFBOARD_CLOCK_TABLE_SQL);
  const kept = Number(database.prepare("SELECT count(*) AS n FROM seat_sessions").get()!.n);
  if (kept !== stored.length) throw new Error("a seat session did not survive the step");
};
