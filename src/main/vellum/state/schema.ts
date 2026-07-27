/**
 * Idempotent schema owned by the app's single SQLite state engine.
 *
 * Domain tables are added here as their repository lanes land. This is
 * deliberately ordinary SQL rather than a migration framework: Vellum owns
 * one application database, opens it in one process, and evolves the current
 * schema in place.
 */
export const STATE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS state_metadata (
    key TEXT PRIMARY KEY CHECK (length(key) > 0),
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  INSERT OR IGNORE INTO state_metadata(key, value, updated_at)
  VALUES ('schema', 'vellum/state/v1', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
`;
