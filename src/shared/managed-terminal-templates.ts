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
import { managedHarnessEnabled } from "./features";

// ── Identity ───────────────────────────────────────────────────────────────

/**
 * The managed-terminal harnesses. OpenClaw is out by construction.
 *
 * v1 (2026-07): claude, codex, grok, hermes. Extended 2026-08: pi,
 * prime-agent, kimi, muse, devin, cursor (agent-CLI sweep — docs/research/agent-cli-sweep/).
 *
 * Closed literal, and the *only* declaration of the set: a harness id names a
 * template in this file or it does not decode. Every document, IPC input, and
 * seat slot that carries a harness carries this type — there is no second list
 * to drift.
 */
export const HarnessId = Schema.Literals([
  "claude",
  "codex",
  "grok",
  "hermes",
  "pi",
  "prime-agent",
  "kimi",
  "muse",
  "devin",
  "cursor",
  "agy",
]);
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
   * - `positional` — last argv token (claude/codex/grok/pi/prime-agent/muse/devin)
   * - `flag-q` — `-q <prompt>` (hermes TUI auto-submit)
   * - `flag-i` — `-i <prompt>` (agy auto-submit)
   * - `none` — no argv prompt slot (kimi TUI waits for typed input; the drive
   *   delivers Tier-B first-typed messages instead)
   */
  readonly promptMode: "positional" | "flag-q" | "flag-i" | "none";
  /**
   * Separator pushed immediately before the positional prompt. Devin requires
   * `--` (`devin -- <prompt>`); everything else needs none.
   */
  readonly promptSeparator?: string;
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
   * Resume shape — always with an explicit session id. Never `--continue` / `-c`
   * (id-less "latest session" is not a Vellum Command feature).
   * - `flag` — `--resume <id>` / `-r <id>` / `-S <id>` / `--session <id>`
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
 * Exact env keys that must be stripped from the ambient process env before
 * every managed spawn. Verified traps:
 * - launching from inside a Claude session silently disables the child's
 *   transcript persistence and excludes it from `--resume`;
 * - launching Vellum Command from inside a Prime Agent worker exports
 *   PI_CODING_AGENT, which must not classify a new harness process as nested;
 * - agent/tooling parents commonly export NO_COLOR for their own logs, which
 *   disables the managed harness TUI even though Vellum Command provides a
 *   truecolor xterm PTY.
 */
export const SPAWN_ENV_SCRUB: readonly string[] = [
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "PI_CODING_AGENT",
  "NO_COLOR",
  // Ambient FORCE_COLOR defeats the NO_COLOR scrub on chalk-based TUIs
  // (Pi, Prime Agent, Cursor, Amp) — it must go with it.
  "FORCE_COLOR",
  // Nested Cursor seats inherit conversation/store traps from a parent agent.
  "CURSOR_CONVERSATION_ID",
  "CURSOR_AGENT_STORE_FILES_DIR",
  "CURSOR_AGENT_STORE_SHARED_PATHS",
] as const;

/**
 * Prefixes reserved for harness-internal process roles. Scrub the namespace,
 * rather than today's known keys, so a future Prime Agent worker marker cannot
 * make Vellum Command's app-owned foreground daemon masquerade as a worker.
 */
export const SPAWN_ENV_SCRUB_PREFIXES: readonly string[] = [
  "PRIME_AGENT_INTERNAL_",
] as const;

