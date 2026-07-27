import { STORE_STATE_SCHEMA_SQL } from "../../services/store-state-schema";
import { BROWSER_PROFILES_STATE_SCHEMA_SQL } from "../browser/state-schema";
import { BROWSER_TRUST_STATE_SCHEMA_SQL } from "../browser/trust-state-schema";
import { HOSTS_STATE_SCHEMA_SQL } from "../hosts/state-schema";
import { SETTINGS_STATE_SCHEMA_SQL } from "../settings/state-schema";
import { SCHEDULER_STATE_SCHEMA_SQL } from "../scheduler/state-schema";
import { STATION_STATE_SCHEMA_SQL } from "../station/state-schema";
import { STATION_STATUS_STATE_SCHEMA_SQL } from "../station-status-state-schema";
import { USAGE_STATE_SCHEMA_SQL } from "../usage/state-schema";
import { WORK_STATE_SCHEMA_SQL } from "../work/state-schema";

/**
 * Small, explicit schema fragments keep domain ownership visible while the
 * engine still executes one ordinary bootstrap script. This is intentionally
 * not a registration or migration framework: Vellum owns one database and
 * evolves its current schema in place.
 */
export const STATE_METADATA_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS state_metadata (
    key TEXT PRIMARY KEY CHECK (length(key) > 0),
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  INSERT OR IGNORE INTO state_metadata(key, value, updated_at)
  VALUES ('schema', 'vellum/state/v1', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
`;

/**
 * Every canvas commit is one full-map generation. Documents are deliberately
 * repeated per generation: a head can always be reconstructed from rows in a
 * single generation, including an intentionally empty map.
 *
 * Generation is canonical decimal text rather than a JavaScript number so
 * logical ordering remains exact beyond Number.MAX_SAFE_INTEGER.
 */
export const CANVAS_STATE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS canvas_generations (
    generation TEXT PRIMARY KEY
      CHECK (
        length(generation) > 0
        AND generation NOT GLOB '*[^0-9]*'
        AND (generation = '0' OR substr(generation, 1, 1) <> '0')
      ),
    created_at TEXT NOT NULL CHECK (length(created_at) > 0),
    cause TEXT NOT NULL CHECK (length(cause) > 0),
    intent_sha256 TEXT NOT NULL CHECK (length(intent_sha256) = 64),
    document_count INTEGER NOT NULL
      CHECK (document_count >= 0)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS canvas_generation_documents (
    generation TEXT NOT NULL
      REFERENCES canvas_generations(generation) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK (length(name) > 0),
    body TEXT NOT NULL,
    sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
    modified_at TEXT NOT NULL CHECK (length(modified_at) > 0),
    PRIMARY KEY (generation, name)
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS canvas_head (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    generation TEXT NOT NULL
      REFERENCES canvas_generations(generation) ON DELETE RESTRICT
  ) STRICT;
`;

export const STATE_SCHEMA_FRAGMENTS = [
  STATE_METADATA_SCHEMA_SQL,
  CANVAS_STATE_SCHEMA_SQL,
  BROWSER_PROFILES_STATE_SCHEMA_SQL,
  BROWSER_TRUST_STATE_SCHEMA_SQL,
  HOSTS_STATE_SCHEMA_SQL,
  SETTINGS_STATE_SCHEMA_SQL,
  SCHEDULER_STATE_SCHEMA_SQL,
  STATION_STATE_SCHEMA_SQL,
  STATION_STATUS_STATE_SCHEMA_SQL,
  STORE_STATE_SCHEMA_SQL,
  USAGE_STATE_SCHEMA_SQL,
  WORK_STATE_SCHEMA_SQL,
] as const;

/** One engine bootstrap execution; fragments merely make ownership legible. */
export const STATE_SCHEMA_SQL = STATE_SCHEMA_FRAGMENTS.join("\n");
