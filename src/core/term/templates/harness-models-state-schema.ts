/**
 * What this machine's agent CLIs offer, as their last good scan listed it
 * (`harness-inventory.ts`). A cache: a scan replaces its harness's rows in one
 * transaction (delete its scan row, the cascades clear the rest), and every
 * row can be rebuilt by scanning the CLI again. Added by state migration
 * 22 -> 23, which replaced `~/.junto/state/harness-models.json`.
 *
 * - harness_scans: the scan, keyed by harness, with the fingerprint of the
 *   executable it read (path, size, mtime: an upgrade in place rescans) and
 *   when, in epoch milliseconds.
 * - harness_models: every model, in the CLI's order. `model` is the id the
 *   CLI takes; the provider is the one the harness names, if any.
 * - harness_model_efforts: the efforts a CLI lists for one model (Codex). A
 *   model with none offers its harness's efforts, which are Junto's template
 *   and never stored, so an upgrade of Junto cannot leave them stale.
 * - harness_profiles: the named profiles a harness lists, with the model
 *   each pins.
 * - harness_models_search: trigram full-text search over every model's id,
 *   provider, label and description, kept by the triggers below, so any three
 *   letters of any of them find it. The migration guard refuses
 *   SQLITE_DROP_VTABLE in every step, so a later step that drops or rebuilds
 *   it needs an exemption there first.
 */
export const HARNESS_MODEL_CACHE_STATE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS harness_scans (
    harness TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL,
    version TEXT,
    source TEXT NOT NULL CHECK (source IN ('cache', 'aliases', 'command', 'empty')),
    scanned_at INTEGER NOT NULL
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS harness_models (
    id INTEGER PRIMARY KEY,
    harness TEXT NOT NULL REFERENCES harness_scans(harness) ON DELETE CASCADE,
    model TEXT NOT NULL,
    provider TEXT,
    label TEXT NOT NULL,
    description TEXT,
    position INTEGER NOT NULL,
    UNIQUE (harness, model)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS harness_model_efforts (
    harness TEXT NOT NULL,
    model TEXT NOT NULL,
    effort TEXT NOT NULL,
    position INTEGER NOT NULL,
    PRIMARY KEY (harness, model, effort),
    FOREIGN KEY (harness, model) REFERENCES harness_models(harness, model) ON DELETE CASCADE
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS harness_profiles (
    harness TEXT NOT NULL REFERENCES harness_scans(harness) ON DELETE CASCADE,
    profile TEXT NOT NULL,
    model TEXT,
    position INTEGER NOT NULL,
    PRIMARY KEY (harness, profile)
  ) STRICT, WITHOUT ROWID;

  CREATE VIRTUAL TABLE IF NOT EXISTS harness_models_search USING fts5(
    model, provider, label, description,
    content = 'harness_models', content_rowid = 'id', tokenize = 'trigram'
  );

  CREATE TRIGGER IF NOT EXISTS harness_models_search_insert AFTER INSERT ON harness_models BEGIN
    INSERT INTO harness_models_search(rowid, model, provider, label, description)
    VALUES (new.id, new.model, new.provider, new.label, new.description);
  END;

  CREATE TRIGGER IF NOT EXISTS harness_models_search_delete AFTER DELETE ON harness_models BEGIN
    INSERT INTO harness_models_search(harness_models_search, rowid, model, provider, label, description)
    VALUES ('delete', old.id, old.model, old.provider, old.label, old.description);
  END;

  CREATE TRIGGER IF NOT EXISTS harness_models_search_update AFTER UPDATE ON harness_models BEGIN
    INSERT INTO harness_models_search(harness_models_search, rowid, model, provider, label, description)
    VALUES ('delete', old.id, old.model, old.provider, old.label, old.description);
    INSERT INTO harness_models_search(rowid, model, provider, label, description)
    VALUES (new.id, new.model, new.provider, new.label, new.description);
  END;
`;
