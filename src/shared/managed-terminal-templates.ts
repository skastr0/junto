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
  "amp",
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
  /**
   * Fixed argv prefix after the binary — STRUCTURAL ONLY (Hermes: `chat --tui`
   * selects the interactive TUI; without it the binary is headless).
   *
   * A seat Vellum Command starts must present the same experience as the operator
   * running the harness by hand, so this slot may never carry an appearance or
   * preference flag. Those live in the harness's own config (Grok reads
   * `~/.grok/config.toml`), and a flag here silently overrides the operator's
   * file for factory seats only. `APPEARANCE_PREFERENCE_FLAGS` below names the
   * ones already found doing that; the template contract test enforces it.
   */
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
  /**
   * Agent-mode flag for harnesses whose one dial is a named mode rather than a
   * model or an effort (Amp `-m low|medium|high|ultra`, which selects model,
   * system prompt, and tool set together). Kept distinct from `modelFlag` and
   * `effortFlag`: presenting a mode as either would misreport what the harness
   * offers.
   */
  readonly modeFlag?: string;
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
  /**
   * Tokens that carry a named resume when `resumeMode` is "subcommand".
   * Codex resumes as `codex resume <id>`; Amp as `amp threads continue <id>`.
   * Declared per template so a resume shape is data, never a harness branch.
   */
  readonly resumeSubcommand?: readonly string[];
  readonly resumeFlag?: string;
  /** Tier-A system prompt flag (`--append-system-prompt`, `--rules`). */
  readonly systemPromptFlag?: string;
  /** Grok agent file flag (`--agent`). */
  readonly agentFlag?: string;
  /**
   * Tier-A rules-DIRECTORY flag (Antigravity `--add-dir`, repeatable). The
   * harness exposes no system-prompt flag, but it loads `AGENTS.md` from every
   * directory added to the workspace — so doctrine ships as an app-owned
   * ephemeral directory instead of an argv string.
   *
   * Vellum Command mounts ONLY its own directory
   * (`<VELLUM_COMMAND_HOME>/.vellum-command/content/agent-rules/<seat>/`): the
   * operator's workspace is never written to, and the loaded context cites the
   * app-owned path as its origin. Probed on agy 1.1.20 — an `AGENTS.md` in an
   * added dir is obeyed, while a cwd `AGENTS.md` alone is not read at all.
   */
  readonly rulesDirFlag?: string;
  /**
   * Whether re-passing the injection carriers (`systemPromptFlag` / `agentFlag`)
   * on a RESUME launch actually reaches the harness. This is a probe receipt,
   * not a preference — a harness that freezes its instructions at thread
   * creation accepts the flag on the command line and silently ignores it, so
   * without this fact the argv would look correct and the seat would run
   * un-briefed.
   *
   * - `re-pass`   — resume argv carrying the injection spec is honored.
   *   Probed 2026-08: claude, grok, pi, cursor, agy, muse, hermes. (Hermes also
   *   needs `-m` re-passed on every resume or the model silently reverts;
   *   `buildArgv` already re-passes every template-owned flag on resume.)
   * - `frozen`    — instructions are fixed at session creation and cannot be
   *   re-passed. Probed 2026-08: codex (re-passed developer instructions do not
   *   apply to an existing thread) and kimi (`--agent-file` cannot combine with
   *   `--session` / `--continue` at all). Doctrine for these harnesses is
   *   delivered-at-creation; later generations are re-oriented by the injection
   *   supervisor's notices instead.
   * - `unprobed`  — no receipt yet. Treated exactly like `frozen` at the argv
   *   boundary, so an unverified harness never gets a claim it has not earned.
   */
  readonly resumeReinjection: "re-pass" | "frozen" | "unprobed";
};

/** Injection carriers may ride a resume launch only for this class. */
export const reinjectableOnResume = (
  template: ManagedTerminalTemplate,
): boolean => template.argvSpec.resumeReinjection === "re-pass";

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

/**
 * Argv flags that select how a harness LOOKS or how it decides, rather than
 * what it is. Each one has a home in the harness's own config file, so putting
 * one in a template prefix would give a factory-started seat a different
 * experience from the same harness started by hand — the exact split this list
 * exists to prevent. Enforced over every template by the contract test.
 */
