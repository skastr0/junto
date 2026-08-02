/**
 * S7-platform-imports — Effect V4 import map prep (inventory only).
 *
 * Product remains on effect@3.21 + independently versioned @effect/* packages.
 * Do **not** rewrite live imports to V4 paths until the product pins a single
 * effect@4 + matching platform-* set (Playground/effect MIGRATION.md). Half
 * renames on 3.21 would not resolve and would thrash open S4 packs.
 *
 * Source: `/Users/developer/Playground/effect/migration/v3-to-v4.md`
 * Contract: `docs/END_STATE-effect-foundation.md` §S7 / R7-platform
 *
 * Scope of this inventory: `src/main/vellum/ssh/**`, `src/cli/**` only.
 */

/**
 * v3 import path → V4 destination (direct module; barrel note in comment).
 * Keys are exact strings used (or typed) under owned paths today.
 */
export const S7_EFFECT_V4_IMPORT_MAP = {
  // --- @effect/platform → core effect or effect/unstable ---
  "@effect/platform/FileSystem": "effect/FileSystem",
  // platform Command is process spawn, not @effect/cli Command
  "@effect/platform/Command": "effect/unstable/process/ChildProcess",
  "@effect/platform/CommandExecutor":
    "effect/unstable/process/ChildProcessSpawner",

  // --- @effect/cli → effect/unstable/cli ---
  "@effect/cli": "effect/unstable/cli (barrel)",
  "@effect/cli/Args": "effect/unstable/cli/Argument",
  "@effect/cli/Command": "effect/unstable/cli/Command",
  "@effect/cli/Options": "effect/unstable/cli/Flag",
  "@effect/cli/HelpDoc": "effect/unstable/cli/HelpDoc",
  "@effect/cli/Prompt": "effect/unstable/cli/Prompt",

  // --- effect core renames used under cli/** ---
  "effect/JSONSchema": "effect/JsonSchema",

  // --- platform-* remain separate packages (bump version with effect@4) ---
  "@effect/platform-node": "@effect/platform-node (stays; version lockstep V4)",
  "@effect/platform-node/NodeFileSystem":
    "@effect/platform-node/NodeFileSystem (stays; ParcelWatcher removed in V4)",
  "@effect/platform-node/NodeSink":
    "partial: stdout/stderr → effect/Stdio; stdin manual (see v3-to-v4 curated notes)",
  "@effect/platform-node/NodeStream":
    "@effect/platform-node (API shape change; see v3-to-v4 curated notes)",
  "@effect/platform-bun": "@effect/platform-bun (stays; version lockstep V4)",
  "@effect/platform-bun/BunContext":
    "@effect/platform-bun (no single module replacement; BunServices pattern)",
  "@effect/platform-bun/BunRuntime":
    "@effect/platform-bun (runtime keep-alive; see fiber-keep-alive.md)",
} as const;

export type S7EffectV4ImportMapKey = keyof typeof S7_EFFECT_V4_IMPORT_MAP;

/**
 * Live inventory snapshot (rg under ssh/** + cli/** at pack time).
 * Counts are comment evidence for reviewers — not runtime truth.
 *
 * | module | sites (approx) | files |
 * |---|---|---|
 * | @effect/cli | 5 | cli/main.ts, cli/commands/* |
 * | @effect/platform/FileSystem | 1 | ssh/service.ts |
 * | @effect/platform/Command | 3 | ssh/service.ts, program.ts, process-spawner.ts |
 * | @effect/platform-node/* | 3 | ssh/live.ts, process-spawner.ts |
 * | @effect/platform-bun | 1 | cli/main.ts |
 * | effect/JSONSchema | 1 | cli/core/discovery.ts |
 * | Context.Tag (service ids) | 5 | SshTransport, SshTransportConfig, ProcessSpawner, WorkSocket, OperatorSocket — S4 owns Tag→Service; listed only for dual-path guard |
 *
 * package.json peers (3.21 line, intentional — no V4 bump in this pack):
 * - effect ^3.21.x
 * - @effect/platform ^0.96
 * - @effect/cli ^0.75
 * - @effect/platform-node ^0.106
 * - @effect/platform-bun ^0.89
 */
export const S7_IMPORT_MAP_PREP_META = {
  pack: "S7-platform-imports",
  effectPin: "3.21",
  rewriteLiveImports: false,
  dualImportShims: false,
} as const;
