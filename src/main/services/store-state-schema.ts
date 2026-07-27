/**
 * Opaque Electron-main runtime state.
 *
 * Values remain JSON because StoreService is intentionally a compatibility
 * surface for several small runtime planes. SQLite owns atomicity and
 * isolation; each consumer remains responsible for its domain shape.
 */
export const STORE_STATE_SCHEMA_SQL = `
  DROP TABLE IF EXISTS runtime_store_legacy_import;

  CREATE TABLE IF NOT EXISTS runtime_store_values (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL CHECK (json_valid(value_json)),
    updated_at TEXT NOT NULL CHECK (length(updated_at) > 0)
  ) STRICT, WITHOUT ROWID;
`;
