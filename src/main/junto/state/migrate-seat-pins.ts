import { dirname, join } from "node:path";
import { seatSessionNotesPath } from "../seat-sessions/notes-file";
import type { StateSchemaMigrationDatabase } from "./migrations";

/**
 * State migration 19 -> 20. The session a seat resumes was kept on its row in
 * the canvas; it belongs to the seat's machine, in the seat sessions store.
 * This step gives every session there the binding it ran under, and makes the
 * session each seat row names the seat's open session, so nothing has to read
 * the row for it again. Every session already recorded survives as it was.
 *
 * The DDL below is this step's own copy. It never follows the head schema.
 */

/** The seat sessions table exactly as state migration 7 -> 8 creates it. */
export const SEAT_SESSIONS_V8_STATE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS seat_sessions (
    seat_id TEXT NOT NULL CHECK (length(seat_id) BETWEEN 1 AND 1024),
    session_id TEXT NOT NULL CHECK (length(session_id) BETWEEN 1 AND 512),
    harness TEXT NOT NULL CHECK (length(harness) BETWEEN 1 AND 64),
    cwd TEXT CHECK (cwd IS NULL OR length(cwd) BETWEEN 1 AND 4096),
    transcript_path TEXT
      CHECK (transcript_path IS NULL OR length(transcript_path) BETWEEN 1 AND 4096),
    notes_path TEXT NOT NULL CHECK (length(notes_path) BETWEEN 1 AND 4096),
    gist TEXT CHECK (gist IS NULL OR length(gist) BETWEEN 1 AND 200),
    started_at INTEGER NOT NULL CHECK (started_at >= 0),
    ended_at INTEGER CHECK (ended_at IS NULL OR ended_at >= 0),
    end_reason TEXT
      CHECK (end_reason IS NULL OR end_reason IN ('offboard', 'reseat', 'replaced')),
    offboarded_at INTEGER CHECK (offboarded_at IS NULL OR offboarded_at >= 0),
    PRIMARY KEY (seat_id, session_id),
    CHECK ((ended_at IS NULL) = (end_reason IS NULL))
  ) STRICT, WITHOUT ROWID;
  CREATE UNIQUE INDEX IF NOT EXISTS seat_sessions_one_open
    ON seat_sessions(seat_id) WHERE ended_at IS NULL;
`;

const SEAT_SESSIONS_TABLE_SQL = `
  CREATE TABLE seat_sessions (
    seat_id TEXT NOT NULL CHECK (length(seat_id) BETWEEN 1 AND 1024),
    session_id TEXT NOT NULL CHECK (length(session_id) BETWEEN 1 AND 512),
    harness TEXT NOT NULL CHECK (length(harness) BETWEEN 1 AND 64),
    cwd TEXT CHECK (cwd IS NULL OR length(cwd) BETWEEN 1 AND 4096),
    transcript_path TEXT
      CHECK (transcript_path IS NULL OR length(transcript_path) BETWEEN 1 AND 4096),
    notes_path TEXT NOT NULL CHECK (length(notes_path) BETWEEN 1 AND 4096),
    gist TEXT CHECK (gist IS NULL OR length(gist) BETWEEN 1 AND 200),
    started_at INTEGER NOT NULL CHECK (started_at >= 0),
    ended_at INTEGER CHECK (ended_at IS NULL OR ended_at >= 0),
    end_reason TEXT
      CHECK (end_reason IS NULL OR end_reason IN ('offboard', 'reseat', 'replaced')),
    offboarded_at INTEGER CHECK (offboarded_at IS NULL OR offboarded_at >= 0),
    binding_id TEXT CHECK (binding_id IS NULL OR length(binding_id) BETWEEN 1 AND 1024),
    PRIMARY KEY (seat_id, session_id),
    CHECK ((ended_at IS NULL) = (end_reason IS NULL))
  ) STRICT, WITHOUT ROWID;
`;

const SEAT_SESSIONS_OPEN_INDEX_SQL = `
  CREATE UNIQUE INDEX seat_sessions_one_open
    ON seat_sessions(seat_id) WHERE ended_at IS NULL
`;

const COLUMNS = [
  "seat_id",
  "session_id",
  "harness",
  "cwd",
  "transcript_path",
  "notes_path",
  "gist",
  "started_at",
  "ended_at",
  "end_reason",
  "offboarded_at",
] as const;

type Session = Record<(typeof COLUMNS)[number] | "binding_id", string | number | null>;

type Pin = {
  readonly id: string;
  readonly session_id: string;
  readonly harness: string;
  readonly binding_id: string;
};

export const migrateSeatPins = (
  database: StateSchemaMigrationDatabase,
  now: () => number = Date.now,
): void => {
  const file = String(
    database.prepare("SELECT file FROM pragma_database_list WHERE name = 'main'").get()?.file ?? "",
  );
  const seatsRoot = join(dirname(dirname(file)), "seats");
  // One row per seat id: the seat as it was last changed.
  const seats = database
    .prepare(
      `SELECT id, trim(coalesce(session_id, '')) AS session_id, harness, binding_id, max(updated_at) AS changed
       FROM seats GROUP BY id`,
    )
    .all() as unknown as ReadonlyArray<Pin>;
  const bindings = new Map(seats.map((seat) => [seat.id, seat.binding_id]));
  const stored = database
    .prepare(`SELECT ${COLUMNS.join(", ")} FROM seat_sessions ORDER BY seat_id, started_at, session_id`)
    .all() as unknown as ReadonlyArray<Omit<Session, "binding_id">>;

  const sessions: Session[] = stored.map((row) => ({
    ...row,
    binding_id: row.ended_at === null ? (bindings.get(String(row.seat_id)) ?? null) : null,
  }));
  const open = new Set(sessions.filter((row) => row.ended_at === null).map((row) => String(row.seat_id)));
  for (const seat of seats) {
    if (seat.session_id === "" || open.has(seat.id)) continue;
    const earlier = sessions.find((row) => row.seat_id === seat.id && row.session_id === seat.session_id);
    if (earlier !== undefined) {
      // A session seen before is the seat's open one again, with its history.
      earlier.ended_at = null;
      earlier.end_reason = null;
      earlier.binding_id = seat.binding_id;
    } else {
      sessions.push({
        seat_id: seat.id,
        session_id: seat.session_id,
        harness: seat.harness,
        cwd: null,
        transcript_path: null,
        notes_path: seatSessionNotesPath(seatsRoot, seat.id, seat.session_id),
        gist: null,
        started_at: now(),
        ended_at: null,
        end_reason: null,
        offboarded_at: null,
        binding_id: seat.binding_id,
      });
    }
    open.add(seat.id);
  }

  database.exec("DROP TABLE seat_sessions");
  database.exec(SEAT_SESSIONS_TABLE_SQL);
  const insert = database.prepare(
    `INSERT INTO seat_sessions(${COLUMNS.join(", ")}, binding_id)
     VALUES (${COLUMNS.map(() => "?").join(", ")}, ?)`,
  );
  for (const row of sessions) insert.run(...COLUMNS.map((column) => row[column]), row.binding_id);
  database.exec(SEAT_SESSIONS_OPEN_INDEX_SQL);
  const kept = Number(database.prepare("SELECT count(*) AS n FROM seat_sessions").get()!.n);
  if (kept !== sessions.length || kept < stored.length) {
    throw new Error("a seat session did not survive the step");
  }
};
