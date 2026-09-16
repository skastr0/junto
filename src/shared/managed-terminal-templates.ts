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
 * prime-agent, kimi, muse, devin, cursor (2026-08 agent-CLI sweep).
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
  "fx",
  "omp",
  "vellum-overseer",
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
   * A seat Junto starts must present the same experience as the operator
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
  /**
   * Spawn dials some harnesses read from the ENVIRONMENT instead of argv (fx:
   * `FX_MODEL`, `FX_PERMISSION_MODE`). Declared here beside their argv
   * counterparts so a dial is template data either way, and so the resolved
   * env — rebuilt on every launch — carries them. That rebuild is why an
   * env-dial harness cannot suffer the "resume silently reverts the model"
   * trap that flag-passing harnesses need `resumeReinjection` for.
   */
  readonly modelEnvKey?: string;
  readonly permissionModeEnvKey?: string;
  /**
   * When set, effort is not a token at all: it rides inside the model value.
   * Cursor 2026.09.10-fd3934a accepts the hyphenated catalog slug
   * (`--model claude-opus-4-8-high`) and rejects `[effort=…]` on those ids
   * (`Cannot use this model`). Non-effort brackets the catalog already
   * carries (`composer-2.5[fast=false]`) stay intact. A picker effort with
   * no model selected has nothing to attach to and is dropped.
   */
  readonly effortModelBracketKey?: string;
  /** Permission / approval flag (`--permission-mode`, `-a`, `--yolo`). */
  readonly permissionModeFlag?: string;
  /** Hermes profile: `-p` / `--profile`. */
  readonly profileFlag?: string;
  /**
   * Provider selector for harnesses that route a model through a named
   * provider (Hermes `--provider`). It travels WITH the model — a Hermes resume
   * that re-passes one without the other reverts silently.
   */
  readonly providerFlag?: string;
  /** Session pin when supported (`--session-id`). Absent ⇒ capture-only. */
  readonly sessionIdFlag?: string;
  /**
   * Resume shape — always with an explicit session id. Never `--continue` / `-c`
   * (id-less "latest session" is not a Junto feature).
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
   * Junto mounts ONLY its own directory
   * (`<JUNTO_HOME>/.junto/content/agent-rules/<seat>/`): the
   * operator's workspace is never written to, and the loaded context cites the
   * app-owned path as its origin. Official agy 1.2.1 best-practices also parse
   * a workspace-root `AGENTS.md` / `GEMINI.md`; that is why the seat still
   * never writes the operator cwd. Whether an `--add-dir` `AGENTS.md` is
   * still obeyed on 1.2.1 is UNVERIFIED (1.1.20 canary; flag still exists).
   */
  readonly rulesDirFlag?: string;
  /**
   * Extra tokens emitted only on a resume that also re-passes injection
   * carriers. Claude 2.1.267+ snapshots `--append-system-prompt` by default
   * (`--system-prompt-snapshot` defaults on), so a later different append is
   * ignored unless this is `["--system-prompt-snapshot", "off"]`.
   */
  readonly resumeReinjectionArgv?: readonly string[];
  /**
   * Whether re-passing the injection carriers (`systemPromptFlag` / `agentFlag`)
   * on a RESUME launch actually reaches the harness. This is a probe receipt,
   * not a preference — a harness that freezes its instructions at thread
   * creation accepts the flag on the command line and silently ignores it, so
   * without this fact the argv would look correct and the seat would run
   * un-briefed.
   *
   * - `re-pass`   — resume argv carrying the injection spec is honored.
   *   Probed 2026-08: claude, pi, cursor, agy, muse, hermes. Claude
   *   2.1.268 keeps this class only because `resumeReinjectionArgv` turns
   *   snapshot recording off; without that, a changed append is ignored.
   *   (Hermes also needs `-m` re-passed on every resume or the model silently
   *   reverts; `buildArgv` already re-passes every template-owned flag on
   *   resume.)
   * - `frozen`    — instructions are fixed at session creation and cannot be
   *   re-passed. Probed 2026-08: codex (re-passed developer instructions do not
   *   apply to an existing thread) and kimi (`--agent-file` cannot combine with
   *   `--session` / `--continue` at all). Probed 2026-09-11: grok 1.0.25
   *   (`--rules` on `-r` resume is accepted and ignored). Doctrine for these
   *   harnesses is delivered-at-creation; later generations are re-oriented
   *   by the injection supervisor's notices instead.
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
 * - launching Junto from inside a Prime Agent worker exports
 *   PI_CODING_AGENT, which must not classify a new harness process as nested;
 * - agent/tooling parents commonly export NO_COLOR for their own logs, which
 *   disables the managed harness TUI even though Junto provides a
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
  // fx reads its spawn dials from the environment, so a seat launched from
  // inside an fx session would silently inherit that session's model,
  // permission mode, and step limit instead of the seat's own. Same family as
  // the CLAUDE_CODE / PI_CODING_AGENT precedents: an ambient value that
  // quietly overrides what the operator chose.
  "FX_MODEL",
  "FX_PERMISSION_MODE",
  "FX_MAX_AGENT_STEPS",
  // Devin binds the same class of spawn dials from the environment
  // (`DEVIN_MODEL`, `DEVIN_PERMISSION_MODE`, `DEVIN_SANDBOX`). An ambient
  // model would leak onto a seat that did not choose one; an ambient
  // sandbox would enable the research-preview exec sandbox without a
  // picker choice. Argv `--permission-mode` / `--sandbox` still win when
  // the emit path sets them.
  "DEVIN_MODEL",
  "DEVIN_PERMISSION_MODE",
  "DEVIN_SANDBOX",
  // Recording knobs — inherited, they make a seat write tapes nobody asked for.
  "FX_RECORD",
  "FX_RECORD_INPUT",
  // Oh My Pi shares the pi-family env namespace. Inherited, these silently
  // redirect a seat's state home or reassign its model roles — the same class
  // of ambient override as CLAUDE_CODE_CHILD_SESSION.
  "OMP_PROFILE",
  "PI_CODING_AGENT_DIR",
  "PI_NO_PTY",
  "PI_SMOL_MODEL",
  "PI_SLOW_MODEL",
  "PI_PLAN_MODEL",
] as const;

/**
 * Prefixes reserved for harness-internal process roles. Scrub the namespace,
 * rather than today's known keys, so a future Prime Agent worker marker cannot
 * make Junto's app-owned foreground daemon masquerade as a worker.
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

// ── Mail transport (crew mail substrate) ───────────────────────────────────

/**
 * T2 typed-notice paste *support*, not live qualification and not
 * Message.metadata.mailKind (`notice` | `prompt` | `receipt`).
 * `working` means a paste channel exists. `unavailable-setup` means
 * isolation, credentials, or a picker currently cannot prove notice
 * acceptance. Hooks that only report idle/state are not a native channel.
 */
