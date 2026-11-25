/**
 * Install-ops schema — intentionally tiny and independent of product
 * `user_version` / `state_schema_identity`. Bump INSTALL_OPS_SCHEMA_VERSION
 * and append forward steps only when this file evolves.
 */

export const INSTALL_OPS_SCHEMA_VERSION = 4 as const;

/** Stable backfill ids — never reuse a completed id for a different walk. */
export const BACKFILL_INLINE_MEDIA_V1 = "content.inline-media.v1" as const;
/** Project every artifact head body's backlinks, for bodies written before step 52 (0.11, 02). */
export const BACKFILL_ARTIFACT_LINKS_V1 = "artifact-links.v1" as const;
export const BACKFILL_CANVAS_RELATIONAL_V1 = "canvas.relational.v1" as const;
export const BACKFILL_CANVAS_RELATIONAL_V2 = "canvas.relational.v2" as const;

export const INSTALL_OPS_V1_SCHEMA_SQL = `
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

/** The coordinator's per-build attempt latch; install-local bookkeeping only. */
export const MACHINE_UPDATE_LATCHES_SQL = `
  CREATE TABLE machine_update_latches (
    machine_name TEXT PRIMARY KEY
      CHECK (length(machine_name) BETWEEN 1 AND 64),
    target_build TEXT NOT NULL
      CHECK (length(target_build) = 64),
    outcome TEXT NOT NULL
      CHECK (outcome IN ('rolled-back', 'start-failed', 'stop-unconfirmed', 'uncertain', 'activated', 'needs-signed-release')),
    at TEXT NOT NULL
      CHECK (length(at) BETWEEN 1 AND 64)
  ) STRICT;
`;

/** The version 2 ledger, kept as shipped and never rewritten. */
export const INSTALL_OPS_V2_SCHEMA_SQL = `${INSTALL_OPS_V1_SCHEMA_SQL}
${MACHINE_UPDATE_LATCHES_SQL}`;

/** Version 3 keys every automatic attempt by the pin's installation id. */
export const MACHINE_UPDATE_ATTEMPTS_SQL = `
  CREATE TABLE machine_update_attempts (
    installation_id TEXT PRIMARY KEY
      CHECK (length(installation_id) BETWEEN 1 AND 128),
    target_build TEXT NOT NULL
      CHECK (length(target_build) = 64),
    outcome TEXT NOT NULL
      CHECK (outcome IN ('attempting', 'rolled-back', 'start-failed', 'stop-unconfirmed', 'uncertain', 'activated', 'failed', 'needs-signed-release')),
    at TEXT NOT NULL
      CHECK (length(at) BETWEEN 1 AND 64)
  ) STRICT;
`;

/** The version 3 ledger, kept as shipped and never rewritten. */
export const INSTALL_OPS_V3_SCHEMA_SQL = `${INSTALL_OPS_V2_SCHEMA_SQL}
${MACHINE_UPDATE_ATTEMPTS_SQL}`;

/**
 * A send whose setup the far refused with the S4 pin rule: this machine's
 * last word about that name, with the far's installation id and the route it
 * was reached over. Install-local bookkeeping only: it is dropped by the
 * next send, a remove, or a route change, and never travels with junto.db.
 */
export const MACHINE_SETUP_REFUSALS_SQL = `
  CREATE TABLE machine_setup_refusals (
    machine_name TEXT PRIMARY KEY
      CHECK (length(machine_name) BETWEEN 1 AND 64),
    installation_id TEXT NOT NULL
      CHECK (length(installation_id) BETWEEN 1 AND 128),
    route TEXT NOT NULL
      CHECK (length(route) BETWEEN 1 AND 4096),
    recorded_at TEXT NOT NULL
      CHECK (length(recorded_at) BETWEEN 1 AND 64)
  ) STRICT;
`;

export const INSTALL_OPS_SCHEMA_SQL = `${INSTALL_OPS_V3_SCHEMA_SQL}
${MACHINE_SETUP_REFUSALS_SQL}`;
