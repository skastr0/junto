/**
 * Host enrollment is durable application state, not a user-editable file.
 *
 * The local row stores presentation only. Its identity and capabilities are
 * projected from code at runtime. Remote capability sets are represented as a
 * non-zero bit mask, making duplicate or empty claims unrepresentable in the
 * database. `effective_hermes_id` is null for remotes without Hermes and
 * unique for every host that participates in Hermes routing.
 */
export const HOSTS_STATE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS host_registry (
    id TEXT PRIMARY KEY
      CHECK (
        length(id) BETWEEN 1 AND 64
        AND substr(id, 1, 1) GLOB '[A-Za-z0-9]'
        AND id NOT GLOB '*[^A-Za-z0-9._-]*'
      ),
    label TEXT NOT NULL
      CHECK (length(label) BETWEEN 1 AND 64),
    kind TEXT NOT NULL
      CHECK (kind IN ('local', 'remote')),
    endpoint TEXT UNIQUE,
    capability_mask INTEGER,
    hermes_id TEXT
      CHECK (
        hermes_id IS NULL
        OR (
          length(hermes_id) BETWEEN 1 AND 64
          AND substr(hermes_id, 1, 1) GLOB '[A-Za-z0-9]'
          AND hermes_id NOT GLOB '*[^A-Za-z0-9._-]*'
        )
      ),
    effective_hermes_id TEXT UNIQUE,
    appearance_color TEXT,
    appearance_glyph TEXT,
    sort_order INTEGER NOT NULL UNIQUE
      CHECK (sort_order >= 0),
    CHECK (
      (
        kind = 'local'
        AND id = 'local'
        AND endpoint IS NULL
        AND capability_mask IS NULL
        AND sort_order = 0
      )
      OR
      (
        kind = 'remote'
        AND id <> 'local'
        AND endpoint IS NOT NULL
        AND length(endpoint) BETWEEN 1 AND 255
        AND capability_mask BETWEEN 1 AND 15
        AND sort_order > 0
      )
    ),
    CHECK (
      (
        (
          kind = 'local'
          OR (capability_mask & 8) <> 0
        )
        AND effective_hermes_id IS NOT NULL
        AND effective_hermes_id = coalesce(hermes_id, id)
      )
      OR
      (
        kind = 'remote'
        AND (capability_mask & 8) = 0
        AND effective_hermes_id IS NULL
      )
    )
  ) STRICT;

  CREATE TABLE IF NOT EXISTS host_registry_state (
    singleton INTEGER PRIMARY KEY
      CHECK (singleton = 1),
    version INTEGER NOT NULL
      CHECK (version = 1),
    initialized_at TEXT NOT NULL
      CHECK (length(initialized_at) > 0)
  ) STRICT;

  CREATE TRIGGER IF NOT EXISTS host_registry_retain_local
  BEFORE DELETE ON host_registry
  WHEN OLD.id = 'local'
  BEGIN
    SELECT RAISE(ABORT, 'the local host is immutable');
  END;
`;
