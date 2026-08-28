/**
 * Install-ops schema — intentionally tiny and independent of product
 * `user_version` / `state_schema_identity`. Bump INSTALL_OPS_SCHEMA_VERSION
 * and append forward steps only when this file evolves.
 */

export const INSTALL_OPS_SCHEMA_VERSION = 1 as const;

/** Stable backfill ids — never reuse a completed id for a different walk. */
export const BACKFILL_INLINE_MEDIA_V1 = "content.inline-media.v1" as const;
export const BACKFILL_CANVAS_RELATIONAL_V1 = "canvas.relational.v1" as const;
export const BACKFILL_CANVAS_RELATIONAL_V2 = "canvas.relational.v2" as const;

export const INSTALL_OPS_SCHEMA_SQL = `
  CREATE TABLE backfill_markers (
    id TEXT PRIMARY KEY
      CHECK (length(id) BETWEEN 1 AND 128),
    status TEXT NOT NULL
      CHECK (status IN ('pending', 'complete')),
    objects_ingested INTEGER NOT NULL DEFAULT 0
      CHECK (
        typeof(objects_ingested) = 'integer'
        AND objects_ingested >= 0
      ),
    completed_at TEXT
      CHECK (
        completed_at IS NULL
        OR length(completed_at) BETWEEN 1 AND 64
      )
  ) STRICT;
`;
