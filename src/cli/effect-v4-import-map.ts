/**
 * S7-platform-imports — Effect V4 import map prep (inventory + map only).
 *
 * Product remains on effect@3.21 + independently versioned @effect/* packages.
 * Do **not** rewrite live imports to V4 paths until the product pins a single
 * effect@4 + matching platform-* set (Playground/effect MIGRATION.md). Half
 * renames on 3.21 would not resolve and would thrash open packs.
 *
 * Source of truth: `/Users/developer/Playground/effect/migration/v3-to-v4.md`
 * Contract: `docs/END_STATE-effect-foundation.md` §S7 / R7-platform
 *
 * Path ownership: `src/main/vellum/ssh/**`, `src/cli/**`, package.json (pin only).
 * Consolidation: one map, zero dual v1/v2 import shims, zero live dual paths.
 */

/**
 * v3 import path → V4 destination (direct module; barrel note in comment).
 * Keys cover every @effect/* / effect/* rename site under owned paths, plus
 * near-neighbor modules reviewers will hit on the full V4 pin.
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
  "@effect/cli/ValidationError": "effect/unstable/cli/CliError",
  "@effect/cli/BuiltInOptions": "effect/unstable/cli/GlobalFlag",
  "@effect/cli/CliApp": "effect/unstable/cli/Command (CliApp folded into Command)",

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
  "@effect/platform-node/NodeCommandExecutor":
    "@effect/platform-node/NodeChildProcessSpawner",
  "@effect/platform-node/NodeContext":
    "@effect/platform-node NodeServices (ChildProcessSpawner + Crypto + Stdio; no WorkerManager)",
  "@effect/platform-bun": "@effect/platform-bun (stays; version lockstep V4)",
  "@effect/platform-bun/BunContext":
    "@effect/platform-bun BunServices (ChildProcessSpawner, Crypto, FileSystem, Path, Stdio, Terminal; add BunWorker separately)",
  "@effect/platform-bun/BunRuntime":
    "@effect/platform-bun (runtime keep-alive; see fiber-keep-alive.md)",
  "@effect/platform-bun/BunCommandExecutor":
    "@effect/platform-bun BunChildProcessSpawner.layer",
} as const;

export type S7EffectV4ImportMapKey = keyof typeof S7_EFFECT_V4_IMPORT_MAP;

/**
 * High-value API renames for symbols actually (or likely) used under owned paths.
 * Import path map alone is not enough for Command → ChildProcess pin day.
 * Source lines: Playground/effect/migration/v3-to-v4.md §@effect/platform/Command
 */
export const S7_PLATFORM_COMMAND_API_RENAMES = {
  "Command.Command": "ChildProcess.Command",
  "Command.StandardCommand": "ChildProcess.StandardCommand",
  "Command.PipedCommand": "ChildProcess.PipedCommand",
  "Command.make": "ChildProcess.make",
  "Command.env": "ChildProcess.setEnv",
  "Command.workingDirectory": "ChildProcess.setCwd",
  "Command.stdin / stdout / stderr / feed / runInShell":
    "ChildProcess.CommandOptions fields at make-time (combinators removed)",
  "Command.start / string / lines / stream / streamLines / exitCode":
    "ChildProcessSpawner.* (or yield Effectable ChildProcess.Command)",
  "CommandExecutor.CommandExecutor": "ChildProcessSpawner.ChildProcessSpawner",
} as const;

