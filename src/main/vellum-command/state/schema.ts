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
  WORK_BOARD_STATE_SCHEMA_SQL,
  WORK_BOARD_STATE_SCHEMA_WITH_TAGS_SQL,
  WORK_CANVAS_REVISIONS_SQL,
  WORK_PAD_STATE_SCHEMA_SQL,
  WORK_PAD_READ_CURSORS_SQL,
  WORK_PROJECTION_REVISION_TRIGGERS_SQL,
  WORK_PROPOSAL_PLANNING_STATE_SCHEMA_SQL,
  WORK_STATE_SCHEMA_BOARD_VOCAB_SQL,
  WORK_STATE_SCHEMA_PAD_VOCAB_SQL,
  WORK_STATE_SCHEMA_PROPOSAL_REJECT_SQL,
  WORK_STATE_SCHEMA_TASK_ARCHIVED_SQL,
  WORK_STATE_SCHEMA_HEAD_BASIS_SQL,
  WORK_STATE_SCHEMA_SQL,
  WORK_STATE_SCHEMA_V3_SQL,
  WORK_TASK_DEPENDENCIES_STATE_SCHEMA_SQL,
  WORK_TASK_FINISH_STATE_SCHEMA_SQL,
  withoutProposalStorage,
} from "../work/state-schema";
import { CANVAS_AUTHORITY_SCHEMA_SQL } from "../canvas/state-schema";

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
  WORK_STATE_SCHEMA_V3_SQL,
] as const;

export const STATE_SCHEMA_V1_SQL = STATE_SCHEMA_V1_FRAGMENTS.join("\n");

export const STATE_SCHEMA_V2_FRAGMENTS = [
  ...STATE_SCHEMA_V1_FRAGMENTS,
  LICENSE_STATE_V1_SCHEMA_SQL,
] as const;

export const STATE_SCHEMA_V2_SQL =
  STATE_SCHEMA_V2_FRAGMENTS.join("\n");

export const STATE_SCHEMA_V3_FRAGMENTS = [
  ...STATE_SCHEMA_V2_FRAGMENTS,
  LICENSE_STATE_V2_SCHEMA_SQL,
] as const;

/** Schema composition at version 5 (before canvas entity registry). */
export const STATE_SCHEMA_V5_FRAGMENTS = STATE_SCHEMA_V3_FRAGMENTS.map(
  (fragment) =>
    fragment === WORK_STATE_SCHEMA_V3_SQL
      ? WORK_STATE_SCHEMA_SQL
      : fragment,
);

export const STATE_SCHEMA_V5_SQL = STATE_SCHEMA_V5_FRAGMENTS.join("\n");

/** Schema composition at version 6 (entity registry; no task dependencies). */
export const STATE_SCHEMA_V6_FRAGMENTS = [
  ...STATE_SCHEMA_V5_FRAGMENTS,
  ENTITIES_STATE_SCHEMA_SQL,
] as const;

export const STATE_SCHEMA_V6_SQL = STATE_SCHEMA_V6_FRAGMENTS.join("\n");

/** Schema composition at version 7 (task dependencies; no finish criteria). */
export const STATE_SCHEMA_V7_FRAGMENTS = [
  ...STATE_SCHEMA_V6_FRAGMENTS,
  WORK_TASK_DEPENDENCIES_STATE_SCHEMA_SQL,
] as const;

export const STATE_SCHEMA_V7_SQL = STATE_SCHEMA_V7_FRAGMENTS.join("\n");

/** Schema composition at version 8 (finish criteria; no board tables). */
export const STATE_SCHEMA_V8_FRAGMENTS = [
  ...STATE_SCHEMA_V7_FRAGMENTS,
  WORK_TASK_FINISH_STATE_SCHEMA_SQL,
] as const;

export const STATE_SCHEMA_V8_SQL = STATE_SCHEMA_V8_FRAGMENTS.join("\n");

