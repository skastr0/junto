/**
 * Managed-terminal v1 harness templates — data-only spawn specs for the picker.
 *
 * Phase 5 of docs/managed-terminal-plan.md. Templates describe argv/env/injection
 * shapes and honest capability badges. resolve-launch (main) turns a template +
 * picker choices into a TerminalLaunch for LocalSessionHost.
 *
 * Zero writes to user harness configs. No MCP/ACP paths.
 */

import { Schema } from "effect";

// ── Identity ───────────────────────────────────────────────────────────────

/**
 * The four v1 managed-terminal harnesses. OpenClaw is out by construction.
 *
 * Closed literal, and the *only* declaration of the set: a harness id names a
 * template in this file or it does not decode. Every document, IPC input, and
 * seat slot that carries a harness carries this type — there is no second list
 * to drift.
 */
export const HarnessId = Schema.Literal("claude", "codex", "grok", "hermes");
export type HarnessId = typeof HarnessId.Type;

export const HARNESS_IDS: readonly HarnessId[] = HarnessId.literals;

export const isHarnessId = (value: string): value is HarnessId =>
  Schema.is(HarnessId)(value);

// ── Injection ──────────────────────────────────────────────────────────────

/**
 * Tier A — system prompt / rules at spawn (flag).
 * Tier B — first typed message (no system-prompt flag on the harness).
 */
export type InjectionTier = "A" | "B";

export type InjectionSpec = {
  readonly tier: InjectionTier;
  /**
   * Spawn flags that carry the injected doctrine/CLI contract.
   * Empty for tier B (payload is the first typed prompt instead).
   */
  readonly flags: readonly string[];
  readonly description: string;
};

// ── Argv / env specs ───────────────────────────────────────────────────────

/**
 * Declarative spawn shape. resolve-launch maps picker choices onto these slots.
 * Resume re-pass rule: cold-wake paths re-apply model/effort/permission flags
 * (Codex and Hermes resume do not inherit them).
 */
export type ArgvSpec = {
  /** Binary name resolved via PATH (or absolute when the host injects one). */
  readonly binary: string;
  /** Fixed argv prefix after the binary (Hermes: `chat --tui`). */
  readonly prefix: readonly string[];
  /**
   * How the optional initial prompt is attached:
   * - `positional` — last argv token (claude/codex/grok)
   * - `flag-q` — `-q <prompt>` (hermes TUI auto-submit)
   */
  readonly promptMode: "positional" | "flag-q";
  /** Model flag, e.g. `-m` or `--model`. */
  readonly modelFlag?: string;
  /**
   * Effort flag. Codex uses config-key form via `effortConfigKey` instead
   * (`-c model_reasoning_effort="…"`).
   */
  readonly effortFlag?: string;
  /** When set, effort is emitted as `-c <key>="<value>"` (Codex). */
  readonly effortConfigKey?: string;
  /** Permission / approval flag (`--permission-mode`, `-a`, `--yolo`). */
  readonly permissionModeFlag?: string;
  /** Hermes profile: `-p` / `--profile`. */
  readonly profileFlag?: string;
  /** Session pin when supported (`--session-id`). Absent ⇒ capture-only. */
  readonly sessionIdFlag?: string;
  /**
   * Resume shape:
   * - `flag` — `--resume <id>` / `-r <id>` / `-r <id>` after prefix
   * - `subcommand` — `codex resume <id>` (binary args become resume …)
   */
  readonly resumeMode?: "flag" | "subcommand";
  readonly resumeFlag?: string;
  /** Tier-A system prompt flag (`--append-system-prompt`, `--rules`). */
  readonly systemPromptFlag?: string;
  /** Grok agent file flag (`--agent`). */
  readonly agentFlag?: string;
};

/**
 * Env keys that must be stripped from the ambient process env before spawn.
 * Verified traps:
 * - launching from inside a Claude session silently disables the child's
 *   transcript persistence and excludes it from `--resume`;
 * - agent/tooling parents commonly export NO_COLOR for their own logs, which
 *   disables the managed harness TUI even though Vellum provides a truecolor
 *   xterm PTY.
 */
export const SPAWN_ENV_SCRUB: readonly string[] = [
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "NO_COLOR",
] as const;

export type EnvSpec = {
  /** Always scrubbed from the merged spawn env (mandatory on every harness). */
  readonly scrub: readonly string[];
  /**
   * Keys the host may inject (seat/socket/token/PATH). Values are filled at
   * resolve time — never hard-coded secrets here.
   */
  readonly injectKeys: readonly string[];
};

