import { BROWSER_PROFILES_STATE_SCHEMA_SQL } from "../browser/state-schema";
import { BOX_STATE_SCHEMA_SQL } from "../box/state-schema";
import { HOSTS_STATE_SCHEMA_SQL } from "../hosts/state-schema";
import { KERNEL_STATE_SCHEMA_SQL } from "../kernel/state-schema";
import {
  LICENSE_STATE_V1_SCHEMA_SQL,
  LICENSE_STATE_V2_SCHEMA_SQL,
} from "../license/state-schema";
import { FACTORY_PAUSE_STATE_SCHEMA_SQL } from "../pause/state-schema";
import { SETTINGS_STATE_SCHEMA_SQL } from "../settings/state-schema";
import { SCHEDULER_STATE_SCHEMA_SQL } from "../scheduler/state-schema";
import { STATION_STATE_SCHEMA_SQL } from "../station/state-schema";
import { STATION_STATUS_STATE_SCHEMA_SQL } from "../station-status-state-schema";
import { USAGE_STATE_SCHEMA_SQL } from "../usage/state-schema";
import { WORK_STATE_SCHEMA_SQL } from "../work/state-schema";

/**
 * Exact proof of whichever recognized schema version is currently committed.
 * This is not a generic metadata bag: migrations verify the prior witness
 * before writing and stamp the current witness only after the full chain.
 */
export const STATE_SCHEMA_IDENTITY_SQL = `
  CREATE TABLE IF NOT EXISTS state_schema_identity (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    actual_schema_sha256 TEXT NOT NULL
      CHECK (
        length(actual_schema_sha256) = 64
        AND actual_schema_sha256 NOT GLOB '*[^a-f0-9]*'
      ),
    source_schema_sha256 TEXT NOT NULL
      CHECK (
        length(source_schema_sha256) = 64
        AND source_schema_sha256 NOT GLOB '*[^a-f0-9]*'
      ),
    verified_at TEXT NOT NULL
      CHECK (length(verified_at) BETWEEN 1 AND 64)
  ) STRICT;
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

/**
 * Frozen composition of release-one state. The identity test below the
 * migration layer guards this exact source composition against accidental
 * edits; new fragments append to STATE_SCHEMA_FRAGMENTS instead.
 */
export const STATE_SCHEMA_V1_FRAGMENTS = [
  STATE_SCHEMA_IDENTITY_SQL,
  CANVAS_STATE_SCHEMA_SQL,
  BROWSER_PROFILES_STATE_SCHEMA_SQL,
  HOSTS_STATE_SCHEMA_SQL,
  BOX_STATE_SCHEMA_SQL,
  KERNEL_STATE_SCHEMA_SQL,
  FACTORY_PAUSE_STATE_SCHEMA_SQL,
  SETTINGS_STATE_SCHEMA_SQL,
  SCHEDULER_STATE_SCHEMA_SQL,
  STATION_STATE_SCHEMA_SQL,
  STATION_STATUS_STATE_SCHEMA_SQL,
  USAGE_STATE_SCHEMA_SQL,
  WORK_STATE_SCHEMA_SQL,
] as const;

export const STATE_SCHEMA_V1_SQL = STATE_SCHEMA_V1_FRAGMENTS.join("\n");

export const STATE_SCHEMA_V2_FRAGMENTS = [
  ...STATE_SCHEMA_V1_FRAGMENTS,
  LICENSE_STATE_V1_SCHEMA_SQL,
] as const;

export const STATE_SCHEMA_V2_SQL =
  STATE_SCHEMA_V2_FRAGMENTS.join("\n");

export const STATE_SCHEMA_FRAGMENTS = [
  ...STATE_SCHEMA_V2_FRAGMENTS,
  LICENSE_STATE_V2_SCHEMA_SQL,
] as const;

/**
 * Fresh-install and final-verification target for the current version.
 * Historical DDL belongs in forward migrations, never in compatibility
 * branches inside these fragments.
 */
export const STATE_SCHEMA_SQL = STATE_SCHEMA_FRAGMENTS.join("\n");
