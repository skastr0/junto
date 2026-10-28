import { BROWSER_PROFILES_STATE_SCHEMA_SQL, BROWSER_TOUCHED_ORIGINS_STATE_SCHEMA_SQL } from "../browser/state-schema";
import { MODEL_STATE_SCHEMA_SQL } from "../model/state-schema";
import { HOSTS_STATE_SCHEMA_SQL, MACHINE_REGISTRY_STATE_SCHEMA_SQL } from "../hosts/state-schema";
import { MACHINE_STATE_SCHEMA_SQL } from "../machines/state-schema";
import {
  LICENSE_STATE_V1_SCHEMA_SQL,
  LICENSE_STATE_V2_SCHEMA_SQL,
} from "../license/state-schema";
import { FACTORY_PAUSE_STATE_SCHEMA_SQL } from "../pause/state-schema";
import { SETTINGS_STATE_SCHEMA_SQL } from "../settings/state-schema";
import { AUTOMATION_NODE_ARCHIVES_SQL, AUTOMATION_RULING_CURSORS_SQL, AUTOMATION_STATE_SCHEMA_SQL } from "../automation/state-schema";
import { STATION_STATUS_STATE_SCHEMA_SQL } from "../station-status-state-schema";
import { USAGE_STATE_SCHEMA_SQL } from "../usage/state-schema";
import {
  CONTENT_INLINE_MEDIA_MIGRATION_SCHEMA_SQL,
  CONTENT_STATE_SCHEMA_SQL,
} from "../content/state-schema";
import { WORK_STATE_SCHEMA_SQL } from "../work/state-schema";
import { WORK_MENTIONS_SQL } from "../work/mention-state-schema";
import {
  ARTIFACT_LABEL_COLOURS_STATE_SCHEMA_SQL,
  ARTIFACT_LABELS_STATE_SCHEMA_SQL,
  ARTIFACT_LINKS_STATE_SCHEMA_SQL,
  ARTIFACTS_STATE_SCHEMA_SQL,
} from "../work/artifact-state-schema";
import { TASK_SEAT_RELEASES_SQL, TASKS_STATE_SCHEMA_SQL } from "../work/task-state-schema";
import { SHOT_PURGES_SQL } from "../work/shot-purge-schema";
import { RESOURCE_RULINGS_STATE_SCHEMA_SQL } from "../work/resource-rulings-schema";
import {
  CANVAS_COPY_HISTORY_STATE_SCHEMA_SQL,
  WORK_EXCHANGE_STATE_SCHEMA_SQL,
  AUTOMATION_PLACEMENTS_STATE_SCHEMA_SQL,
} from "../work/exchange/state-schema";
import { OPENAI_CREDENTIAL_BINDINGS_SQL, PROVIDER_CREDENTIAL_BINDINGS_SQL } from "../credentials/state-schema";
import { OVERSEER_LIVE_STATE_SCHEMA_SQL } from "../overseer/live/state-schema";
import { CREW_STATE_SCHEMA_SQL } from "../work/crew-schema";
import {
  AGENT_SIGNAL_ATTACHMENTS_STATE_SCHEMA_SQL,
  AGENT_SIGNAL_PARTS_STATE_SCHEMA_SQL,
  AGENT_SIGNALS_STATE_SCHEMA_SQL,
} from "../signals/state-schema";
import { SQUADS_STATE_SCHEMA_SQL } from "../squads/state-schema";
import { PORTRAIT_OVERRIDES_STATE_SCHEMA_SQL } from "../portraits/state-schema";
import { COMPANION_DEVICES_STATE_SCHEMA_SQL } from "../companion/state-schema";
import { SEAT_GUIDANCE_STATE_SCHEMA_SQL } from "../seat-guidance/state-schema";
import { AGENT_PROFILES_STATE_SCHEMA_SQL } from "../profiles/state-schema";
import {
  SEAT_CONTINUATIONS_OWED_STATE_SCHEMA_SQL,
  SEAT_OFFBOARD_CLOCK_STATE_SCHEMA_SQL,
  SEAT_SESSION_DRAINS_STATE_SCHEMA_SQL,
  SEAT_SESSIONS_STATE_SCHEMA_SQL,
} from "../seat-sessions/state-schema";
import { APP_TEXTS_STATE_SCHEMA_SQL } from "../references/state-schema";
import { HARNESS_MODEL_CACHE_STATE_SCHEMA_SQL } from "../term/templates/harness-models-state-schema";
import { VIEW_STATE_SCHEMA_SQL } from "../view-state/state-schema";

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