/**
 * Live inventory under ssh/** + cli/** (rg snapshot at pack time).
 * Counts are review evidence — not runtime truth.
 *
 * | module | sites | files |
 * |---|---|---|
 * | @effect/cli (Args/Command/Options barrel) | 5 | cli/main.ts, cli/commands/{discovery,work,content,operator}.ts |
 * | @effect/platform/FileSystem | 1 | ssh/service.ts |
 * | @effect/platform/Command | 3 | ssh/service.ts (type), program.ts, process-spawner.ts |
 * | @effect/platform-node/NodeFileSystem | 1 | ssh/live.ts |
 * | @effect/platform-node/NodeSink | 1 | ssh/process-spawner.ts |
 * | @effect/platform-node/NodeStream | 1 | ssh/process-spawner.ts |
 * | @effect/platform-bun (BunContext, BunRuntime) | 1 | cli/main.ts |
 * | effect/JSONSchema | 1 | cli/core/discovery.ts |
 * | Context.Tag service ids (S4 owns Tag→Service) | 5 | SshTransport, SshTransportConfig, ProcessSpawner, WorkSocket, OperatorSocket |
 *
 * Dual-path guard: each service id appears once; no v1/v2 twin Tags under ownership.
 * Live rewrites: none while effect@3.21 (rewriteLiveImports: false).
 *
 * package.json peers (3.21 line — intentional; no V4 bump in this pack):
 * - effect ^3.21.2
 * - @effect/platform ^0.96
 * - @effect/cli ^0.75
 * - @effect/platform-node ^0.106
 * - @effect/platform-bun ^0.89
 */
export const S7_LIVE_IMPORT_SITES = [
  {
    module: "@effect/cli",
    files: [
      "src/cli/main.ts",
      "src/cli/commands/discovery.ts",
      "src/cli/commands/work.ts",
      "src/cli/commands/content.ts",
      "src/cli/commands/operator.ts",
    ],
    v4: "effect/unstable/cli/* (Args→Argument, Options→Flag)",
  },
  {
    module: "@effect/platform/FileSystem",
    files: ["src/main/vellum/ssh/service.ts"],
    v4: "effect/FileSystem",
  },
  {
    module: "@effect/platform/Command",
    files: [
      "src/main/vellum/ssh/service.ts",
      "src/main/vellum/ssh/program.ts",
      "src/main/vellum/ssh/process-spawner.ts",
    ],
    v4: "effect/unstable/process/ChildProcess",
  },
  {
    module: "@effect/platform-node/NodeFileSystem",
    files: ["src/main/vellum/ssh/live.ts"],
    v4: "stays @effect/platform-node (lockstep V4)",
  },
  {
    module: "@effect/platform-node/NodeSink",
    files: ["src/main/vellum/ssh/process-spawner.ts"],
    v4: "partial → effect/Stdio (see map)",
  },
  {
    module: "@effect/platform-node/NodeStream",
    files: ["src/main/vellum/ssh/process-spawner.ts"],
    v4: "stays platform-node; shape change on pin",
  },
  {
    module: "@effect/platform-bun",
    files: ["src/cli/main.ts"],
    v4: "BunContext → BunServices; BunRuntime keep-alive",
  },
  {
    module: "effect/JSONSchema",
    files: ["src/cli/core/discovery.ts"],
    v4: "effect/JsonSchema",
  },
] as const;

export const S7_REMAINING_CONTEXT_TAGS = [
  { id: "@vellum/SshTransport", file: "src/main/vellum/ssh/service.ts" },
  { id: "@vellum/SshTransportConfig", file: "src/main/vellum/ssh/service.ts" },
  { id: "@vellum/ssh/ProcessSpawner", file: "src/main/vellum/ssh/process-spawner.ts" },
  { id: "@vellum/cli/WorkSocket", file: "src/cli/core/socket.ts" },
  { id: "@vellum/cli/OperatorSocket", file: "src/cli/core/operator-socket.ts" },
] as const;

export const S7_IMPORT_MAP_PREP_META = {
  pack: "S7-platform-imports",
  effectPin: "3.21",
  effectRange: "^3.21.2",
  rewriteLiveImports: false,
  dualImportShims: false,
  remainingContextTagCount: S7_REMAINING_CONTEXT_TAGS.length,
  liveImportSiteGroups: S7_LIVE_IMPORT_SITES.length,
  playgroundRef: "/Users/developer/Playground/effect/migration/v3-to-v4.md",
  endState: "docs/END_STATE-effect-foundation.md §S7",
} as const;