export type MailTypedNoticeSupport = "working" | "unavailable-setup";

/**
 * Per-harness mail delivery facts consumed by harness list / doctor.
 * T1 `nativeChannel` is true only when an implemented transport proves
 * acceptance — false everywhere today. T2 `typedNotice` is support;
 * `typedNoticeQualified` is live isolated notice/prompt proof and stays
 * false until a durable mail app receipt run. A mail-notice.jsonl capture
 * is adapter evidence only. Every harness is T3 pull-only.
 * Mail facts (queuedAt, notifiedAt, unresolvedAt, refusedAt, refusedReason,
 * readAt, repliedAt, reactedAt, generation) live on the message attempt,
 * never here. Legacy deliveredAt maps to notifiedAt only.
 */
export type MailTransportSpec = {
  readonly nativeChannel: boolean;
  readonly typedNotice: MailTypedNoticeSupport;
  readonly typedNoticeQualified: boolean;
  readonly pullOnly: true;
};

/** Exact tiers for harness list / doctor. Same facts as MailTransportSpec, not parallel keys. */
export type MailTransportTiers = {
  readonly t1NativeChannel: boolean;
  readonly t2Support: MailTypedNoticeSupport;
  readonly t2Qualified: boolean;
  readonly t3PullOnly: true;
};

export const mailTransportTiers = (spec: MailTransportSpec): MailTransportTiers => ({
  t1NativeChannel: spec.nativeChannel,
  t2Support: spec.typedNotice,
  t2Qualified: spec.typedNoticeQualified,
  t3PullOnly: spec.pullOnly,
});

export type IsolationHomePin = {
  readonly envKey: string;
  /** Path relative to the isolated capture home. */
  readonly homeRelative: string;
};

/**
 * One operator-home relative file that may be copied into a throwaway home.
 * Directories, settings, sessions, and history are not representable here.
 */
export type IsolationCredentialFile = {
  readonly operatorRelative: string;
  readonly isolatedRelative: string;
};

/**
 * How a disposable capture/test home relocates this harness's config and
 * session state. Tests inherit only `credentialEnv` and `credentialFiles`
 * from the operator process; they never copy history or settings files.
 */
export type IsolationSpec = {
  readonly homePins: readonly IsolationHomePin[];
  readonly credentialEnv: readonly string[];
  readonly credentialFiles: readonly IsolationCredentialFile[];
  readonly captureHome: "isolated" | "unsupported";
  readonly limitation?: string;
};

const MAIL_T2_WORKING: MailTransportSpec = {
  nativeChannel: false,
  typedNotice: "working",
  typedNoticeQualified: false,
  pullOnly: true,
};

const MAIL_T2_UNAVAILABLE: MailTransportSpec = {
  nativeChannel: false,
  typedNotice: "unavailable-setup",
  typedNoticeQualified: false,
  pullOnly: true,
};

const HOME_ONLY_ISOLATION: IsolationSpec = {
  homePins: [],
  credentialEnv: [],
  credentialFiles: [],
  captureHome: "isolated",
};

/** Template facts reported by harness list / doctor. T1 is none today. */
export const HARNESS_MAIL_TRANSPORT: Readonly<Record<HarnessId, MailTransportSpec>> = {
  claude: MAIL_T2_WORKING,
  codex: MAIL_T2_WORKING,
  grok: MAIL_T2_WORKING,
  hermes: MAIL_T2_UNAVAILABLE,
  pi: MAIL_T2_WORKING,
  "prime-agent": MAIL_T2_UNAVAILABLE,
  kimi: MAIL_T2_UNAVAILABLE,
  muse: MAIL_T2_WORKING,
  devin: MAIL_T2_WORKING,
  cursor: MAIL_T2_UNAVAILABLE,
  agy: MAIL_T2_UNAVAILABLE,
  amp: MAIL_T2_WORKING,
  fx: MAIL_T2_UNAVAILABLE,
  omp: MAIL_T2_WORKING,
  "vellum-overseer": MAIL_T2_UNAVAILABLE,
};

export const HARNESS_ISOLATION: Readonly<Record<HarnessId, IsolationSpec>> = {
  claude: {
    homePins: [{ envKey: "CLAUDE_CONFIG_DIR", homeRelative: ".claude" }],
    credentialEnv: [],
    credentialFiles: [],
    captureHome: "isolated",
    limitation:
      "isolated CLAUDE_CONFIG_DIR paints a login picker; ~/.claude/.credentials.json is absent; keychain service Claude Code-credentials is not consumed by that isolated TUI; ANTHROPIC_API_KEY is unset. Do not copy ~/.claude.json (settings/projects) or run TUI login (may write the live keychain item).",
  },
  codex: {
    homePins: [{ envKey: "CODEX_HOME", homeRelative: ".codex" }],
    credentialEnv: [],
    credentialFiles: [],
    captureHome: "isolated",
    limitation:
      "isolated CODEX_HOME has no auth.json. Operator auth.json carries tokens.refresh_token; copying it into a live CLI can rotate the refresh token server-side and strand the operator file. OPENAI_API_KEY is unset. Do not copy config.toml, sessions, or history.",
  },
  grok: {
    ...HOME_ONLY_ISOLATION,
    limitation: "reads ~/.grok under isolated HOME; spawn still needs a git cwd",
  },
  hermes: {
    ...HOME_ONLY_ISOLATION,
    limitation: "isolated HOME has no Codex credentials; captured setup is not a model turn",
  },
  pi: {
    homePins: [
      { envKey: "PI_CODING_AGENT_DIR", homeRelative: ".pi/agent" },
      { envKey: "PI_CODING_AGENT_SESSION_DIR", homeRelative: ".pi/agent/sessions" },
    ],
    credentialEnv: [],
    credentialFiles: [],
    captureHome: "isolated",
    limitation: "PI_CODING_AGENT_DIR is resolved before HOME; pin it or operator config leaks",
  },
  "prime-agent": {
    ...HOME_ONLY_ISOLATION,
    limitation: "first paint is a provider/sign-in picker; no committed notice corpus",
  },
  kimi: {
    ...HOME_ONLY_ISOLATION,
    limitation: "isolated HOME has no provider; captured setup is LLM-not-set, not a model turn",
  },
  muse: {
    ...HOME_ONLY_ISOLATION,
    limitation: "echo provider needs no credentials; not a remote-model turn",
  },
  devin: {
    ...HOME_ONLY_ISOLATION,
    credentialFiles: [
      {
        operatorRelative: ".local/share/devin/credentials.toml",
        isolatedRelative: ".local/share/devin/credentials.toml",
      },
    ],
    limitation:
      "seed only ~/.local/share/devin/credentials.toml; never sessions.db, transcripts, or ~/.config/devin/config.json. DEVIN_BEARER_TOKEN is unset; do not copy Chrome localStorage.",
  },
  cursor: {
    ...HOME_ONLY_ISOLATION,
    limitation: "no committed JSONL corpus; T2 notice acceptance unproven",
  },
  agy: {
    ...HOME_ONLY_ISOLATION,
    limitation: "no committed JSONL corpus; T2 notice acceptance unproven",
  },
  amp: {
    ...HOME_ONLY_ISOLATION,
    limitation: "isolated HOME hits login; recorded-byte T2 is not native factory qualification",
  },
  fx: {
    ...HOME_ONLY_ISOLATION,
    limitation: "no committed JSONL corpus; T2 notice acceptance unproven",
  },
  omp: {
    homePins: [
      { envKey: "PI_CODING_AGENT_DIR", homeRelative: ".pi/agent" },
      { envKey: "PI_CODING_AGENT_SESSION_DIR", homeRelative: ".pi/agent/sessions" },
    ],
    credentialEnv: [],
    credentialFiles: [],
    captureHome: "isolated",
    limitation: "isolated HOME is a provider picker; operator-home T2 was a disposable cwd",
  },
  "vellum-overseer": {
    homePins: [],
    credentialEnv: [],
    credentialFiles: [],
    captureHome: "unsupported",
    limitation: "structured host, not a TUI paste channel",
  },
};

