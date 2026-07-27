/**
 * Station health is a set of bounded facts, not one mutable JSON document.
 *
 * Singleton facts use an empty `host_id`; host receipts use their canonical
 * host id. Projection generations are canonical decimal text so ordering is
 * exact after JavaScript's safe-integer boundary.
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
            'pull',
            'last-configure',
            'configure',
            'kernel',
            'deployment',
            'last-projection',
            'projection'
          )
        ),
      host_id TEXT NOT NULL CHECK (length(host_id) <= 64),
      record_json TEXT NOT NULL
        CHECK (
          json_valid(record_json)
          AND json_type(record_json) = 'object'
        ),
      projection_generation TEXT
        CHECK (
          projection_generation IS NULL
          OR (
            length(projection_generation) > 0
            AND length(projection_generation) <= 32
            AND projection_generation NOT GLOB '*[^0-9]*'
            AND (
              projection_generation = '0'
              OR substr(projection_generation, 1, 1) <> '0'
            )
          )
        ),
      updated_at TEXT NOT NULL CHECK (length(updated_at) > 0),
      PRIMARY KEY (kind, host_id),
      CHECK (
        (
          kind IN ('pull', 'last-configure', 'kernel', 'last-projection')
          AND host_id = ''
        )
        OR (
          kind IN ('configure', 'deployment', 'projection')
          AND length(host_id) > 0
        )
      ),
      CHECK (
        (
          kind IN ('last-projection', 'projection')
          AND projection_generation IS NOT NULL
        )
        OR (
          kind NOT IN ('last-projection', 'projection')
          AND projection_generation IS NULL
        )
      )
    ) STRICT, WITHOUT ROWID
  `,
  `
    CREATE INDEX IF NOT EXISTS station_status_projection_generation_idx
      ON station_status_facts(
        length(projection_generation),
        projection_generation
      )
      WHERE projection_generation IS NOT NULL
  `,
] as const;

export const STATION_STATUS_STATE_SCHEMA_SQL =
  `${STATION_STATUS_STATE_SCHEMA_STATEMENTS.join(";\n")};\n`;