/** The machine list's bookkeeping table, as the hosts schema declares it. */
const HOST_REGISTRY_STATE_TABLE_SQL = (() => {
  const start = HOSTS_STATE_SCHEMA_SQL.indexOf("CREATE TABLE IF NOT EXISTS host_registry_state");
  const end = HOSTS_STATE_SCHEMA_SQL.indexOf(";", start);
  if (start < 0 || end < 0) throw new Error("the hosts schema lost its bookkeeping table");
  return `${HOSTS_STATE_SCHEMA_SQL.slice(start, end)};`;
})();

/**
 * The current durable schema, one fragment per owner. Version 1 was the
 * baseline; each later change is a forward step in `migrations.ts`.
 */
export const STATE_SCHEMA_FRAGMENTS = [
  STATE_SCHEMA_IDENTITY_SQL,
  MODEL_STATE_SCHEMA_SQL,
  BROWSER_PROFILES_STATE_SCHEMA_SQL,
  BROWSER_TOUCHED_ORIGINS_STATE_SCHEMA_SQL,
  MACHINE_REGISTRY_STATE_SCHEMA_SQL,
  HOST_REGISTRY_STATE_TABLE_SQL,
  FACTORY_PAUSE_STATE_SCHEMA_SQL,
  SETTINGS_STATE_SCHEMA_SQL,
  MACHINE_STATE_SCHEMA_SQL,
  STATION_STATUS_STATE_SCHEMA_SQL,
  USAGE_STATE_SCHEMA_SQL,
  WORK_STATE_SCHEMA_SQL,
  WORK_MENTIONS_SQL,
  RESOURCE_RULINGS_STATE_SCHEMA_SQL,
  ARTIFACTS_STATE_SCHEMA_SQL,
  ARTIFACT_LINKS_STATE_SCHEMA_SQL,
  ARTIFACT_LABELS_STATE_SCHEMA_SQL,
  ARTIFACT_LABEL_COLOURS_STATE_SCHEMA_SQL,
  TASKS_STATE_SCHEMA_SQL,
  AUTOMATION_STATE_SCHEMA_SQL,
  AUTOMATION_NODE_ARCHIVES_SQL,
  AUTOMATION_RULING_CURSORS_SQL,
  TASK_SEAT_RELEASES_SQL,
  SHOT_PURGES_SQL,
  LICENSE_STATE_V1_SCHEMA_SQL,
  LICENSE_STATE_V2_SCHEMA_SQL,
  CONTENT_STATE_SCHEMA_SQL,
  CONTENT_INLINE_MEDIA_MIGRATION_SCHEMA_SQL,
  PROVIDER_CREDENTIAL_BINDINGS_SQL,
  OPENAI_CREDENTIAL_BINDINGS_SQL,
  OVERSEER_LIVE_STATE_SCHEMA_SQL,
  CREW_STATE_SCHEMA_SQL,
  AGENT_SIGNALS_STATE_SCHEMA_SQL,
  SQUADS_STATE_SCHEMA_SQL,
  PORTRAIT_OVERRIDES_STATE_SCHEMA_SQL,
  COMPANION_DEVICES_STATE_SCHEMA_SQL,
  SEAT_GUIDANCE_STATE_SCHEMA_SQL,
  AGENT_PROFILES_STATE_SCHEMA_SQL,
  SEAT_SESSIONS_STATE_SCHEMA_SQL,
  AGENT_SIGNAL_ATTACHMENTS_STATE_SCHEMA_SQL,
  SEAT_SESSION_DRAINS_STATE_SCHEMA_SQL,
  AGENT_SIGNAL_PARTS_STATE_SCHEMA_SQL,
  APP_TEXTS_STATE_SCHEMA_SQL,
  WORK_EXCHANGE_STATE_SCHEMA_SQL,
  CANVAS_COPY_HISTORY_STATE_SCHEMA_SQL,
  AUTOMATION_PLACEMENTS_STATE_SCHEMA_SQL,
  SEAT_CONTINUATIONS_OWED_STATE_SCHEMA_SQL,
  SEAT_OFFBOARD_CLOCK_STATE_SCHEMA_SQL,
  HARNESS_MODEL_CACHE_STATE_SCHEMA_SQL,
  VIEW_STATE_SCHEMA_SQL,
] as const;


/**
 * Fresh-install and final-verification target for the current version.
 * Historical DDL belongs in forward migrations, never in these fragments.
 */
export const STATE_SCHEMA_SQL = STATE_SCHEMA_FRAGMENTS.join("\n");