/** Schema at version 9: board tables, pre board event vocabulary. */
export const STATE_SCHEMA_V9_FRAGMENTS = [
  ...STATE_SCHEMA_V8_FRAGMENTS,
  WORK_BOARD_STATE_SCHEMA_SQL,
] as const;

export const STATE_SCHEMA_V9_SQL = STATE_SCHEMA_V9_FRAGMENTS.join("\n");

/** Schema at version 10: board tables + board work-event vocabulary. */
export const STATE_SCHEMA_V10_FRAGMENTS = STATE_SCHEMA_V9_FRAGMENTS.map(
  (fragment) =>
    fragment === WORK_STATE_SCHEMA_SQL
      ? WORK_STATE_SCHEMA_BOARD_VOCAB_SQL
      : fragment,
) as unknown as typeof STATE_SCHEMA_V9_FRAGMENTS;

export const STATE_SCHEMA_V10_SQL = STATE_SCHEMA_V10_FRAGMENTS.join("\n");

/** Schema at version 11: proposal planning arms (dependsOn / finishCriteria). */
export const STATE_SCHEMA_V11_FRAGMENTS = [
  ...STATE_SCHEMA_V10_FRAGMENTS,
  WORK_PROPOSAL_PLANNING_STATE_SCHEMA_SQL,
] as const;

export const STATE_SCHEMA_V11_SQL = STATE_SCHEMA_V11_FRAGMENTS.join("\n");

/** Schema at version 12: local content-object manifest tables. */
export const STATE_SCHEMA_V12_FRAGMENTS = [
  ...STATE_SCHEMA_V11_FRAGMENTS,
  CONTENT_STATE_SCHEMA_SQL,
] as const;

export const STATE_SCHEMA_V12_SQL = STATE_SCHEMA_V12_FRAGMENTS.join("\n");

/** Schema at version 13: content inline-media migration marker (pre proposal.reject). */
export const STATE_SCHEMA_V13_FRAGMENTS = [
  ...STATE_SCHEMA_V12_FRAGMENTS,
  CONTENT_INLINE_MEDIA_MIGRATION_SCHEMA_SQL,
] as const;

export const STATE_SCHEMA_V13_SQL = STATE_SCHEMA_V13_FRAGMENTS.join("\n");

/**
 * Schema at version 14: proposal.reject event vocabulary (pre task.archive).
 * Historical V5–V13 keep create/approve-only proposal event vocabulary.
 */
export const STATE_SCHEMA_V14_FRAGMENTS = STATE_SCHEMA_V13_FRAGMENTS.map(
  (fragment) =>
    fragment === WORK_STATE_SCHEMA_BOARD_VOCAB_SQL
      ? WORK_STATE_SCHEMA_PROPOSAL_REJECT_SQL
      : fragment,
) as unknown as typeof STATE_SCHEMA_V13_FRAGMENTS;

export const STATE_SCHEMA_V14_SQL = STATE_SCHEMA_V14_FRAGMENTS.join("\n");

/**
 * Schema at version 15: task archived; board posts without tags_json.
 * Frozen so 15→16 migration can start from a known identity.
 */
export const STATE_SCHEMA_V15_FRAGMENTS = STATE_SCHEMA_V13_FRAGMENTS.map(
  (fragment) =>
    fragment === WORK_STATE_SCHEMA_BOARD_VOCAB_SQL
      ? WORK_STATE_SCHEMA_TASK_ARCHIVED_SQL
      : fragment,
) as unknown as typeof STATE_SCHEMA_V13_FRAGMENTS;

export const STATE_SCHEMA_V15_SQL = STATE_SCHEMA_V15_FRAGMENTS.join("\n");

/**
 * Schema at version 16: board post tags_json; no pad tables.
 * Frozen so 16→17 migration can start from a known identity.
 */
