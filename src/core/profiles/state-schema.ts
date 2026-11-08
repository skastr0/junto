/**
 * Agent profiles: saved agents the operator seats again anywhere
 * (`@shared/agent-profiles`). The body is JSON decoded on read with bounded,
 * forgiving fields, so a harness or trait a later build retires never makes a
 * row unreadable. Added by state migration 6 -> 7.
 */
export const AGENT_PROFILES_STATE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS agent_profiles (
    profile_id TEXT PRIMARY KEY CHECK (length(profile_id) BETWEEN 1 AND 64),
    name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 60),
    body_json TEXT NOT NULL
      CHECK (
        length(body_json) BETWEEN 2 AND 32768
        AND json_valid(body_json)
        AND json_type(body_json) = 'object'
      ),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
  ) STRICT, WITHOUT ROWID;

  CREATE UNIQUE INDEX IF NOT EXISTS agent_profiles_by_name
    ON agent_profiles(name COLLATE NOCASE);
`;
