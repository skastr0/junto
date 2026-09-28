/**
 * Seat sessions: one row per harness session an agent seat has run, keyed by
 * seat identity (canvas node id, the same key as `seat_guidance`) and the
 * harness's session id. At most one row per seat is open (no end yet): the
 * seat's current session. Notes are markdown files under
 * `~/.junto/seats/<seat>/sessions/`; the row holds their path and gist.
 * Added by state migration 7 -> 8.
 */
export const SEAT_SESSIONS_STATE_SCHEMA_SQL = `
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
