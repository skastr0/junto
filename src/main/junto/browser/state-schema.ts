import {
  BROWSER_MAX_VISIBLE_SURFACES_HARD,
  BROWSER_MAX_WARM_SESSIONS_HARD,
} from "@shared/browser-limits";

/**
 * Browser profile metadata is application state. Chromium remains the owner
 * of cookies, credentials, partitions, and physical session storage.
 *
 * The pending-wipe singleton is a durable crash journal. It references the
 * still-present profile until external deletion succeeds; finalization removes
 * defaults, the journal, and the profile in one transaction.
 */
export const BROWSER_PROFILES_STATE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS browser_profiles (
    id TEXT PRIMARY KEY
      CHECK (
        length(id) BETWEEN 1 AND 63
        AND substr(id, 1, 1) GLOB '[a-z0-9]'
        AND id NOT GLOB '*[^a-z0-9-]*'
      ),
    label TEXT
      CHECK (
        label IS NULL
        OR (
          length(label) > 0
          AND length(CAST(label AS BLOB)) <= 128
        )
      ),
    created_at TEXT NOT NULL CHECK (length(created_at) > 0),
    last_used_at TEXT CHECK (last_used_at IS NULL OR length(last_used_at) > 0),
    sort_order INTEGER NOT NULL UNIQUE CHECK (sort_order >= 0)
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS browser_profile_settings (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    version INTEGER NOT NULL CHECK (version = 1),
    default_profile TEXT NOT NULL
      REFERENCES browser_profiles(id) ON DELETE RESTRICT,
    max_warm_sessions INTEGER NOT NULL
      CHECK (max_warm_sessions BETWEEN 1 AND ${BROWSER_MAX_WARM_SESSIONS_HARD}),
    max_visible_surfaces INTEGER NOT NULL
      CHECK (max_visible_surfaces BETWEEN 1 AND ${BROWSER_MAX_VISIBLE_SURFACES_HARD})
  ) STRICT;

  CREATE TABLE IF NOT EXISTS browser_profile_canvas_defaults (
    canvas_name TEXT PRIMARY KEY
      CHECK (
        length(canvas_name) BETWEEN 1 AND 63
        AND substr(canvas_name, 1, 1) GLOB '[a-z0-9]'
        AND canvas_name NOT GLOB '*[^a-z0-9-]*'
      ),
    profile_id TEXT NOT NULL
      REFERENCES browser_profiles(id) ON DELETE RESTRICT
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS browser_profile_pending_wipe (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    wipe_id TEXT NOT NULL UNIQUE CHECK (length(wipe_id) = 36),
    profile_id TEXT NOT NULL UNIQUE
      REFERENCES browser_profiles(id) ON DELETE RESTRICT,
    partition TEXT NOT NULL
      CHECK (partition = 'persist:junto-profile-' || profile_id),
    requested_at TEXT NOT NULL CHECK (length(requested_at) > 0),
    stage TEXT NOT NULL
      CHECK (stage IN ('live_clear_pending', 'restart_delete_pending')),
    storage_path TEXT NOT NULL
      CHECK (length(CAST(storage_path AS BLOB)) BETWEEN 1 AND 4096),
    user_data_path TEXT NOT NULL
      CHECK (length(CAST(user_data_path AS BLOB)) BETWEEN 1 AND 4096),
    session_data_path TEXT NOT NULL
      CHECK (length(CAST(session_data_path AS BLOB)) BETWEEN 1 AND 4096)
  ) STRICT;

  CREATE TRIGGER IF NOT EXISTS browser_profiles_limit
  BEFORE INSERT ON browser_profiles
  WHEN (SELECT count(*) FROM browser_profiles) >= 64
  BEGIN
    SELECT RAISE(ABORT, 'browser profile limit reached');
  END;

  CREATE TRIGGER IF NOT EXISTS browser_profile_canvas_defaults_limit
  BEFORE INSERT ON browser_profile_canvas_defaults
  WHEN (SELECT count(*) FROM browser_profile_canvas_defaults) >= 256
  BEGIN
    SELECT RAISE(ABORT, 'browser canvas-default limit reached');
  END;
`;

/**
 * Origins a seat ran code in, by profile: a write-ahead record, committed
 * before a seat's eval is dispatched, so a service worker the seat could have
 * left there is cleared at the next start even after a crash. This
 * machine's own state: never exchanged, never in a copy.
 */
export const BROWSER_TOUCHED_ORIGINS_STATE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS browser_touched_origins (
    profile TEXT NOT NULL
      CHECK (
        length(profile) BETWEEN 1 AND 63
        AND substr(profile, 1, 1) GLOB '[a-z0-9]'
        AND profile NOT GLOB '*[^a-z0-9-]*'
      ),
    origin TEXT NOT NULL
      CHECK (
        length(CAST(origin AS BLOB)) BETWEEN 1 AND 2048
        AND (origin GLOB 'https://?*' OR origin GLOB 'http://?*')
      ),
    PRIMARY KEY (profile, origin)
  ) STRICT, WITHOUT ROWID;

  CREATE TRIGGER IF NOT EXISTS browser_touched_origins_limit
  BEFORE INSERT ON browser_touched_origins
  WHEN (SELECT count(*) FROM browser_touched_origins) >= 4096
  BEGIN
    SELECT RAISE(ABORT, 'browser touched-origin limit reached');
  END;
`;
