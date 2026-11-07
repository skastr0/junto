/** SQLite is the usage plane's sole durable store. No row means no last-good. */
export const USAGE_STATE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS usage_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    snapshots_json TEXT NOT NULL
      CHECK (
        json_valid(snapshots_json)
        AND json_type(snapshots_json) = 'array'
      ),
    last_live_at TEXT NOT NULL CHECK (length(last_live_at) > 0),
    updated_at TEXT NOT NULL CHECK (length(updated_at) > 0)
  ) STRICT;
`;