export const APPEARANCE_PREFERENCE_FLAGS: readonly string[] = [
  "--minimal",
  "--no-alt-screen",
  "--fullscreen",
  "--theme",
  "--light",
  "--dark",
  "--color",
  "--no-color",
  "--compact",
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
   * `provision` = minted by a public CLI call before the PTY starts and stored
   * as the seat's session id (Amp `threads new`); `unavailable` = no release
   * claim for cold-wake session recovery.
   */
  readonly sessionId: "pin" | "capture" | "provision" | "unavailable";
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
  /**
   * Named agent modes for `argvSpec.modeFlag`. Empty/absent for every harness
   * whose dial is a model or an effort.
   */
  readonly modes?: readonly string[];
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
    resumeReinjection: "re-pass",
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
    // No session pin; the thread id is CAPTURED (SessionStart /
    // CODEX_THREAD_ID / notify) and proven against ~/.codex/sessions before
    // it is ever used to resume.
    resumeReinjection: "frozen",
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
    // Capture, not unavailable: `codexSessionExists` proves a thread id against
    // ~/.codex/sessions and `codex resume <id>` was verified live, so the badge
    // that used to read "unavailable" contradicted shipped behavior.
    sessionId: "capture",
    remote: false,
    requiresGitCwd: false,
    stateFeed: "OSC → grid (+ notify turn-complete)",
    attentionSource: "OSC title Action Required + grid for startup modals",
    labels: [
      "injection B",
      "no hooks",
      "effort",
      "capture session",
      // Doctrine is frozen at thread creation: a resume cannot carry it again.
      "doctrine at creation",
    ],
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
    // No appearance prefix. `--minimal` used to live here and overrode the
    // operator's own `[ui] screen_mode` for app-started seats only, so a
    // factory seat rendered scrollback-native while `grok` by hand rendered
    // the full TUI with their configured theme.
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
    resumeReinjection: "re-pass",
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
    resumeReinjection: "re-pass",
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
    resumeReinjection: "re-pass",
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
    resumeReinjection: "unprobed",
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
 * Kimi Code (Moonshot) — Tier A by agent file, capture session, native hook feed.
 * Verified 0.29.0: NO argv prompt slot in the TUI (promptMode "none"); -m model;
 * --yolo/--auto approval (no enum); resume `-S <id>` / `-c`; no pin (capture via
 * SessionStart hook stdin or the welcome-card "Session: <uuid>" line); 20-event
 * JSON-stdin hooks (PermissionRequest→blocked) — but hooks live in the user's
 * config, so Vellum Command never installs them (badge hooks: false).
 *
 * Re-probed 0.34.0 (2026-08-25): `--agent-file <path>` loads a Markdown agent
 * definition and its body IS the system prompt (canary honored in a live
 * session), so the seat is briefed before turn 1 with no PTY paste. Frontmatter
 * validation is strict and pre-flight — a bad key exits 1 before any model call
 * — and `allowed-tools` is a Claude-side key Kimi warns it may misread, so
 * `agent-file-spec` emits only name/description/tools. The flag cannot combine
 * with `--session`/`--continue`, which is why `resumeReinjection` is frozen: a
 * resumed seat keeps its original briefing and degrades to typed delivery.
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
    // The Tier-A carrier is a FILE, not a prompt string: `--agent-file <path>`
    // loads a Markdown agent definition whose body becomes the system prompt.
    // `agent-file-spec` (main) writes that file; the resolver only mounts it.
    agentFlag: "--agent-file",
    resumeReinjection: "frozen",
  },
  envSpec: SHARED_ENV_SPEC,
  injectionSpec: {
    tier: "A",
    flags: ["--agent-file"],
    description:
      "Agent definition at spawn via --agent-file; the file body is the system prompt",
  },
  capabilityBadges: {
    instructionInjection: "A",
    hooks: false,
    effortAtSpawn: false,
    sessionId: "capture",
    remote: false,
    requiresGitCwd: false,
    stateFeed: "hook feed → grid",
    attentionSource: "PermissionRequest hook → grid approval panel",
    // `--agent-file` cannot combine with `--session`/`--continue`, so a resumed
    // Kimi seat can never be re-briefed on argv: it keeps the doctrine its
    // first generation was given and falls back to typed delivery.
    labels: [
      "injection A",
      "agent file",
      "hook feed",
      "capture session",
      "doctrine at creation",
    ],
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
 *
 * Re-probed 0.2.1 (2026-08-25):
 * - `--agents` is an agent-definition overlay, NOT a doctrine route. Its schema
 *   is strict {name, instructions, optional tools}, `systemPrompt` is rejected
 *   outright, unknown keys are silently dropped, and instructions demanding a
 *   canary prefix were never obeyed in main-session turns. Tier stays B; no
 *   agentFlag, no systemPromptFlag, nothing here advertises otherwise.
 * - The session id is never printed: a live PTY capture carries no UUID and the
 *   OSC title is the bare workspace name. It is the session directory's name
 *   (term/templates/muse-session.ts reads it back, workspace-scoped).
 * - `muse resume <uuid>` is exact; BARE `muse resume` opens the session picker
 *   and must never be emitted — a seat on no known session.
 * - The "responsive host" requirement is hard: with OSC 10/11 and the OSC 4
 *   palette queries unanswered, 0.2.1 emits ~260 bytes and EXITS without ever
 *   painting. Answered, the same spawn paints the TUI and runs a turn.
 */
export const MUSE_TEMPLATE: ManagedTerminalTemplate = {
  harness: "muse",
  displayName: "Muse",
  probedVersion: "0.2.1",
  argvSpec: {
    binary: "muse",
    prefix: [],
    promptMode: "positional",
    modelFlag: "--model",
    effortFlag: "--reasoning-effort",
    permissionModeFlag: "--yolo",
    resumeMode: "subcommand",
    // Explicit, so the bare-`resume` picker can never be reached by defaulting.
    resumeSubcommand: ["resume"],
    resumeReinjection: "re-pass",
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
    resumeReinjection: "unprobed",
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
    resumeReinjection: "re-pass",
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
 * Antigravity CLI (Google Antigravity; binary: `agy`) — Tier A, capture session, grid feed.
 * Verified 1.1.13: `-i <prompt>` auto-submit; `--model`; `--effort` (low|medium|high);
 * `--dangerously-skip-permissions`; `--agent`; `--conversation <id>` resume.
 *
 * Re-probed 1.1.20 for injection: there is still no system-prompt flag, but
 * `--add-dir <dir>` (repeatable) mounts a directory into the workspace and an
 * `AGENTS.md` inside it loads as project doctrine — confirmed by a canary rule
 * obeyed from an added dir while the cwd carried no `AGENTS.md` at all. That
 * makes doctrine a spawn-time fact rather than a typed first message, so agy is
 * Tier A through the app-owned ephemeral rules dir (never the user workspace).
 * `--conversation <id>` resume was re-verified on the same build: a token
 * stated in one print-mode turn came back on the resumed conversation.
 */
export const AGY_TEMPLATE: ManagedTerminalTemplate = {
  harness: "agy",
  displayName: "Antigravity",
  probedVersion: "1.1.20",
  argvSpec: {
    binary: "agy",
    prefix: [],
    promptMode: "flag-i",
    modelFlag: "--model",
    effortFlag: "--effort",
    permissionModeFlag: "--dangerously-skip-permissions",
    agentFlag: "--agent",
    rulesDirFlag: "--add-dir",
    resumeMode: "flag",
    resumeFlag: "--conversation",
    resumeReinjection: "re-pass",
  },
  envSpec: SHARED_ENV_SPEC,
  injectionSpec: {
    tier: "A",
    flags: ["--add-dir"],
    description:
      "Doctrine is an AGENTS.md in an app-owned ephemeral rules dir mounted with --add-dir",
  },
  capabilityBadges: {
    instructionInjection: "A",
    hooks: false,
    effortAtSpawn: true,
    sessionId: "capture",
    remote: false,
    requiresGitCwd: false,
    stateFeed: "grid (screen rules)",
    attentionSource: "permission prompt ([y/n], do you want to proceed?)",
    labels: [
      "injection A",
      "grid",
      "effort",
      "capture session",
      "agents",
    ],
  },
  efforts: ["low", "medium", "high"],
  defaultPermissionMode: undefined,
};

/**
 * Amp CLI (Sourcegraph; binary: `amp`) — Tier B, provisioned thread, OSC → grid.
 *
 * Verified against 0.0.1787664850-g921ac7 by driving the real TUI in a PTY:
 * - `amp threads new --visibility private` prints one `T-<uuid>` and exits;
 * - `amp --no-ide -m <mode> threads continue <T-id>` opens the interactive TUI
 *   on that exact thread. `--no-ide` keeps a Vellum Command-spawned seat from
 *   attaching the operator's editor selection to every message;
 * - the one dial is `-m low|medium|high|ultra` (model + system prompt + tools
 *   together) — Amp exposes no model flag and no independent effort;
 * - there is no session-scoped system-prompt flag, so doctrine is Tier B;
 * - startup paints the composer with an `∼ Connecting` footer and NO OSC title;
 *   a turn paints a braille-prefixed title and a `≈ Streaming` footer; a
 *   finished turn paints `<title> - amp - <cwd>`.
 */
export const AMP_TEMPLATE: ManagedTerminalTemplate = {
  harness: "amp",
  displayName: "Amp",
  probedVersion: "0.0.1787664850",
  argvSpec: {
    binary: "amp",
    // Structural only: `--no-ide` decides what the seat IS (a standalone
    // terminal agent) rather than how it looks.
    prefix: ["--no-ide"],
    // No argv prompt slot: the thread is resumed by subcommand, so doctrine
    // and mail both ride the drive's typed path.
    promptMode: "none",
    modeFlag: "-m",
    resumeMode: "subcommand",
    resumeSubcommand: ["threads", "continue"],
    resumeReinjection: "unprobed",
  },
  envSpec: SHARED_ENV_SPEC,
  injectionSpec: {
    tier: "B",
    flags: [],
    description:
      "No session-scoped system-prompt flag — doctrine is the first typed message",
  },
  capabilityBadges: {
    instructionInjection: "B",
    hooks: false,
    effortAtSpawn: false,
    sessionId: "provision",
    remote: false,
    requiresGitCwd: false,
    stateFeed: "OSC title → grid (composer footer)",
    attentionSource: "approval footer (Waiting for Approval) + Ctrl+C menu",
    labels: [
      "injection B",
      "OSC + grid",
      "mode",
      "provisioned thread",
    ],
  },
  efforts: [],
  modes: ["low", "medium", "high", "ultra"],
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
  amp: AMP_TEMPLATE,
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
