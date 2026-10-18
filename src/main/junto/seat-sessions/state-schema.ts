import { SEAT_SESSION_CONTINUATION_MAX_CHARS, SEAT_SESSION_NOTES_MAX_CHARS } from "@shared/seat-sessions";

/**
 * Seat sessions: one row per harness session an agent seat has run, keyed by
 * seat identity (canvas node id, the same key as `seat_guidance`) and the
 * harness's session id. At most one row per seat is open (no end yet): the
 * seat's current session. The open session is the one the seat resumes,
 * under the binding it ran with. Everything Junto keeps about a session is on
 * its row: the notes its agent left at offboard and the note for the next
 * session, who ended it from outside, and when it onboarded.
 * Added by state migration 7 -> 8; the binding by 19 -> 20; the notes and
 * marks moved here from files under `~/.junto/seats` by 21 -> 22.
 */
export const SEAT_SESSIONS_STATE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS seat_sessions (
    seat_id TEXT NOT NULL CHECK (length(seat_id) BETWEEN 1 AND 1024),
    session_id TEXT NOT NULL CHECK (length(session_id) BETWEEN 1 AND 512),
    harness TEXT NOT NULL CHECK (length(harness) BETWEEN 1 AND 64),
    cwd TEXT CHECK (cwd IS NULL OR length(cwd) BETWEEN 1 AND 4096),
    transcript_path TEXT
      CHECK (transcript_path IS NULL OR length(transcript_path) BETWEEN 1 AND 4096),
    gist TEXT CHECK (gist IS NULL OR length(gist) BETWEEN 1 AND 200),
    notes TEXT CHECK (notes IS NULL OR length(notes) BETWEEN 1 AND ${SEAT_SESSION_NOTES_MAX_CHARS}),
    continuation TEXT
      CHECK (continuation IS NULL OR length(continuation) BETWEEN 1 AND ${SEAT_SESSION_CONTINUATION_MAX_CHARS}),
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
  CREATE UNIQUE INDEX IF NOT EXISTS seat_sessions_one_open
    ON seat_sessions(seat_id) WHERE ended_at IS NULL;
`;

/**
 * The continuation line a seat is still owed: after `junto offboard
 * --continue` its fresh session is told once to read its handoff. The seat
 * may not start for a long time (a paused canvas) and Junto may quit in
 * between, so one row per seat says which binding is owed it and which
 * generation offboarded (never the one to tell), until the line is typed.
 * Added by state migration 21 -> 22.
 */
export const SEAT_CONTINUATIONS_OWED_STATE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS seat_continuations_owed (
    seat_id TEXT PRIMARY KEY CHECK (length(seat_id) BETWEEN 1 AND 1024),
    binding_id TEXT NOT NULL UNIQUE CHECK (length(binding_id) BETWEEN 1 AND 1024),
    offboarded_generation TEXT
      CHECK (offboarded_generation IS NULL OR length(offboarded_generation) BETWEEN 1 AND 1024),
    owed_at INTEGER NOT NULL CHECK (owed_at >= 0)
  ) STRICT, WITHOUT ROWID;
`;

/**
 * The operator offboard clock: per seat binding, when it last came to rest or
 * left it, the work time of its current session, and that session. It carries
 * the automatic cut across a restart. Saved whole, as one set of rows.
 * Added by state migration 21 -> 22.
 */
export const SEAT_OFFBOARD_CLOCK_STATE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS seat_offboard_clock (
    binding_id TEXT PRIMARY KEY CHECK (length(binding_id) BETWEEN 1 AND 1024),
    idle_since INTEGER CHECK (idle_since IS NULL OR idle_since >= 0),
    activity_since INTEGER CHECK (activity_since IS NULL OR activity_since >= 0),
    offboarded INTEGER NOT NULL CHECK (offboarded IN (0, 1)),
    work_ms INTEGER NOT NULL CHECK (work_ms >= 0),
    session_id TEXT CHECK (session_id IS NULL OR length(session_id) BETWEEN 1 AND 512),
    saved_at INTEGER NOT NULL CHECK (saved_at >= 0)
  ) STRICT, WITHOUT ROWID;
`;

/**
 * Seat session drains: what became of a session's process after it
 * offboarded. `junto offboard` moves the seat on at once (the session's row
 * in `seat_sessions` ends then, as `offboard`), but its process is not
 * killed: it is detached and left to finish its turn, and stopped when it
 * settles. One row per offboarded session says when it was detached, when
 * its process really ended, and how: it settled, the ten minute cap stopped
 * it, it crashed, or Junto quit. A row with no end is still winding down.
 * Added by state migration 9 -> 10.
 */
export const SEAT_SESSION_DRAINS_STATE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS seat_session_drains (
    seat_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    detached_at INTEGER NOT NULL CHECK (detached_at >= 0),
    ended_at INTEGER CHECK (ended_at IS NULL OR ended_at >= detached_at),
    ended_how TEXT
      CHECK (ended_how IS NULL OR ended_how IN ('settled', 'cap', 'crashed', 'quit')),
    PRIMARY KEY (seat_id, session_id),
    FOREIGN KEY (seat_id, session_id)
      REFERENCES seat_sessions(seat_id, session_id) ON DELETE CASCADE,
    CHECK ((ended_at IS NULL) = (ended_how IS NULL))
  ) STRICT, WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS seat_session_drains_open
    ON seat_session_drains(seat_id) WHERE ended_at IS NULL;
`;
