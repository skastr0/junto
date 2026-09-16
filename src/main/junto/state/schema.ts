import { BROWSER_PROFILES_STATE_SCHEMA_SQL } from "../browser/state-schema";
import { BOX_STATE_SCHEMA_SQL } from "../box/state-schema";
import { ENTITIES_STATE_SCHEMA_SQL } from "../entities/state-schema";
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
import {
  CONTENT_INLINE_MEDIA_MIGRATION_SCHEMA_SQL,
  CONTENT_STATE_SCHEMA_SQL,
} from "../content/state-schema";
import {
  WORK_BOARD_STATE_SCHEMA_WITH_TAGS_SQL,
  WORK_CANVAS_REVISIONS_SQL,
  WORK_PAD_STATE_SCHEMA_SQL,
  WORK_PAD_READ_CURSORS_SQL,
  WORK_PROJECTION_REVISION_TRIGGERS_SQL,
  WORK_PROPOSAL_PLANNING_STATE_SCHEMA_SQL,
  WORK_STATE_SCHEMA_HEAD_BASIS_SQL,
  WORK_TASK_DEPENDENCIES_STATE_SCHEMA_SQL,
  WORK_TASK_FINISH_STATE_SCHEMA_SQL,
  withoutProposalStorage,
} from "../work/state-schema";
import { CANVAS_AUTHORITY_SCHEMA_SQL } from "../canvas/state-schema";
import { OPENAI_CREDENTIAL_BINDINGS_SQL, PROVIDER_CREDENTIAL_BINDINGS_SQL } from "../credentials/state-schema";
import { OVERSEER_LIVE_STATE_SCHEMA_SQL } from "../overseer/live/state-schema";
import { CREW_STATE_SCHEMA_SQL } from "../work/crew-schema";

/**
 * Schema identity table: `actual_schema_sha256` is the sole witness (live DDL
 * shape). `source_schema_sha256` is expand-only retained storage — never used
 * for admission; current code stamps a fixed retired sentinel.
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
 * Junto schema version 1 is the single durable baseline: the product rename
 * re-baselines the whole schema at its current shape, with the relational
 * canvas authority, head-basis fact resolution, crew mail-attempt and
 * review-verdict tables, the Live journal, and credential bindings composed
 * directly. There is no historical chain beneath it; the next schema change
 * appends `1 -> 2`.
 */
export const STATE_SCHEMA_V1_FRAGMENTS = [
  STATE_SCHEMA_IDENTITY_SQL,
  CANVAS_AUTHORITY_SCHEMA_SQL,
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
  WORK_STATE_SCHEMA_HEAD_BASIS_SQL,
  LICENSE_STATE_V1_SCHEMA_SQL,
  LICENSE_STATE_V2_SCHEMA_SQL,
  ENTITIES_STATE_SCHEMA_SQL,
  WORK_TASK_DEPENDENCIES_STATE_SCHEMA_SQL,
  WORK_TASK_FINISH_STATE_SCHEMA_SQL,
  WORK_BOARD_STATE_SCHEMA_WITH_TAGS_SQL,
  WORK_PROPOSAL_PLANNING_STATE_SCHEMA_SQL,
  CONTENT_STATE_SCHEMA_SQL,
  CONTENT_INLINE_MEDIA_MIGRATION_SCHEMA_SQL,
  WORK_PAD_STATE_SCHEMA_SQL,
  WORK_PAD_READ_CURSORS_SQL,
  WORK_CANVAS_REVISIONS_SQL,
  WORK_PROJECTION_REVISION_TRIGGERS_SQL,
  PROVIDER_CREDENTIAL_BINDINGS_SQL,
  OPENAI_CREDENTIAL_BINDINGS_SQL,
  OVERSEER_LIVE_STATE_SCHEMA_SQL,
  CREW_STATE_SCHEMA_SQL,
] as const;

export const STATE_SCHEMA_V1_SQL = withoutProposalStorage(
  STATE_SCHEMA_V1_FRAGMENTS.join("\n"),
);

/**
 * Fresh-install and final-verification target for the current version.
 * Historical DDL belongs in forward migrations, never in compatibility
 * branches inside these fragments.
 */
export const STATE_SCHEMA_SQL = STATE_SCHEMA_V1_SQL;
