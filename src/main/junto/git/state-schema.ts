/**
 * Seat commits: which seat made a commit, as Junto observed it. A row is
 * written when a seat's post-commit hook reports HEAD with the seat's own
 * credential (see `seat-hooks.ts`); the seat is the credential's, never an
 * argument, and the session is the seat's current one when Junto knows it.
 * The commit itself (subject, author time) stays in git and is read from
 * there. The first seat to report a commit keeps it. Added by state
 * migration 21 -> 22.
 */
export const SEAT_COMMITS_STATE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS seat_commits (
    repo TEXT NOT NULL CHECK (length(repo) BETWEEN 1 AND 4096),
    sha TEXT NOT NULL
      CHECK (length(sha) IN (40, 64) AND sha NOT GLOB '*[^0-9a-f]*'),
    canvas_name TEXT NOT NULL CHECK (length(canvas_name) BETWEEN 1 AND 1024),
    seat_id TEXT NOT NULL CHECK (length(seat_id) BETWEEN 1 AND 1024),
    session_id TEXT CHECK (session_id IS NULL OR length(session_id) BETWEEN 1 AND 512),
    observed_at INTEGER NOT NULL CHECK (observed_at >= 0),
    PRIMARY KEY (repo, sha)
  ) STRICT, WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS seat_commits_by_session
    ON seat_commits(seat_id, session_id, observed_at);
`;