// ── Capability badges (honest UI) ──────────────────────────────────────────

/**
 * Honest per-harness fidelity, sourced from the §9 capability matrix.
 * UI should surface these so weaker fidelity is visible, not papered over.
 */
export type CapabilityBadges = {
  readonly instructionInjection: InjectionTier;
  /** Per-session hooks with zero user-config writes. */
  readonly hooks: boolean;
  readonly effortAtSpawn: boolean;
  /**
   * `pin` = spawn flag; `capture` = read from env/hook/title after start;
   * `unavailable` = no release claim for cold-wake session recovery.
   */
  readonly sessionId: "pin" | "capture" | "unavailable";
  readonly remote: boolean;
  /** Grok swallows the argv prompt unless cwd is a git work tree. */
  readonly requiresGitCwd: boolean;
  /** Ranked state feed for the observer (hooks → OSC → grid). */
  readonly stateFeed: string;
  /** Primary attention source for the node chrome. */
  readonly attentionSource: string;
  /** Short chips for the node / picker row. */
  readonly labels: readonly string[];
};

// ── Template ───────────────────────────────────────────────────────────────

export type ManagedTerminalTemplate = {
  readonly harness: HarnessId;
  readonly displayName: string;
  readonly argvSpec: ArgvSpec;
  readonly envSpec: EnvSpec;
  readonly injectionSpec: InjectionSpec;
  readonly capabilityBadges: CapabilityBadges;
  /**
   * Effort values the picker may offer. Empty = omit effort in v1
   * (Hermes: typed `/reasoning` only, or omitted).
   */
  readonly efforts: readonly string[];
  /** Default permission/approval mode when the picker does not choose. */
  readonly defaultPermissionMode?: string;
  /** Probed binary version era (re-smoke on harness updates). */
  readonly probedVersion?: string;
};

const SHARED_ENV_SPEC: EnvSpec = {
  scrub: SPAWN_ENV_SCRUB,
  // Seat/socket/token reach agent shell subprocesses on all four (verified).
  // PATH inject so `dist/vellum` resolves for `vellum onboard`.
  injectKeys: [
    "PATH",
    "VELLUM_SOCKET",
    "VELLUM_TOKEN",
    "VELLUM_SEAT",
    "VELLUM_NODE_REF",
  ],
};

// ── Four v1 templates ──────────────────────────────────────────────────────

export const CLAUDE_TEMPLATE: ManagedTerminalTemplate = {
  harness: "claude",
  displayName: "Claude Code",
  probedVersion: "2.1.220",
  argvSpec: {
    binary: "claude",
    prefix: [],
    promptMode: "positional",
    modelFlag: "--model",
    effortFlag: "--effort",
    permissionModeFlag: "--permission-mode",
    sessionIdFlag: "--session-id",
    resumeMode: "flag",
    resumeFlag: "--resume",
    systemPromptFlag: "--append-system-prompt",
  },
  envSpec: SHARED_ENV_SPEC,
  injectionSpec: {
    tier: "A",
    flags: ["--append-system-prompt"],
    description: "System prompt appended at spawn via --append-system-prompt",
  },
  capabilityBadges: {
    instructionInjection: "A",
    hooks: false,
    effortAtSpawn: true,
    sessionId: "pin",
    remote: false,
    requiresGitCwd: false,
    stateFeed: "OSC → grid",
    attentionSource: "grid (OSC cannot distinguish permission prompt)",
    labels: ["injection A", "OSC + grid", "effort", "session pin"],
  },
  // Six levels verified; ultracode accepted at spawn despite incomplete CLI help.
  efforts: ["low", "medium", "high", "xhigh", "max", "ultracode"],
  defaultPermissionMode: "default",
};

