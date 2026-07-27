/**
 * Opaque Electron-main runtime state.
 *
 * Values remain JSON because StoreService is intentionally a compatibility
 * surface for several small runtime planes. SQLite owns atomicity and
 * isolation; each consumer remains responsible for its domain shape.
 */
export const STORE_STATE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS runtime_store_values (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL CHECK (json_valid(value_json)),
    updated_at TEXT NOT NULL CHECK (length(updated_at) > 0)
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS runtime_store_legacy_import (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    status TEXT NOT NULL
      CHECK (status IN ('absent', 'imported', 'skipped-existing')),
    legacy_path TEXT NOT NULL CHECK (length(legacy_path) > 0),
    imported_key_count INTEGER NOT NULL CHECK (imported_key_count >= 0),
    completed_at TEXT NOT NULL CHECK (length(completed_at) > 0)
  ) STRICT;
`;
