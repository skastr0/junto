/**
 * Canvas-scoped entity registry with lifecycle.
 *
 * Authorial geometry remains in canvas generations. This table is the durable
 * identity + lifecycle ledger: active members must match on-canvas nodes;
 * archive/soft_delete retain rows without canvas membership.
 */

export const ENTITIES_STATE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS canvas_entities (
    canvas_name TEXT NOT NULL
      CHECK (
        length(canvas_name) BETWEEN 1 AND 64
        AND canvas_name GLOB '[a-z0-9]*'
        AND canvas_name NOT GLOB '*[^a-z0-9_-]*'
      ),
    entity_id TEXT NOT NULL
      CHECK (length(entity_id) BETWEEN 1 AND 256),
    kind TEXT
      CHECK (kind IS NULL OR length(kind) BETWEEN 1 AND 128),
    binding_id TEXT
      CHECK (
        binding_id IS NULL
        OR length(binding_id) BETWEEN 1 AND 256
      ),
    lifecycle TEXT NOT NULL
      CHECK (lifecycle IN ('active', 'archived', 'soft_deleted')),
    created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 1 AND 64),
    updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 1 AND 64),
    archived_at TEXT
      CHECK (archived_at IS NULL OR length(archived_at) BETWEEN 1 AND 64),
    soft_deleted_at TEXT
      CHECK (
        soft_deleted_at IS NULL
        OR length(soft_deleted_at) BETWEEN 1 AND 64
      ),
    PRIMARY KEY (canvas_name, entity_id),
    CHECK (
      (lifecycle = 'active' AND archived_at IS NULL AND soft_deleted_at IS NULL)
      OR (
        lifecycle = 'archived'
        AND archived_at IS NOT NULL
        AND soft_deleted_at IS NULL
      )
      OR (
        lifecycle = 'soft_deleted'
        AND archived_at IS NOT NULL
        AND soft_deleted_at IS NOT NULL
      )
    )
  ) STRICT, WITHOUT ROWID;

  CREATE INDEX IF NOT EXISTS canvas_entities_lifecycle
    ON canvas_entities(canvas_name, lifecycle, updated_at, entity_id);

  -- Only one *active* entity may hold a binding on a canvas. Archived and
  -- soft_deleted rows retain binding_id for audit without blocking re-bind.
  CREATE UNIQUE INDEX IF NOT EXISTS canvas_entities_canvas_binding
    ON canvas_entities(canvas_name, binding_id)
    WHERE binding_id IS NOT NULL AND lifecycle = 'active';
`;
