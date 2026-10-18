/**
 * The model lists this machine's agent CLIs last gave, one row per harness,
 * keyed by the executable they came from (`harness-inventory.ts`). A cache:
 * every row can be rebuilt by scanning the CLI again, so a row that no longer
 * reads is dropped, never repaired. Added by state migration 22 -> 23, which
 * replaced `~/.junto/state/harness-models.json`.
 */
export const HARNESS_MODEL_CACHE_STATE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS harness_model_cache (
    harness TEXT PRIMARY KEY CHECK (length(harness) BETWEEN 1 AND 64),
    fingerprint TEXT NOT NULL CHECK (length(fingerprint) BETWEEN 1 AND 8192),
    scanned_at INTEGER NOT NULL CHECK (scanned_at >= 0),
    version TEXT CHECK (version IS NULL OR length(version) BETWEEN 1 AND 64),
    result TEXT NOT NULL CHECK (json_valid(result)),
    profiles TEXT CHECK (profiles IS NULL OR json_valid(profiles))
  ) STRICT, WITHOUT ROWID;
`;