export const CODEX_TEMPLATE: ManagedTerminalTemplate = {
  harness: "codex",
  displayName: "Codex",
  probedVersion: "0.145.0",
  argvSpec: {
    binary: "codex",
    prefix: [],
    promptMode: "positional",
    modelFlag: "-m",
    // Effort is a config key, not a long flag: -c model_reasoning_effort="low"
    effortConfigKey: "model_reasoning_effort",
    permissionModeFlag: "-a",
    resumeMode: "subcommand",
    // No session pin; capture via SessionStart / CODEX_THREAD_ID / notify.
  },
  envSpec: SHARED_ENV_SPEC,
  injectionSpec: {
    tier: "B",
    flags: [],
    description:
      "No system-prompt flag — doctrine delivered as the first typed message",
  },
  capabilityBadges: {
    instructionInjection: "B",
    // Hooks dropped: trust modal; --dangerously-bypass-hook-trust banned.
    hooks: false,
    effortAtSpawn: true,
    sessionId: "unavailable",
    remote: false,
    requiresGitCwd: false,
    stateFeed: "OSC → grid (+ notify turn-complete)",
    attentionSource: "OSC title Action Required + grid for startup modals",
    labels: ["injection B", "no hooks", "effort", "no cold resume"],
  },
  // Per-model lists come from `codex debug models`; these are common floors.
  efforts: ["low", "medium", "high", "xhigh", "ultra"],
  defaultPermissionMode: "on-request",
};

export const GROK_TEMPLATE: ManagedTerminalTemplate = {
  harness: "grok",
  displayName: "Grok",
  probedVersion: "0.2.x",
  argvSpec: {
    binary: "grok",
    prefix: [],
    promptMode: "positional",
    modelFlag: "-m",
    effortFlag: "--reasoning-effort",
    permissionModeFlag: "--permission-mode",
    sessionIdFlag: "--session-id",
    resumeMode: "flag",
    resumeFlag: "-r",
    systemPromptFlag: "--rules",
    agentFlag: "--agent",
  },
  envSpec: SHARED_ENV_SPEC,
  injectionSpec: {
    tier: "A",
    flags: ["--rules", "--agent"],
    description:
      "--rules appends; --agent <file> appends frontmatter body (+ tools gating)",
  },
  capabilityBadges: {
    instructionInjection: "A",
    hooks: false,
    effortAtSpawn: true,
    sessionId: "pin",
    remote: false,
    requiresGitCwd: true,
    stateFeed: "OSC → grid",
    attentionSource: "OSC title Action Required + footer/grid",
    labels: ["injection A", "OSC + grid", "effort", "session pin", "git cwd"],
  },
  efforts: ["high", "medium", "low"],
  defaultPermissionMode: "default",
};

export const HERMES_TEMPLATE: ManagedTerminalTemplate = {
  harness: "hermes",
  displayName: "Hermes",
  probedVersion: "2026-07",
  argvSpec: {
    binary: "hermes",
    // -z / chat -q without --tui are headless. Interactive auto-submit needs --tui.
    prefix: ["chat", "--tui"],
    promptMode: "flag-q",
    modelFlag: "-m",
    // No effort flag — omit in v1 (typed /reasoning is session-scoped only).
    permissionModeFlag: "--yolo",
    profileFlag: "--profile",
    resumeMode: "flag",
    resumeFlag: "-r",
  },
  envSpec: SHARED_ENV_SPEC,
  injectionSpec: {
    tier: "B",
    flags: [],
    description:
      "No system-prompt flag — doctrine delivered as the first typed message",
  },
  capabilityBadges: {
    instructionInjection: "B",
    hooks: false,
    effortAtSpawn: false,
    sessionId: "unavailable",
    remote: true,
    requiresGitCwd: false,
    stateFeed: "OSC (--tui only) → grid",
    attentionSource: "OSC title ⚠",
    labels: ["injection B", "OSC + grid", "no effort flag", "no cold resume", "remote"],
  },
  efforts: [],
};

export const MANAGED_TERMINAL_TEMPLATES: Readonly<
  Record<HarnessId, ManagedTerminalTemplate>
> = {
  claude: CLAUDE_TEMPLATE,
  codex: CODEX_TEMPLATE,
  grok: GROK_TEMPLATE,
  hermes: HERMES_TEMPLATE,
};

export const templateFor = (harness: HarnessId): ManagedTerminalTemplate =>
  MANAGED_TERMINAL_TEMPLATES[harness];

export const allTemplates = (): readonly ManagedTerminalTemplate[] =>
  HARNESS_IDS.map((id) => MANAGED_TERMINAL_TEMPLATES[id]);

/** Claude `--model` aliases (not from the cache; always offered as shortcuts). */
export const CLAUDE_MODEL_ALIASES: readonly string[] = [
  "default",
  "opus",
  "sonnet",
  "haiku",
  "fable",
  "opusplan",
  "opus[1m]",
  "sonnet[1m]",
  "fable[1m]",
] as const;
