/**
 * S7-platform-imports — Effect V4 import map (rewrites applied).
 *
 * Product is on effect@4 + matching platform-* packages.
 * Live imports under ssh/** and cli/** use the V4 destinations below.
 *
 * Source of truth: Playground/effect migration v3-to-v4 notes.
 * Contract: docs/END_STATE-effect-foundation.md §S7 / R7-platform
 *
 * Path ownership: src/main/vellum/ssh/**, src/cli/**.
 * Consolidation: one map, zero dual v1/v2 import shims, zero live dual paths.
 */

/**
 * v3 module id → V4 destination (direct module; barrel note in comment).
 * Keys are short v3 labels (not import paths) so live-import rg stays clean.
 */
export const S7_EFFECT_V4_IMPORT_MAP = {
  // --- platform → core effect or effect/unstable ---
  "v3:platform-FileSystem": "effect/FileSystem",
  // platform Command is process spawn, not CLI Command
  "v3:platform-Command": "effect/unstable/process/ChildProcess",
  "v3:platform-CommandExecutor":
    "effect/unstable/process/ChildProcessSpawner",

  // --- cli → effect/unstable/cli ---
  "v3:cli-barrel": "effect/unstable/cli (barrel)",
  "v3:cli-Args": "effect/unstable/cli/Argument",
  "v3:cli-Command": "effect/unstable/cli/Command",
  "v3:cli-Options": "effect/unstable/cli/Flag",
  "v3:cli-HelpDoc": "effect/unstable/cli/HelpDoc",
  "v3:cli-Prompt": "effect/unstable/cli/Prompt",
  "v3:cli-ValidationError": "effect/unstable/cli/CliError",
  "v3:cli-BuiltInOptions": "effect/unstable/cli/GlobalFlag",
  "v3:cli-CliApp": "effect/unstable/cli/Command (CliApp folded into Command)",

  // --- effect core renames used under cli/** ---
  "effect/JsonSchema": "effect/JsonSchema",

  // --- platform-* remain separate packages (lockstep with effect@4) ---
  "v3:platform-node": "@effect/platform-node (stays; version lockstep V4)",
  "v3:NodeFileSystem":
    "@effect/platform-node/NodeFileSystem (stays; ParcelWatcher removed in V4)",
  "v3:NodeSink":
    "partial: stdout/stderr → effect/Stdio; stdin manual (see v3-to-v4 curated notes)",
  "v3:NodeStream":
    "@effect/platform-node (API shape change; see v3-to-v4 curated notes)",
  "v3:NodeCommandExecutor":
    "@effect/platform-node/NodeChildProcessSpawner",
  "v3:NodeContext":
    "@effect/platform-node NodeServices (ChildProcessSpawner + Crypto + Stdio; no WorkerManager)",
  "v3:platform-bun": "@effect/platform-bun (stays; version lockstep V4)",
  "v3:BunContext":
    "@effect/platform-bun BunServices (ChildProcessSpawner, Crypto, FileSystem, Path, Stdio, Terminal; add BunWorker separately)",
  "v3:BunRuntime":
    "@effect/platform-bun (runtime keep-alive; see fiber-keep-alive.md)",
  "v3:BunCommandExecutor":
    "@effect/platform-bun BunChildProcessSpawner.layer",
} as const;

export type S7EffectV4ImportMapKey = keyof typeof S7_EFFECT_V4_IMPORT_MAP;

/**
 * High-value API renames for symbols used under owned paths.
 * Source: Playground/effect migration notes §platform Command
 */
export const S7_PLATFORM_COMMAND_API_RENAMES = {
  "Command.Command": "ChildProcess.Command",
  "Command.StandardCommand": "ChildProcess.StandardCommand",
  "Command.PipedCommand": "ChildProcess.PipedCommand",
  "Command.make": "ChildProcess.make (array form: make(cmd, args, opts?))",
  "Command.env / command.env HashMap": "ChildProcess.setEnv / command.options.env Record",
  "Command.workingDirectory / command.cwd Option":
    "ChildProcess.setCwd / command.options.cwd string|undefined",
  "command.shell / uid / gid":
    "command.options.shell (uid/gid not on V4 CommandOptions)",
  "Command.stdin / stdout / stderr / feed / runInShell":
    "ChildProcess.CommandOptions fields at make-time (combinators removed)",
  "Command.start / string / lines / stream / streamLines / exitCode":
    "ChildProcessSpawner.* (or yield Effectable ChildProcess.Command)",
  "CommandExecutor.CommandExecutor": "ChildProcessSpawner.ChildProcessSpawner",
  "Command.flatten": "ChildProcess.isStandardCommand (no flatten; Standard|Piped only)",
} as const;

/**
 * Live inventory under ssh/** + cli/** after V4 rewrite.
 *
 * | module | sites | files |
 * |---|---|---|
 * | effect/unstable/cli | 5 | cli/main.ts, cli/commands/{discovery,work,content,operator}.ts |
 * | effect/FileSystem | 1 | ssh/service.ts |
 * | effect/unstable/process/ChildProcess | 3 | ssh/service.ts (type), program.ts, process-spawner.ts |
 * | platform-node/NodeFileSystem | 1 | ssh/live.ts |
 * | platform-node/NodeSink | 1 | ssh/process-spawner.ts |
 * | platform-node/NodeStream | 1 | ssh/process-spawner.ts |
 * | platform-bun (BunServices, BunRuntime) | 1 | cli/main.ts |
 * | effect/JsonSchema | 1 | cli/core/discovery.ts |
 *
 * Dual-path guard: each service id appears once; no v1/v2 twin service ids.
 * rewriteLiveImports: true (applied).
 */
export const S7_LIVE_IMPORT_SITES = [
  {
    module: "effect/unstable/cli",
    files: [
      "src/cli/main.ts",
      "src/cli/commands/discovery.ts",
      "src/cli/commands/work.ts",
      "src/cli/commands/content.ts",
      "src/cli/commands/operator.ts",
    ],
    v4: "Argument / Flag / Command (Args→Argument, Options→Flag)",
  },
  {
    module: "effect/FileSystem",
    files: ["src/main/vellum/ssh/service.ts"],
    v4: "effect/FileSystem",
  },
  {
    module: "effect/unstable/process/ChildProcess",
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
    v4: "BunServices + BunRuntime",
  },
  {
    module: "effect/JsonSchema",
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
  effectPin: "4.0.0-beta.102",
  effectRange: "4.0.0-beta.102",
  rewriteLiveImports: true,
  dualImportShims: false,
  remainingContextTagCount: S7_REMAINING_CONTEXT_TAGS.length,
  liveImportSiteGroups: S7_LIVE_IMPORT_SITES.length,
  playgroundRef: "Playground/effect/migration/v3-to-v4.md",
  endState: "docs/END_STATE-effect-foundation.md §S7",
} as const;