export type EnvSpec = {
  /** Exact keys scrubbed on every harness; global prefix rules apply too. */
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
  // Seat/socket/token reach direct harness subprocesses; the Prime Agent
  // runtime starts its isolated daemon from this resolved environment.
  // PATH inject so `dist/vellum-command` resolves for `vellum-command onboard`.
  injectKeys: [
    "PATH",
    "VELLUM_COMMAND_SOCKET",
    "VELLUM_COMMAND_TOKEN",
    "VELLUM_COMMAND_SEAT",
    "VELLUM_COMMAND_NODE_REF",
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
    // `--minimal` = palette-native / scrollback-native integration with the
    // host xterm theme. Not the same as `--no-alt-screen` (inline vs alt
    // buffer). Vellum Command's recommended appearance policy is follow.
    prefix: ["--minimal"],
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
    labels: [
      "injection A",
      "OSC + grid",
      "effort",
      "session pin",
      "git cwd",
      "minimal palette",
    ],
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

// ── Five 2026-08 harnesses (agent-CLI sweep: docs/research/agent-cli-sweep/) ─────

/**
 * Pi (earendil-works pi-coding-agent) — Tier A, session pin, RPC/JSON embed.
 * Verified 0.83.0: positional prompt; --thinking effort (7 levels);
 * --session-id pin (create-if-missing, uuidv7); non-interactive resume is
 * `--session <path|partial-id>` (NOT -r, which opens a picker);
 * --append-system-prompt repeatable; --tools/--exclude-tools allowlists;
 * no per-command permission mode (--approve gates project-local trust only).
 */
export const PI_TEMPLATE: ManagedTerminalTemplate = {
  harness: "pi",
  displayName: "Pi",
  probedVersion: "0.83.0",
  argvSpec: {
    binary: "pi",
    prefix: [],
    promptMode: "positional",
    modelFlag: "--model",
    effortFlag: "--thinking",
    sessionIdFlag: "--session-id",
    resumeMode: "flag",
    resumeFlag: "--session",
    systemPromptFlag: "--append-system-prompt",
  },
  envSpec: SHARED_ENV_SPEC,
  injectionSpec: {
    tier: "A",
    flags: ["--append-system-prompt"],
    description: "System prompt appended at spawn via --append-system-prompt (repeatable)",
  },
  capabilityBadges: {
    instructionInjection: "A",
    hooks: false,
    effortAtSpawn: true,
    sessionId: "pin",
    remote: false,
    requiresGitCwd: false,
    stateFeed: "grid → OSC133 (extension/RPC optional)",
    attentionSource: "grid (trust/confirm dialogs)",
    labels: ["injection A", "grid + OSC133", "effort", "session pin"],
  },
  efforts: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
};

/**
 * Prime Agent (stock separately installed `prime-agent` CLI) — shipped Tier A,
 * capture session, with a built-in reporter (idle/working/blocked + session id).
 * Verified 0.7.1: positional prompt; --thinking effort (7 levels); resume
 * `-r <path|id>` / `-c` (no pin flag — capture from reporter / list --json);
 * --append-system-prompt repeatable; no permission-mode flag (--autonomous is
 * unattended mode, not an approval enum). Vellum Command owns one isolated
 * foreground daemon per live binding. Its unique --daemon-socket is runtime
 * launch state and must never enter this authorial argv template.
 */
export const PRIME_AGENT_TEMPLATE: ManagedTerminalTemplate = {
  harness: "prime-agent",
  displayName: "Prime Agent",
  probedVersion: "0.7.1",
  argvSpec: {
    binary: "prime-agent",
    prefix: [],
    promptMode: "positional",
    modelFlag: "--model",
    effortFlag: "--thinking",
    resumeMode: "flag",
    resumeFlag: "-r",
    systemPromptFlag: "--append-system-prompt",
  },
  envSpec: SHARED_ENV_SPEC,
  injectionSpec: {
    tier: "A",
    flags: ["--append-system-prompt"],
    description: "System prompt appended at spawn via --append-system-prompt (repeatable)",
  },
  capabilityBadges: {
    instructionInjection: "A",
    // Stock built-in lifecycle hooks report per session with zero config writes.
    hooks: true,
    effortAtSpawn: true,
    sessionId: "capture",
    // A Remote runs the same plane: daemon plane, reporter, and daemon
    // all live on the target host, so the seat is host-local there too.
    remote: true,
    requiresGitCwd: false,
    stateFeed: "built-in reporter → OSC9/133 + grid",
    attentionSource: "built-in blocked events → grid overlays",
    labels: [
      "injection A",
      "built-in reporter",
      "zero-write hooks",
      "effort",
      "capture session",
      "no permission enum",
      "remote",
    ],
  },
  efforts: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
};

/**
 * Kimi Code (Moonshot) — Tier B, capture session, native hook feed.
 * Verified 0.29.0: NO argv prompt slot in the TUI (promptMode "none" — the
 * drive delivers the first typed message); -m model; --yolo/--auto approval
 * (no enum); resume `-S <id>` / `-c`; no pin (capture via SessionStart hook
 * stdin or the welcome-card "Session: <uuid>" line); 20-event JSON-stdin
 * hooks (PermissionRequest→blocked) — but hooks live in the user's config,
 * so Vellum Command never installs them (badge hooks: false).
 */
export const KIMI_TEMPLATE: ManagedTerminalTemplate = {
  harness: "kimi",
  displayName: "Kimi Code",
  probedVersion: "0.29.0",
  argvSpec: {
    binary: "kimi",
    prefix: [],
    promptMode: "none",
    modelFlag: "-m",
    permissionModeFlag: "--yolo",
    resumeMode: "flag",
    resumeFlag: "-S",
  },
  envSpec: SHARED_ENV_SPEC,
  injectionSpec: {
    tier: "B",
    flags: [],
    description: "No system-prompt flag — doctrine delivered as the first typed message",
  },
  capabilityBadges: {
    instructionInjection: "B",
    hooks: false,
    effortAtSpawn: false,
    sessionId: "capture",
    remote: false,
    requiresGitCwd: false,
    stateFeed: "hook feed → grid",
    attentionSource: "PermissionRequest hook → grid approval panel",
    labels: ["injection B", "hook feed", "capture session"],
  },
  efforts: [],
};

/**
 * Muse Code (Meta; codex-fork family) — Tier B, capture session, grid feed.
 * Verified 0.1.0-R708.1: positional prompt; --model; --reasoning-effort
 * (none..ultra); --yolo/--approval-mode safety stack; resume is a
 * SUBCOMMAND (`muse resume <uuid>` — root options allowed on either side);
 * no pin (capture via `exec --json` first line / session dirs); TUI needs a
 * responsive host (bracketed paste + OSC palette + DSR cursor-position).
 */
export const MUSE_TEMPLATE: ManagedTerminalTemplate = {
  harness: "muse",
  displayName: "Muse",
  probedVersion: "0.1.0-R708.1",
  argvSpec: {
    binary: "muse",
    prefix: [],
    promptMode: "positional",
    modelFlag: "--model",
    effortFlag: "--reasoning-effort",
    permissionModeFlag: "--yolo",
    resumeMode: "subcommand",
  },
  envSpec: SHARED_ENV_SPEC,
  injectionSpec: {
    tier: "B",
    flags: [],
    description: "No system-prompt flag — doctrine delivered as the first typed message",
  },
  capabilityBadges: {
    instructionInjection: "B",
    hooks: false,
    effortAtSpawn: true,
    sessionId: "capture",
    remote: false,
    requiresGitCwd: false,
    stateFeed: "grid (positive-signal readiness)",
    attentionSource: "grid (approval/trust dialogs)",
    labels: ["injection B", "grid", "effort", "capture session"],
  },
  efforts: ["none", "minimal", "low", "medium", "high", "xhigh", "ultra"],
};

/**
 * Devin CLI (Cognition) — Tier B v1, capture session, grid feed.
 * Verified 3000.3.27: positional prompt REQUIRES `--` separator; --model;
 * --permission-mode enum (normal|accept-edits|smart|dangerous|autonomous);
 * resume `-r <id>` exact / `-c`; no pin (capture via hook payload session_id,
 * `devin list --format json`, sessions.db, session_locks); --agent-config
 * (system instructions + tool visibility + permissions, strict parse) is the
 * Tier-A upgrade path — deferred until a per-harness config builder exists.
 */
export const DEVIN_TEMPLATE: ManagedTerminalTemplate = {
  harness: "devin",
  displayName: "Devin",
  probedVersion: "3000.3.27",
  argvSpec: {
    binary: "devin",
    prefix: [],
    promptMode: "positional",
    promptSeparator: "--",
    modelFlag: "--model",
    permissionModeFlag: "--permission-mode",
    resumeMode: "flag",
    resumeFlag: "-r",
  },
  envSpec: SHARED_ENV_SPEC,
  injectionSpec: {
    tier: "B",
    flags: [],
    description:
      "No system-prompt flag in v1 — doctrine delivered as the first typed message (--agent-config upgrade path documented)",
  },
  capabilityBadges: {
    instructionInjection: "B",
    hooks: false,
    effortAtSpawn: false,
    sessionId: "capture",
    remote: false,
    requiresGitCwd: false,
    stateFeed: "grid (❭ prompt + footers)",
    attentionSource: "grid (permission/trust footers)",
    labels: ["injection B", "grid", "permission enum", "capture session"],
  },
  efforts: [],
  defaultPermissionMode: "normal",
};

/**
 * Cursor Agent CLI (binary: `agent`) — Tier B, capture session, grid feed.
 * Verified 2026.08.11: positional prompt; --model (effort is a model-id
 * suffix, not a flag); --yolo/--force allow-all; --resume <id> named only;
 * --trust skips the workspace-trust modal. No public system-prompt flag.
 */
export const CURSOR_TEMPLATE: ManagedTerminalTemplate = {
  harness: "cursor",
  displayName: "Cursor Agent",
  probedVersion: "2026.08.11-e8db854",
  argvSpec: {
    binary: "agent",
    prefix: ["--trust"],
    promptMode: "positional",
    modelFlag: "--model",
    permissionModeFlag: "--yolo",
    resumeMode: "flag",
    resumeFlag: "--resume",
  },
  envSpec: SHARED_ENV_SPEC,
  injectionSpec: {
    tier: "B",
    flags: [],
    description:
      "No public system-prompt flag — doctrine delivered as the first typed message",
  },
  capabilityBadges: {
    instructionInjection: "B",
    hooks: false,
    effortAtSpawn: false,
    sessionId: "capture",
    remote: false,
    requiresGitCwd: false,
    stateFeed: "grid (alt buffer)",
    attentionSource: "grid (approval forms)",
    labels: ["injection B", "grid", "capture session"],
  },
  efforts: [],
};

/**
 * Antigravity CLI (Google Antigravity; binary: `agy`) — Tier B, capture session, grid feed.
 * Verified 1.1.13: `-i <prompt>` auto-submit; `--model`; `--effort` (low|medium|high);
 * `--dangerously-skip-permissions`; `--agent`; `--conversation <id>` resume.
 */
export const AGY_TEMPLATE: ManagedTerminalTemplate = {
  harness: "agy",
  displayName: "Antigravity",
  probedVersion: "1.1.13",
  argvSpec: {
    binary: "agy",
    prefix: [],
    promptMode: "flag-i",
    modelFlag: "--model",
    effortFlag: "--effort",
    permissionModeFlag: "--dangerously-skip-permissions",
    agentFlag: "--agent",
    resumeMode: "flag",
    resumeFlag: "--conversation",
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
    effortAtSpawn: true,
    sessionId: "capture",
    remote: false,
    requiresGitCwd: false,
    stateFeed: "grid (screen rules)",
    attentionSource: "permission prompt ([y/n], do you want to proceed?)",
    labels: [
      "injection B",
      "grid",
      "effort",
      "capture session",
      "agents",
    ],
  },
  efforts: ["low", "medium", "high"],
  defaultPermissionMode: undefined,
};

export const MANAGED_TERMINAL_TEMPLATES: Readonly<
  Record<HarnessId, ManagedTerminalTemplate>
> = {
  claude: CLAUDE_TEMPLATE,
  codex: CODEX_TEMPLATE,
  grok: GROK_TEMPLATE,
  hermes: HERMES_TEMPLATE,
  pi: PI_TEMPLATE,
  "prime-agent": PRIME_AGENT_TEMPLATE,
  kimi: KIMI_TEMPLATE,
  muse: MUSE_TEMPLATE,
  devin: DEVIN_TEMPLATE,
  cursor: CURSOR_TEMPLATE,
  agy: AGY_TEMPLATE,
};

export const templateFor = (harness: HarnessId): ManagedTerminalTemplate =>
  MANAGED_TERMINAL_TEMPLATES[harness];

export const allTemplates = (): readonly ManagedTerminalTemplate[] =>
  HARNESS_IDS
    .filter(managedHarnessEnabled)
    .map((id) => MANAGED_TERMINAL_TEMPLATES[id]);

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