export const STATE_SCHEMA_V16_FRAGMENTS = STATE_SCHEMA_V15_FRAGMENTS.map(
  (fragment) =>
    fragment === WORK_BOARD_STATE_SCHEMA_SQL
      ? WORK_BOARD_STATE_SCHEMA_WITH_TAGS_SQL
      : fragment,
) as unknown as typeof STATE_SCHEMA_V15_FRAGMENTS;

export const STATE_SCHEMA_V16_SQL = STATE_SCHEMA_V16_FRAGMENTS.join("\n");

/**
 * Schema at version 17: pad element tables + pad.patch vocabulary.
 * Frozen so 17→18 can start from a known identity.
 */
export const STATE_SCHEMA_V17_FRAGMENTS = [
  ...(STATE_SCHEMA_V16_FRAGMENTS.map((fragment) =>
    fragment === WORK_STATE_SCHEMA_TASK_ARCHIVED_SQL
      ? WORK_STATE_SCHEMA_PAD_VOCAB_SQL
      : fragment,
  ) as unknown as typeof STATE_SCHEMA_V16_FRAGMENTS),
  WORK_PAD_STATE_SCHEMA_SQL,
];

export const STATE_SCHEMA_V17_SQL = STATE_SCHEMA_V17_FRAGMENTS.join("\n");

/**
 * Schema at version 18: v17 + operator-local pad pin read cursors.
 * Frozen so 18 -> 19 can start from a known identity.
 */
export const STATE_SCHEMA_V18_FRAGMENTS = [
  ...STATE_SCHEMA_V17_FRAGMENTS,
  WORK_PAD_READ_CURSORS_SQL,
];

export const STATE_SCHEMA_V18_SQL = STATE_SCHEMA_V18_FRAGMENTS.join("\n");

/**
 * Schema at version 19: v18 + the per-canvas Work revision counter that
 * replaces the O(world) UNION ALL count the runtime projection used to scan
 * on every read. It comes last because its triggers reference the Work event,
 * board and pad tables every earlier fragment declares.
 * Frozen so 19 -> 20 can start from a known identity.
 */
export const STATE_SCHEMA_V19_FRAGMENTS = [
  ...STATE_SCHEMA_V18_FRAGMENTS,
  WORK_CANVAS_REVISIONS_SQL,
];

export const STATE_SCHEMA_V19_SQL = STATE_SCHEMA_V19_FRAGMENTS.join("\n");

/**
 * Schema at version 20: v19 + revision triggers on every remaining table the runtime Work
 * projection reads.
 * Frozen so 20 -> 21 can start from a known identity.
 */
export const STATE_SCHEMA_V20_FRAGMENTS = [
  ...STATE_SCHEMA_V19_FRAGMENTS,
  WORK_PROJECTION_REVISION_TRIGGERS_SQL,
];

export const STATE_SCHEMA_V20_SQL = STATE_SCHEMA_V20_FRAGMENTS.join("\n");

/**
 * Current (version 21): relational canvas authority replaces the blob
 * generation store, and the work fact basis resolves against the portfolio
 * head. The 20 -> 21 consolidation step performs the equivalent surgery on
 * installed databases; fresh installs compose the end state directly.
 */
export const STATE_SCHEMA_FRAGMENTS = STATE_SCHEMA_V20_FRAGMENTS.map(
  (fragment) =>
    fragment === CANVAS_STATE_SCHEMA_SQL
      ? CANVAS_AUTHORITY_SCHEMA_SQL
      : fragment === WORK_STATE_SCHEMA_PAD_VOCAB_SQL
        ? WORK_STATE_SCHEMA_HEAD_BASIS_SQL
        : fragment,
) as unknown as typeof STATE_SCHEMA_V20_FRAGMENTS;

/**
 * Fresh-install and final-verification target for the current version.
 * Historical DDL belongs in forward migrations, never in compatibility
 * branches inside these fragments.
 */
export const STATE_SCHEMA_SQL = withoutProposalStorage(
  STATE_SCHEMA_FRAGMENTS.join("\n"),
);
