/**
 * The usage plane owns one nullable last-good row. `snapshots_json = NULL`
 * means the one-shot legacy import completed without finding authoritative
 * data; it is not an invitation to inspect the legacy file again.
 *
 * This pure fragment is imported by the engine's one boot schema. It stays
 * separate from the cache adapter so schema assembly cannot create an
 * engine -> repository -> engine module cycle.
 */
export const USAGE_STATE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS usage_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    snapshots_json TEXT
      CHECK (
        snapshots_json IS NULL
        OR (
          json_valid(snapshots_json)
          AND json_type(snapshots_json) = 'array'
        )
      ),
    last_live_at TEXT,
    legacy_imported_at TEXT NOT NULL CHECK (length(legacy_imported_at) > 0),
    updated_at TEXT NOT NULL CHECK (length(updated_at) > 0),
    CHECK (snapshots_json IS NOT NULL OR last_live_at IS NULL)
  ) STRICT;
`;