/**
 * Host process keys a caller may merge onto an isolated overlay.
 * Auth tokens, SSH agent, and harness config dirs are not in this list.
 */
export const ISOLATED_SPAWN_RUNTIME_KEYS = [
  "PATH",
  "TERM",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "TMP",
  "TEMP",
] as const;

const stripTrailingSep = (value: string): string => value.replace(/[/\\]+$/, "");

export const isOperatorHomePath = (
  candidate: string,
  operatorHome: string,
): boolean => {
  if (candidate.length === 0 || operatorHome.length === 0) return false;
  return stripTrailingSep(candidate) === stripTrailingSep(operatorHome);
};

/**
 * Overlay for a disposable capture or generated-canvas real-harness spawn.
 * `ok: true` `env` is HOME / XDG / config pins / declared credential keys
 * only — merge onto the sandbox process env. Never copy operator history
 * or settings. `ok: false` is a hard refusal: no env, never operator HOME.
 */
export type IsolatedCaptureEnvResult =
  | {
      readonly ok: true;
      readonly env: Record<string, string>;
      readonly limitation?: string;
    }
  | {
      readonly ok: false;
      readonly limitation: string;
    };

export type IsolatedHarnessLaunch =
  | {
      readonly ok: true;
      readonly harness: HarnessId;
      readonly isolatedHome: string;
      readonly cwd: string;
      readonly env: Record<string, string>;
      readonly captureHome: "isolated";
      readonly limitation?: string;
    }
  | {
      readonly ok: false;
      readonly harness: HarnessId;
      readonly captureHome: "unsupported";
      readonly limitation: string;
    };

export type IsolatedCaptureRequest = {
  readonly harness: HarnessId;
  readonly isolatedHome: string;
  /** Injected by the Node launch/capture boundary. Never read from node:os here. */
  readonly operatorHome: string;
  readonly ambient?: NodeJS.Dict<string | undefined>;
};

/**
 * Build a capture/test environment that never points HOME or harness config
 * at the operator's real home. Inherits only declared credential keys.
 * `captureHome: "unsupported"` refuses with a limitation and returns no env.
 * `operatorHome` is required and compared to `isolatedHome`.
 */
export const isolatedCaptureEnv = (
  input: IsolatedCaptureRequest,
): IsolatedCaptureEnvResult => {
  const spec = HARNESS_ISOLATION[input.harness];
  if (spec.captureHome === "unsupported") {
    return {
      ok: false,
      limitation: spec.limitation ?? "capture home unsupported",
    };
  }
  if (input.operatorHome.length === 0) {
    return {
      ok: false,
      limitation: "operator home must be injected by the Node launch/capture boundary",
    };
  }
  if (
    input.isolatedHome.length === 0 ||
    input.isolatedHome === "~" ||
    input.isolatedHome === "."
  ) {
    return { ok: false, limitation: "isolated home must be an absolute throwaway directory" };
  }
  if (isOperatorHomePath(input.isolatedHome, input.operatorHome)) {
    return {
      ok: false,
      limitation: "isolated home must not be the operator home",
    };
  }
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.ambient ?? {})) {
    if (value === undefined) continue;
    if (spec.credentialEnv.includes(key)) env[key] = value;
  }
  env.HOME = input.isolatedHome;
  env.USERPROFILE = input.isolatedHome;
  env.XDG_CONFIG_HOME = `${input.isolatedHome}/.config`;
  env.XDG_DATA_HOME = `${input.isolatedHome}/.local/share`;
  env.XDG_CACHE_HOME = `${input.isolatedHome}/.cache`;
  env.XDG_STATE_HOME = `${input.isolatedHome}/.local/state`;
  for (const pin of spec.homePins) {
    env[pin.envKey] = `${input.isolatedHome}/${pin.homeRelative}`;
  }
  return { ok: true, env, limitation: spec.limitation };
};

/** Runtime PATH/TERM/TMP only. Never auth keys or operator HOME. */
export const isolatedSpawnRuntimeEnv = (
  runtime: NodeJS.Dict<string | undefined>,
): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const key of ISOLATED_SPAWN_RUNTIME_KEYS) {
    const value = runtime[key];
    if (value !== undefined && value.length > 0) env[key] = value;
  }
  return env;
};

/** Constructor for generated-canvas / pty-capture. `cwd` and `isolatedHome` must be throwaway. */
export const buildIsolatedHarnessLaunch = (input: IsolatedCaptureRequest & {
  readonly cwd: string;
}): IsolatedHarnessLaunch => {
  const overlay = isolatedCaptureEnv(input);
  if (!overlay.ok) {
    return {
      ok: false,
      harness: input.harness,
      captureHome: "unsupported",
      limitation: overlay.limitation,
    };
  }
  return {
    ok: true,
    harness: input.harness,
    isolatedHome: input.isolatedHome,
    cwd: input.cwd,
    env: { ...overlay.env, PWD: input.cwd },
    captureHome: "isolated",
    limitation: overlay.limitation,
  };
};

