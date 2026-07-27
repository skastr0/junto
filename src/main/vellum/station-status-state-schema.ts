/**
 * Station health is a set of bounded facts, not one mutable JSON document.
 *
 * Singleton facts use an empty `host_id`; deployment receipts use their
 * canonical host id. Configuration, projection, and logical cursor facts live
 * in the normalized StationRepository tables and must never be mirrored here.
 *
 * This module stays pure so the sole StateEngine bootstrap can assemble the
 * schema without importing the repository (and therefore without creating a
 * state-engine module cycle).
 */
export const STATION_STATUS_STATE_SCHEMA_STATEMENTS = [
  `
    CREATE TABLE IF NOT EXISTS station_status_facts (
      kind TEXT NOT NULL
        CHECK (
          kind IN (
            'kernel',
            'deployment'
          )
        ),
      host_id TEXT NOT NULL CHECK (length(host_id) <= 64),
      record_json TEXT NOT NULL
        CHECK (
          json_valid(record_json)
          AND json_type(record_json) = 'object'
        ),
      updated_at TEXT NOT NULL CHECK (length(updated_at) > 0),
      PRIMARY KEY (kind, host_id),
      CHECK (
        (kind = 'kernel' AND host_id = '')
        OR (kind = 'deployment' AND length(host_id) > 0)
      )
    ) STRICT, WITHOUT ROWID
  `,
] as const;

export const STATION_STATUS_STATE_SCHEMA_SQL =
  `${STATION_STATUS_STATE_SCHEMA_STATEMENTS.join(";\n")};\n`;