// ── Template ───────────────────────────────────────────────────────────────

export type ManagedTerminalTemplate = {
  readonly harness: HarnessId;
  readonly displayName: string;
  readonly argvSpec: ArgvSpec;
  readonly envSpec: EnvSpec;
  readonly injectionSpec: InjectionSpec;
  readonly capabilityBadges: CapabilityBadges;
  readonly mailTransport: MailTransportSpec;
  readonly isolation: IsolationSpec;
  /**
   * Effort values the picker may offer. Empty = omit effort in v1
   * (no spawn flag on the harness).
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
  // PATH inject so `dist/junto` resolves for `junto onboard`.
  injectKeys: [
    "PATH",
    "JUNTO_SOCKET",
    "JUNTO_TOKEN",
    "JUNTO_SEAT",
    "JUNTO_NODE_REF",
  ],
};

// ── Four v1 templates ──────────────────────────────────────────────────────

/**
 * Claude Code — Tier A, session pin.
 *
 * Re-probed 2.1.268 (2026-09-11):
 * - `--append-system-prompt` is still the Tier-A carrier.
 * - `--system-prompt-snapshot` defaults on (CHANGELOG 2.1.267). A later
 *   different append is ignored on resume unless `--system-prompt-snapshot
 *   off` rides with the carrier (`resumeReinjectionArgv`). Live print-mode
 *   canary on this build: ALPHA create → BETA resume (no off) stayed ALPHA;
 *   GAMMA resume with off returned GAMMA.
 * - `--effort ultracode` accepted at spawn despite incomplete CLI help.
 * - `--permission-mode default` accepted; `--help` lists `manual` as the
 *   displayed alias for that mode.
 */
export const CLAUDE_TEMPLATE: ManagedTerminalTemplate = {
  harness: "claude",
  displayName: "Claude Code",
  probedVersion: "2.1.268",
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
    resumeReinjectionArgv: ["--system-prompt-snapshot", "off"],
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
  mailTransport: HARNESS_MAIL_TRANSPORT.claude,
  isolation: HARNESS_ISOLATION.claude,
  // Six levels verified; ultracode accepted at spawn despite incomplete CLI help.
  efforts: ["low", "medium", "high", "xhigh", "max", "ultracode"],
  defaultPermissionMode: "default",
};

export const CODEX_TEMPLATE: ManagedTerminalTemplate = {
  harness: "codex",
  displayName: "Codex",
  probedVersion: "0.154.0",
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
  mailTransport: HARNESS_MAIL_TRANSPORT.codex,
  isolation: HARNESS_ISOLATION.codex,
  // Common floors from `codex debug models` on 0.154.0 (union). Per-model
  // lists come from supported_reasoning_levels[].effort when the catalog runs.
  efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
  defaultPermissionMode: "on-request",
};

/**
 * Grok — Tier A, session pin.
 *
 * Re-probed 1.0.25 (2026-09-11):
 * - `--rules` is still the Tier-A carrier on create (ALPHA_RULES_ONLY honored).
 * - `--rules` on `-r` resume is accepted and ignored: pin with ALPHA, then
 *   `-r <id> --rules BETA` answered ALPHA_RULES_ONLY. `resumeReinjection` is
 *   therefore `frozen`. `--agent` re-pass on resume was not separately
 *   canaried (UNVERIFIED).
 * - Effort vocabulary is `xhigh|high|medium|low` (`grok --reasoning-effort
 *   invalid`; grok-4.6 `models_cache.json` `reasoning_efforts` includes
 *   xhigh). The picker uses this flat list: cache rows are objects
 *   (`id`/`value`), not a string array, so per-model derivation is not wired.
 * - `requiresGitCwd` stays true. Changelog 1.0.0 skipped the project-directory
 *   prompt for home / non-project dirs, and headless `-p` in a non-git `/tmp`
 *   completed a turn, but the TUI positional-prompt swallow was not re-probed
 *   in a PTY.
 */
export const GROK_TEMPLATE: ManagedTerminalTemplate = {
  harness: "grok",
  displayName: "Grok",
  probedVersion: "1.0.25",
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
    resumeReinjection: "frozen",
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
  mailTransport: HARNESS_MAIL_TRANSPORT.grok,
  isolation: HARNESS_ISOLATION.grok,
  // CLI 1.0.25 enumerates xhigh|high|medium|low; grok-4.5 cache still
  // omits xhigh, but the flag accepts the union on this binary.
  efforts: ["xhigh", "high", "medium", "low"],
  defaultPermissionMode: "default",
};

/**
 * Hermes — Tier B, capture session, remote-capable.
 *
 * Re-probed 0.21.0 (2026-09-11):
 * - `--reasoning LEVEL` is a spawn flag on root and `hermes chat`
 *   (`none|minimal|low|medium|high|xhigh|max|ultra`). The 0.20.4 probe
 *   recorded no effort flag (typed `/reasoning` only).
 * - Session storage is still `~/.hermes/state.db` ALONE. The jsonl transcripts
 *   under `~/.hermes/sessions/` remain retired: new sessions write nothing
 *   there, so the database is the only current receipt and
 *   `hermesSessionExists` reads it.
 * - `HERMES_SESSION_ID` reaches the agent shell and IS the session id
 *   (`%Y%m%d_%H%M%S_<hex6>`), which is what the capture path observes.
 * - `--resume <id>` keeps continuity. Silent model revert unless `-m` (and
 *   `--provider`, where one was chosen) are re-passed is a 0.20.4 receipt,
 *   not re-smoked on 0.21.0 (UNVERIFIED). `buildArgv` still re-passes every
 *   template-owned flag on resume.
 * - Trap: the `hermes resume` SUBCOMMAND lifts an ESTOP sentinel; it is not
 *   session resume. This template resumes by flag and never by subcommand.
 *
 * `chat --tui` stays the prefix: a Junto seat is a visible TUI on a
 * real PTY. On 0.21.0, `-q` on a TTY seeds an interactive session; the
 * headless answer-and-exit path is `--oneshot` / `-Q` / non-TTY.
 *
 * Re-probed 0.21.3 (2026-09-16, upstream 6cd25026) after `hermes update`:
 * - `hermes chat --help` still lists `--tui`, `-q/--query`, `-m/--model`,
 *   `--provider`, `--reasoning LEVEL`, `--yolo`, and `--resume/-r SESSION_ID`.
 * - `--profile` / `-p` is not in either `--help`; `hermes_cli/main.py` still
 *   pre-parses it off argv before argparse, so the flag works but is hidden.
 * - `~/.hermes/state.db` is still the sole session store (`sessions` table
 *   grows; nothing new under `~/.hermes/sessions/`).
 * - Composer paint and multiline-paste chip were not re-captured (UNVERIFIED).
 */
export const HERMES_TEMPLATE: ManagedTerminalTemplate = {
  harness: "hermes",
  displayName: "Hermes",
  probedVersion: "0.21.3",
  argvSpec: {
    binary: "hermes",
    // -z / chat -q without --tui are headless. Interactive auto-submit needs --tui.
    prefix: ["chat", "--tui"],
    promptMode: "flag-q",
    modelFlag: "-m",
    // Re-passed with the model on every resume, or the model reverts silently.
    providerFlag: "--provider",
    effortFlag: "--reasoning",
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
    effortAtSpawn: true,
    // state.db proves a session id, so cold resume is real; the badge used to
    // say unavailable because the retired jsonl tree was the only thing probed.
    sessionId: "capture",
    remote: true,
    requiresGitCwd: false,
    stateFeed: "OSC (--tui only) → grid",
    attentionSource: "OSC title ⚠",
    labels: [
      "injection B",
      "OSC + grid",
      "effort",
      "capture session",
      "remote",
    ],
  },
  mailTransport: HARNESS_MAIL_TRANSPORT.hermes,
  isolation: HARNESS_ISOLATION.hermes,
  efforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
};

// ── Five 2026-08 harnesses (2026-08 agent-CLI sweep) ─────

/**
 * Pi (earendil-works pi-coding-agent) — Tier A, session pin, RPC/JSON embed.
 * Verified 0.83.0: positional prompt; --thinking effort (7 levels);
 * --session-id pin (create-if-missing, uuidv7); non-interactive resume is
 * `--session <path|partial-id>` (NOT -r, which opens a picker);
 * --append-system-prompt repeatable; --tools/--exclude-tools allowlists;
 * no per-command permission mode (--approve gates project-local trust only).
 *
 * Re-probed 0.85.1 (2026-09-11): every template-owned spawn flag still
 * exists on `pi --help` and official usage.md. Changelog 0.84.0–0.85.1
 * is additive TUI, theme, and observer surface (`--tui-mode`, `--use-theme`,
 * `/thinking`, `ui_prompt_start` / `ui_prompt_end`); none rename or remove
 * `--model`, `--thinking`, `--session-id`, `--session`, or
 * `--append-system-prompt`. `resumeReinjection: "re-pass"` is the 2026-08
 * receipt and was not re-canaried on 0.85.1 (UNVERIFIED).
 */
export const PI_TEMPLATE: ManagedTerminalTemplate = {
  harness: "pi",
  displayName: "Pi",
  probedVersion: "0.85.1",
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
  mailTransport: HARNESS_MAIL_TRANSPORT.pi,
  isolation: HARNESS_ISOLATION.pi,
  efforts: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
};

/**
 * Prime Agent (stock separately installed `prime-agent` CLI) — shipped Tier A,
 * capture session, with a built-in reporter (idle/working/blocked + session id).
 * Verified 0.7.1: positional prompt; --thinking effort (7 levels); resume
 * `-r <path|id>` / `-c` (no pin flag — capture from reporter / list --json);
 * --append-system-prompt repeatable; no permission-mode flag (--autonomous is
 * unattended mode, not an approval enum). Junto owns one isolated
 * foreground daemon per live binding. Its unique --daemon-socket is runtime
 * launch state and must never enter this authorial argv template.
 *
 * Re-probed 0.9.4 (2026-09-11): every template-owned spawn flag still exists
 * on `prime-agent --help` and official usage.md. Changelog 0.7.2–0.9.4 does
 * not rename or remove `--model`, `--thinking`, `-r` / `--resume`, or
 * `--append-system-prompt`. Daemon admission is `>= 0.7.1`, not an exact pin.
 * `resumeReinjection: "unprobed"` stays — append-on-cold-`-r` was not
 * canaried (UNVERIFIED). Remote SSH TUI was not re-probed (UNVERIFIED).
 */
export const PRIME_AGENT_TEMPLATE: ManagedTerminalTemplate = {
  harness: "prime-agent",
  displayName: "Prime Agent",
  probedVersion: "0.9.4",
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
  mailTransport: HARNESS_MAIL_TRANSPORT["prime-agent"],
  isolation: HARNESS_ISOLATION["prime-agent"],
  efforts: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
};

/**
 * Kimi Code (Moonshot) — Tier A by agent file, capture session, native hook feed.
 * Verified 0.29.0: NO argv prompt slot in the TUI (promptMode "none"); -m model;
 * --yolo/--auto approval (no enum); resume `-S <id>` (never bare `-S` / `-c`);
 * no pin. 20-event JSON-stdin hooks (PermissionRequest→blocked) live in the
 * user's config, so Junto never installs them (badge hooks: false).
 *
 * Re-probed 0.34.0 (2026-09-11):
 * - The TUI starts without a session (changelog 0.33.0). A trusted-cwd welcome
 *   card prints a blank `Session:` line plus "No session yet — one will be
 *   created on your first message." Capture treats `Session: <id>` as a
 *   post-first-message scrape, never a startup receipt. Whether the card
 *   fills after the first turn is UNVERIFIED. Durable proof is
 *   `~/.kimi-code/sessions/<workDirKey>/<id>/` (`kimiSessionExists`).
 * - `--agent-file <path>` still loads a Markdown agent whose body IS the
 *   system prompt (2026-08-25 canary). Frontmatter is pre-flight — a bad key
 *   exits 1 — so `agent-file-spec` emits only name/description/tools.
 * - `--agent-file` cannot combine with `-S` / `--session` / `--continue`.
 *   Live 0.34.0 exits 1: "Cannot combine --agent/--agent-file with
 *   --session/--continue". `resumeReinjection` stays frozen; `buildArgv`
 *   never emits that pair.
 */
export const KIMI_TEMPLATE: ManagedTerminalTemplate = {
  harness: "kimi",
  displayName: "Kimi Code",
  probedVersion: "0.34.0",
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
  mailTransport: HARNESS_MAIL_TRANSPORT.kimi,
  isolation: HARNESS_ISOLATION.kimi,
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
 *
 * Re-probed 1.1.1-R2514.1 (2026-09-11):
 * - `--reasoning-effort` vocabulary adds `max` (`muse --help` and
 *   `muse exec --reasoning-effort foo`: none|minimal|low|medium|high|xhigh|max|ultra).
 *   Official config docs still omit it.
 * - Parent `session.jsonl` often starts with `retained_frame` /
 *   `session_permission_transaction`. Capture scans for the first
 *   `runtime.session.metadata` record (stream.id === directory name,
 *   microsecond `recorded_at`, workspace_root). Directory name remains the UUID.
 * - `muse resume <uuid>` is still exact. Additive `muse resume --last` is a
 *   second id-less latest-session form and must never be emitted (same as
 *   bare `muse resume`).
 * - `--session-id` remains TUI-rejected (exec-only). Seats stay capture-only.
 * - `systemPrompt` on `--agents` is still rejected. Tier stays B.
 * - Unanswered PTY still emits OSC 10/11 + OSC 4 + DSR; an 8s probe did not
 *   exit. Painting without answers is UNVERIFIED. The 0.2.1 fatal-exit claim
 *   is stale.
 * - `resumeReinjection: "re-pass"` is the 2026-08 receipt and was not
 *   re-canaried on 1.1.1 (UNVERIFIED). Root options still allowed on either
 *   side of `resume`.
 */
export const MUSE_TEMPLATE: ManagedTerminalTemplate = {
  harness: "muse",
  displayName: "Muse",
  probedVersion: "1.1.1-R2514.1",
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
  mailTransport: HARNESS_MAIL_TRANSPORT.muse,
  isolation: HARNESS_ISOLATION.muse,
  efforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
};

/**
 * Devin CLI (Cognition) — Tier B, capture session, grid feed.
 * Re-probed 3000.10.21 (2026-09-11): positional prompt REQUIRES `--`
 * separator; `--model`; `--permission-mode` (`normal`, alias `auto`;
 * `accept-edits`; `smart`; `dangerous`, aliases `yolo` / `bypass`;
 * `autonomous`, which requires `--sandbox` on the same argv). Help
 * default prints `auto`. Official docs treat `normal` as the default;
 * `defaultPermissionMode: "normal"` is still accepted. Resume is
 * `-r <id>` exact; bare `-r` is a picker and is never emitted. No pin.
 *
 * `--agent-config` is gone. 3000.4.16 and 3000.10.21 both answer
 * `error: unexpected argument '--agent-config' found` and exit 2. There
 * is no argv replacement (`--system-prompt`, `--rules`, `--agent` are
 * also rejected). File doctrine (`AGENTS.md`, `.devin/rules`) is
 * workspace/user config, not a spawn flag. Doctrine stays the first
 * typed message.
 *
 * Session capture is a lookup, not a scrape: Devin prints its slug id
 * nowhere, and writes `session_locks/<slug>.lock` from a descendant of
 * the spawned process. `devin-session-capture` matches the lock's PID
 * against the spawn's process tree; the id becomes durable only once
 * Devin's own `sessions` row exists, which is what `-r <id>` reads.
 * `resumeReinjection` stays `unprobed`.
 */
export const DEVIN_TEMPLATE: ManagedTerminalTemplate = {
  harness: "devin",
  displayName: "Devin",
  probedVersion: "3000.10.21",
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
      "No system-prompt flag — doctrine delivered as the first typed message",
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
  mailTransport: HARNESS_MAIL_TRANSPORT.devin,
  isolation: HARNESS_ISOLATION.devin,
  efforts: [],
  defaultPermissionMode: "normal",
};

/**
 * Devin 3000.10.21 rejects `--permission-mode autonomous` unless `--sandbox`
 * is also on the argv. The settings picker never offers this mode (there is
 * no sandbox dial). The emit path pairs the flags if a seat already carries it.
 */
export const isSandboxGatedPermissionMode = (mode: string): boolean =>
  mode === "autonomous";

/**
 * Cursor Agent CLI (binary: `agent`) — Tier B, session PIN, grid feed.
 * Verified 2026.08.11: positional prompt; --model; --yolo/--force allow-all;
 * --resume <id> named only; --trust skips the workspace-trust modal. No public
 * system-prompt flag.
 *
 * Re-probed 2026-08-25 and two facts changed the shape:
 * - `--new-session-id <uuid>` starts a session with a caller-provided id, so
 *   Cursor is a PIN harness like Claude and Grok rather than a capture one.
 *   The alternative (`create-chat`) hands back an id for a chat that exists
 *   server-side only — nothing lands on disk until the first turn, so such an
 *   id can never be proven before use. A minted pin is knowable from the start.
 *   Durable proof appears at `~/.cursor/chats/<workspaceHash>/<id>/meta.json`.
 * - `--resume <id>` continues that exact session; it does not fork.
 *
 * Re-probed 2026.09.10-fd3934a (2026-09-11):
 * - Help still shows `'claude-opus-4-8[context=1m,effort=high,fast=false]'`.
 *   Live `--print --trust --model 'claude-opus-4-8[effort=high]'` (and the
 *   help example, and `claude-opus-4-8-high[effort=high]`) all reject with
 *   `Cannot use this model`. Working form is the hyphenated catalog slug
 *   (`claude-opus-4-8-high`, `claude-opus-5-high`).
 * - Non-effort brackets still work (`composer-2.5[fast=false]`).
 * - `--new-session-id` remains hidden from `--help` and official parameters
 *   but still pins. `create-chat` still returns a UUID with no disk receipt.
 * - Hidden `--system-prompt <file>` is client-parsed then API-rejected.
 *   Tier stays B. Whether a future server honors it is UNVERIFIED.
 * - `resumeReinjection: "re-pass"` is the 2026-08 receipt. `--model` is
 *   parsed on resume; typed TUI doctrine re-brief was not re-smoked
 *   (UNVERIFIED).
 */
export const CURSOR_TEMPLATE: ManagedTerminalTemplate = {
  harness: "cursor",
  displayName: "Cursor Agent",
  probedVersion: "2026.09.10-fd3934a",
  argvSpec: {
    binary: "agent",
    prefix: ["--trust"],
    promptMode: "positional",
    modelFlag: "--model",
    // Effort rides in the model value as a hyphenated catalog slug, never
    // a flag of its own and never `[effort=…]` (rejected on this build).
    effortModelBracketKey: "effort",
    permissionModeFlag: "--yolo",
    sessionIdFlag: "--new-session-id",
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
    // True only with a model: the hyphenated slug has nothing to attach to otherwise.
    effortAtSpawn: true,
    sessionId: "pin",
    remote: false,
    requiresGitCwd: false,
    stateFeed: "grid (alt buffer)",
    attentionSource: "grid (approval forms)",
    labels: ["injection B", "grid", "effort in model", "session pin"],
  },
  mailTransport: HARNESS_MAIL_TRANSPORT.cursor,
  isolation: HARNESS_ISOLATION.cursor,
  // Suffixes `agent models` enumerates on 2026.09.10-fd3934a. `-fast` is a
  // variant after the effort token (`-high-fast`), not a picker level. A
  // model that advertises its own levels still wins via `effortsFor`.
  efforts: [
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "extra-high",
    "max",
  ],
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
 *
 * Re-probed 1.2.1 (2026-09-11):
 * - Every claimed spawn flag still exists on `agy --help`. Installed
 *   `agy --version` and GitHub latest are both 1.2.1.
 * - Official best-practices now say a workspace-root `AGENTS.md` or
 *   `GEMINI.md` is parsed on startup. That contradicts the 1.1.20
 *   cwd-negative receipt. Junto still mounts ONLY the app-owned
 *   rules dir via `--add-dir` and never writes the operator workspace.
 *   Whether the `--add-dir` mount itself is still obeyed on 1.2.1 is
 *   UNVERIFIED (flag exists; canary not re-run).
 * - Permission-prompt copy since 1.1.28 names the action (`Run this
 *   command?`, `Allow access to this URL?`, `Allow calling this tool?`)
 *   plus an optional `Reason:` line. Attention matchers follow that copy
 *   and still accept the older `requesting permission for:` form.
 * - `--mode accept-edits|plan` is additive and is not a template dial.
 * - `resumeReinjection: "re-pass"` is the 2026-08 receipt and was not
 *   re-canaried on 1.2.1 (UNVERIFIED).
 */
export const AGY_TEMPLATE: ManagedTerminalTemplate = {
  harness: "agy",
  displayName: "Antigravity",
  probedVersion: "1.2.1",
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
    attentionSource:
      "permission prompt (Run this command?, Allow access to this URL?, Allow calling this tool?)",
    labels: [
      "injection A",
      "grid",
      "effort",
      "capture session",
      "agents",
    ],
  },
  mailTransport: HARNESS_MAIL_TRANSPORT.agy,
  isolation: HARNESS_ISOLATION.agy,
  efforts: ["low", "medium", "high"],
  defaultPermissionMode: undefined,
};

/**
 * Amp CLI (Sourcegraph; binary: `amp`) — Tier B, provisioned thread, OSC → grid.
 *
 * Verified against 0.0.1787664850-g921ac7 by driving the real TUI in a PTY:
 * - `amp threads new --visibility private` printed one `T-<uuid>` and exited;
 * - `amp --no-ide -m <mode> threads continue <T-id>` opens the interactive TUI
 *   on that exact thread. `--no-ide` keeps a Junto-spawned seat from
 *   attaching the operator's editor selection to every message;
 * - the one dial is `-m low|medium|high|ultra` (model + system prompt + tools
 *   together) — Amp exposes no model flag and no independent effort;
 * - there is no session-scoped system-prompt flag, so doctrine is Tier B;
 * - startup paints the composer with an `∼ Connecting` footer and NO OSC title;
 *   a turn paints a braille-prefixed title and a `≈ Streaming` footer; a
 *   finished turn paints `<title> - amp - <cwd>`.
 *
 * Re-probed 0.0.1789113641 (2026-09-11):
 * - `amp threads new --visibility private` now prints a sole
 *   `https://ampcode.com/threads/T-<uuid>` URL (help: "print its URL").
 *   The T-id is extracted from the path. A bare `T-<uuid>` line from older
 *   binaries is still a receipt.
 * - Named `threads continue <T-id>` still resumes (live `--no-ide -x` pong).
 *   Never `amp last`, `threads continue --last`, or bare `threads continue`.
 * - Dial, `--no-ide`, Tier B, and `resumeReinjection: "unprobed"` hold.
 *   OSC/grid paint was not re-smoked on this build (UNVERIFIED).
 */
export const AMP_TEMPLATE: ManagedTerminalTemplate = {
  harness: "amp",
  displayName: "Amp",
  probedVersion: "0.0.1789113641",
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
  mailTransport: HARNESS_MAIL_TRANSPORT.amp,
  isolation: HARNESS_ISOLATION.amp,
  efforts: [],
  modes: ["low", "medium", "high", "ultra"],
  defaultPermissionMode: undefined,
};

/**
 * fx (Vercel Labs; binary: `fx`) — Tier B, env dials, capture session, grid feed.
 *
 * Probed 0.0.6 (2026-08-26) against the installed binary:
 * - No system-prompt or session-instructions flag anywhere on the CLI surface,
 *   so doctrine is Tier B, delivered as the first typed message.
 * - Model and permission mode are read from the environment (`FX_MODEL`,
 *   `FX_PERMISSION_MODE`). Effort is a provider-profile concern, not a dial
 *   fx exposes — omitted rather than faked.
 * - Interactive `fx` takes no positional prompt (`fx [flags]`); `fx ask` is the
 *   one-shot, non-interactive path and is not what a seat runs.
 * - Session ids are minted by fx and never printed; `~/.fx/sessions/index.json`
 *   maps each id to its `workspace_root` and `created_at_ms`.
 * - Resume is `--resume <id>`, exact. Never emit bare `--resume`,
 *   `--resume last`, `-c`, `--continue`, `--resume-last`, or `-r`.
 *
 * Re-probed 0.0.7 (2026-09-11) on the installed binary (`fx --version`).
 * Upstream latest is 0.0.8 (https://github.com/vercel-labs/fx/releases/tag/v0.0.8)
 * and was not installed here — 0.0.8 spawn / capture was not re-smoked.
 * - `-r` opens the saved-session picker, not "latest". Never emit it.
 * - 0.0.8 adds `--full-access` / `--yolo` argv permission dials (official CLI
 *   docs). Installed 0.0.7 rejects them as unknown subcommands. Junto
 *   must not emit those flags. The env dial (`FX_PERMISSION_MODE`) stays the
 *   seat path. No permission default.
 * - 0.0.8 mints 12-character url-safe session ids; legacy `<ms>-<ns>-<hex>`
 *   remains valid. `isFxSessionId` accepts both so capture and existence
 *   proof do not fail-open to a fresh seat after operators upgrade. Live
 *   0.0.8 `index.json` schema is UNVERIFIED.
 * - Interactive 0.0.7 still has no `--model` / `--permission-mode` / `--system`.
 *   `fx ask --system TEXT` is one-shot only. Seats stay on plain `fx`.
 *
 * No permission default: fx's stock `auto` mode runs tool calls that cost the
 * operator money, and picking that for them is not Junto's call.
 */
export const FX_TEMPLATE: ManagedTerminalTemplate = {
  harness: "fx",
  displayName: "fx",
  probedVersion: "0.0.7",
  argvSpec: {
    binary: "fx",
    prefix: [],
    // No argv prompt slot: doctrine and mail both ride the drive's typed path.
    promptMode: "none",
    modelEnvKey: "FX_MODEL",
    permissionModeEnvKey: "FX_PERMISSION_MODE",
    resumeMode: "flag",
    resumeFlag: "--resume",
    // Untested: whether a resumed fx seat honours a typed re-brief. Unprobed
    // is treated as frozen until somebody proves otherwise.
    resumeReinjection: "unprobed",
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
    sessionId: "capture",
    remote: false,
    requiresGitCwd: false,
    stateFeed: "OSC title + grid (no alt screen)",
    attentionSource: "unprobed — no approval-form capture yet",
    labels: ["injection B", "grid", "env dials", "capture session"],
  },
  mailTransport: HARNESS_MAIL_TRANSPORT.fx,
  isolation: HARNESS_ISOLATION.fx,
  efforts: [],
};

/**
 * Oh My Pi (binary: `omp`) — Tier A, capture session, OSC title + grid.
 *
 * Probed 18.0.9 (2026-08-28) against the installed binary and one live turn:
 * - `--append-system-prompt <text|file>` exists, so doctrine rides argv:
 *   Tier A, unlike the pi-family harnesses around it.
 * - `--model` (fuzzy), `--thinking off|minimal|low|medium|high|xhigh|max|auto`,
 *   `--approval-mode always-ask|write|yolo`, positional prompt.
 * - No session pin. Sessions land at
 *   `~/.omp/agent/sessions/<encoded-cwd>/<ISO-ts>_<uuidv7>.jsonl`.
 * - `--resume <id-prefix>` continues the SAME session — proven by resuming a
 *   probe session and watching the one existing file grow rather than a second
 *   appear. So capture→cold-wake links up, and `-c` is never needed.
 * - The TUI renders inline (no alt screen), enables bracketed paste, and its
 *   OSC title is a real state machine (`π >` waiting, `π <braille>` running).
 *
 * Re-probed 18.1.16 (2026-09-11) on the installed binary (`omp --version`
 * prints `omp/18.1.16`):
 * - `--append-system-prompt` is last-write-wins, not repeatable. Help does
 *   not say "can be used multiple times" (unlike `--hook`). Installed
 *   `flag-tables.ts` assigns a single string. Junto already emits
 *   one flag; doctrine is one joined body, never two argv fragments.
 * - Session cwd encoding is three-way (installed `session-paths.ts`):
 *   home-relative `-…` (`-Projects-vellum`), cwd under `os.tmpdir()` is
 *   `-tmp-…`, anything else is the abs wrap (`--private-tmp-omp-probe--`).
 *   This machine's tmpdir is `/var/folders/…/T`, so the 18.0.9
 *   `/private/tmp/omp-probe` tree stays the abs wrap.
 * - `resumeReinjection: "re-pass"` is the 2026-08 receipt and was not
 *   re-canaried on 18.1.16 (UNVERIFIED). Source still applies model,
 *   thinking, approval, and append on resume. `buildArgv` still re-passes
 *   every template-owned flag.
 */
export const OMP_TEMPLATE: ManagedTerminalTemplate = {
  harness: "omp",
  displayName: "Oh My Pi",
  probedVersion: "18.1.16",
  argvSpec: {
    binary: "omp",
    prefix: [],
    promptMode: "positional",
    modelFlag: "--model",
    effortFlag: "--thinking",
    permissionModeFlag: "--approval-mode",
    systemPromptFlag: "--append-system-prompt",
    resumeMode: "flag",
    resumeFlag: "--resume",
    // Resume re-passes every dial: the flags are read from the new argv on a
    // resumed run, so a cold wake restores the model and thinking level the
    // seat was authored with instead of whatever the session last used.
    resumeReinjection: "re-pass",
  },
  envSpec: SHARED_ENV_SPEC,
  injectionSpec: {
    tier: "A",
    flags: ["--append-system-prompt"],
    description:
      "--append-system-prompt appends doctrine at spawn (one flag, last-write-wins)",
  },
  capabilityBadges: {
    instructionInjection: "A",
    hooks: false,
    effortAtSpawn: true,
    sessionId: "capture",
    remote: false,
    requiresGitCwd: false,
    stateFeed: "OSC title state machine + grid",
    attentionSource: "approval dialog (literals from the binary, uncaptured)",
    labels: ["injection A", "OSC + grid", "thinking", "capture session"],
  },
  mailTransport: HARNESS_MAIL_TRANSPORT.omp,
  isolation: HARNESS_ISOLATION.omp,
  efforts: ["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"],
};

/** App-owned structured controller. Its tool calls still enter the process-bound Work socket. */
export const JUNTO_OVERSEER_TEMPLATE: ManagedTerminalTemplate = {
  harness: "vellum-overseer",
  displayName: "Junto Overseer",
  argvSpec: {
    binary: "junto",
    prefix: ["overseer-host"],
    promptMode: "none",
    modelFlag: "--model",
    systemPromptFlag: "--instructions",
    resumeReinjection: "re-pass",
  },
  envSpec: SHARED_ENV_SPEC,
  injectionSpec: { tier: "A", flags: ["--instructions"], description: "App-owned structured run instructions" },
  capabilityBadges: {
    instructionInjection: "A", hooks: false, effortAtSpawn: false,
    sessionId: "unavailable", remote: false, requiresGitCwd: false,
    stateFeed: "correlated run events", attentionSource: "structured run events",
    labels: ["live conversation", "correlated tools", "cancellation"],
  },
  mailTransport: HARNESS_MAIL_TRANSPORT["vellum-overseer"],
  isolation: HARNESS_ISOLATION["vellum-overseer"],
  efforts: [],
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
  fx: FX_TEMPLATE,
  omp: OMP_TEMPLATE,
  "vellum-overseer": JUNTO_OVERSEER_TEMPLATE,
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
