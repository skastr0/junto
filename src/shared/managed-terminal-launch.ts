/**
 * Resolve a managed-terminal template + picker choices into a TerminalLaunch
 * for LocalSessionHost. Pure argv/env construction — no process spawn, no
 * harness config writes. Prime Agent's per-binding daemon socket is main-runtime
 * daemon state and is deliberately absent from this authorial resolver.
 *
 * Nothing here carries Junto instructions. A seat opens to the harness's own
 * empty composer; the agent learns about Junto by running `junto onboard`.
 * The only prompt a launch can carry is one the operator supplied.
 */
import type { EtherTerminalLaunch } from "./canvas";
import { sanitizeExtraArgs } from "./launch-extra-args";
import {
  type HarnessId,
  type ManagedTerminalTemplate,
  SPAWN_ENV_SCRUB,
  SPAWN_ENV_SCRUB_PREFIXES,
  isHarnessId,
  isSandboxGatedPermissionMode,
  templateFor,
} from "./managed-terminal-templates";

/** Alias matching runtime TerminalLaunch (document launch profile). */
export type TerminalLaunch = EtherTerminalLaunch;

/**
 * Pure authorial spawn intent. The selected process host finalizes this into a
 * launch only after consulting its own harness-session filesystem.
 */
export type ManagedSpawnIntent = {
  readonly documentLaunch?: TerminalLaunch;
  readonly sessionId?: string;
  /** Request only. The selected spawn host decides whether proof exists. */
  readonly resumeRequested: boolean;
  readonly profile?: string;
  /** Hermes provider — re-passed with the model on every cold wake. */
  readonly provider?: string;
  readonly model?: string;
  readonly effort?: string;
  /** Named agent mode (Amp `-m`), compiled the same way as model/effort. */
  readonly mode?: string;
  readonly permissionMode?: string;
  readonly cwd?: string;
};

// ── Picker input ───────────────────────────────────────────────────────────

/**
 * Progressive-specificity picker choices. Any level may be omitted — defaults
 * below that level apply (click Codex → spawn with defaults).
 */
export type ManagedLaunchChoices = {
  readonly model?: string;
  readonly effort?: string;
  /** Named agent mode for `argvSpec.modeFlag` (Amp low|medium|high|ultra). */
  readonly mode?: string;
  /** Hermes profile name. */
  readonly profile?: string;
  /**
   * Provider for `argvSpec.providerFlag` (Hermes `--provider`). Travels with
   * the model: a resume that re-passes one without the other reverts the model
   * silently, so both are recovered and re-emitted together.
   */
  readonly provider?: string;
  /**
   * Operator-supplied initial prompt. Never filled by Junto: a launch carries
   * a prompt only when the operator wrote one.
   */
  readonly prompt?: string;
  /** Pin session id (Claude/Grok). Ignored on capture-only harnesses. */
  readonly sessionId?: string;
  /** Resume an existing session (re-passes model/effort/permission flags). */
  readonly resumeId?: string;
  readonly permissionMode?: string;
  /**
   * Operator-authored arguments appended after every template-owned flag.
   * Sanitized against the template's reserved flags at build time.
   */
  readonly extraArgs?: readonly string[];
  /** Working directory. Grok requires a git work tree. */
  readonly cwd?: string;
  /**
   * Extra env (seat/socket/token/PATH prefix). Merged after scrub; exact and
   * prefix-reserved harness markers cannot be reintroduced here.
   */
  readonly env?: Readonly<Record<string, string>>;
};

// ── Env scrub ──────────────────────────────────────────────────────────────

const shouldScrubSpawnEnvKey = (key: string): boolean =>
  (SPAWN_ENV_SCRUB as readonly string[]).includes(key) ||
  SPAWN_ENV_SCRUB_PREFIXES.some((prefix) => key.startsWith(prefix));

/**
 * Strip ambient nested-session and internal-role markers before a managed
 * spawn. In particular, every PRIME_AGENT_INTERNAL_* key is reserved to the
 * stock Prime Agent runtime; no current or future internal role may cross the
 * Junto launch boundary.
 */
export const scrubSpawnEnv = (
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (shouldScrubSpawnEnvKey(key)) continue;
    out[key] = value;
  }
  return out;
};

/**
 * Merge ambient + host inject, scrub nested-session traps, then re-apply
 * deliberate inject (inject still cannot reintroduce exact or prefix keys).
 */
export const buildSpawnEnv = (
  ambient: Readonly<Record<string, string | undefined>>,
  inject: Readonly<Record<string, string>> | undefined,
): Record<string, string> => {
  const scrubbed = scrubSpawnEnv(ambient);
  if (!inject) return scrubbed;
  const cleanedInject = scrubSpawnEnv(inject);
  return { ...scrubbed, ...cleanedInject };
};

// ── Argv construction ──────────────────────────────────────────────────────

/**
 * Spawn dials a harness reads from the environment rather than argv (fx).
 *
 * Emitted last, over the ambient value, so a seat launched from inside another
 * session runs on the dials the operator picked for IT. A dial the picker left
 * unset is omitted entirely — the harness's own default is a real answer, and
 * inventing one here would be Junto choosing a model, or a permission
 * mode that spends money, on the operator's behalf.
 */
const envDials = (
  template: ManagedTerminalTemplate,
  choices: ManagedLaunchChoices,
): Record<string, string> => {
  const { argvSpec: spec } = template;
  const dials: Record<string, string> = {};
  const model = choices.model?.trim();
  if (spec.modelEnvKey && model) dials[spec.modelEnvKey] = model;
  const permissionMode = choices.permissionMode?.trim();
  if (spec.permissionModeEnvKey && permissionMode) {
    dials[spec.permissionModeEnvKey] = permissionMode;
  }
  return dials;
};

/**
 * Id-less "continue last session" flags. Not a Junto feature.
 * `-c` is in this set only as a *resume* flag (Claude/Kimi/Devin continue).
 * Codex still uses `-c` for config keys — that is not resume.
 */
const IDLESS_SESSION_CONTINUE_FLAGS: ReadonlySet<string> = new Set([
  "--continue",
  "-c",
]);

/**
 * Flags that resume "whatever ran last" instead of a named session.
 *
 * fx adds `--resume-last` to this family, and `--resume` with no id (handled
 * positionally below) means the same thing.
 *
 * NOT `-r`: it is fx's saved-session picker but the NAMED resume flag for
 * hermes, prime-agent, devin, grok and pi, and this guard sees argv without
 * knowing whose it is. Junto never emits a bare `-r` — argv carries a
 * resume flag only with an id attached — so banning it here would only break
 * the harnesses that use it properly.
 */
export const isIdlessSessionContinueFlag = (token: string): boolean =>
  token === "--continue" || token === "--resume-last";

/** Non-empty session id that is not another flag. */
export const namedHarnessSessionId = (
  value: string | undefined,
): string | undefined => {
  const id = value?.trim();
  if (!id || id.startsWith("-")) return undefined;
  return id;
};

/** Drop `--continue` so a hand-authored argv cannot mean "resume latest". */
export const stripIdlessSessionContinue = (
  argv: readonly string[],
): string[] => {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (isIdlessSessionContinueFlag(token)) continue;
    // `--resume last` and a trailing bare `--resume` both mean "the latest
    // workspace session" (fx). Only `--resume <id>` survives.
    if (token === "--resume") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-") || next === "last") {
        if (next === "last") i += 1;
        continue;
      }
    }
    out.push(token);
  }
  return out;
};

const pushFlag = (
  argv: string[],
  flag: string | undefined,
  value: string | undefined,
): void => {
  if (!flag || value === undefined || value === "") return;
  // Boolean-ish flags (Hermes --yolo): emit bare flag when value is "true"/"1"/flag name.
  if (
    value === "true" ||
    value === "1" ||
    value === flag ||
    value === flag.replace(/^--?/, "")
  ) {
    argv.push(flag);
    return;
  }
  argv.push(flag, value);
};

/**
 * Merge one `key=value` option into a model's bracket group, the way Cursor
 * help still writes it: `claude-opus-4-8[context=1m,effort=high]`.
 *
 * A model that already names the key keeps its position and takes the new
 * value; a model with other options gains one entry; a bare model gains the
 * whole group. Exported because this is a harness syntax fact worth testing on
 * its own. Cursor 2026.09.10-fd3934a rejects `effort=` brackets on catalog
 * ids — spawn uses `withModelEffortSlug` instead. Non-effort brackets such as
 * `composer-2.5[fast=false]` still go through this helper when a caller
 * asks for them.
 */
export const withModelBracketOption = (
  model: string,
  key: string,
  value: string,
): string => {
  const trimmed = model.trim();
  const entry = `${key}=${value}`;
  const open = trimmed.indexOf("[");
  if (open < 0 || !trimmed.endsWith("]")) return `${trimmed}[${entry}]`;
  const base = trimmed.slice(0, open);
  const inner = trimmed.slice(open + 1, -1);
  const parts = inner
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const at = parts.findIndex((part) => part.split("=")[0]?.trim() === key);
  if (at >= 0) parts[at] = entry;
  else parts.push(entry);
  return `${base}[${parts.join(",")}]`;
};

/**
 * Catalog suffixes `agent models` enumerates on 2026.09.10-fd3934a.
 * Longest-first so `xhigh` / `extra-high` are not eaten as `high`.
 * `-fast` is a variant after the effort token, not an effort itself.
 */
const MODEL_EFFORT_SUFFIX_RE =
  /-(extra-high|xhigh|medium|minimal|high|low|none|max)(-fast)?$/;

/**
 * Attach a picker effort to a Cursor catalog id as a hyphenated slug
 * (`claude-opus-4-8` + `high` → `claude-opus-4-8-high`).
 *
 * Live 2026.09.10-fd3934a rejects `[effort=…]` on catalog ids
 * (`Cannot use this model`) and also rejects a hyphenated slug that then
 * grows an effort bracket. Existing non-effort brackets stay on the model
 * (`composer-2.5[fast=false]`). A trailing effort token (and optional
 * `-fast`) is replaced rather than stacked.
 */
export const withModelEffortSlug = (model: string, effort: string): string => {
  const trimmed = model.trim();
  const slug = effort.trim();
  if (!slug) return trimmed;

  const open = trimmed.indexOf("[");
  const hasBrackets = open >= 0 && trimmed.endsWith("]");
  const rawBase = hasBrackets ? trimmed.slice(0, open) : trimmed;
  let brackets = hasBrackets ? trimmed.slice(open) : "";
  if (brackets) {
    const inner = brackets.slice(1, -1);
    const parts = inner
      .split(",")
      .map((part) => part.trim())
      .filter((part) => {
        if (part.length === 0) return false;
        return part.split("=")[0]?.trim() !== "effort";
      });
    brackets = parts.length > 0 ? `[${parts.join(",")}]` : "";
  }

  const match = rawBase.match(MODEL_EFFORT_SUFFIX_RE);
  const nextBase = match
    ? `${rawBase.slice(0, match.index)}-${slug}${match[2] ?? ""}`
    : rawBase.endsWith(`-${slug}`) || rawBase === slug
      ? rawBase
      : `${rawBase}-${slug}`;
  return `${nextBase}${brackets}`;
};

const buildArgv = (
  template: ManagedTerminalTemplate,
  choices: ManagedLaunchChoices,
): string[] => {
  const { argvSpec: spec } = template;
  const argv: string[] = [spec.binary];
  const resumeId = namedHarnessSessionId(choices.resumeId);
  const resumeFlag = spec.resumeFlag?.trim();
  const namedResumeFlag =
    resumeFlag && !IDLESS_SESSION_CONTINUE_FLAGS.has(resumeFlag)
      ? resumeFlag
      : undefined;

  // Subcommand resume re-passes every flag — resume does not inherit spawn
  // options. Named id only, never `--continue` / bare resume / latest session.
  // The tokens are template data: `codex resume <id>`, `amp threads continue <id>`.
  if (resumeId && spec.resumeMode === "subcommand") {
    argv.push(...spec.prefix);
    argv.push(...(spec.resumeSubcommand ?? ["resume"]), resumeId);
  } else {
    argv.push(...spec.prefix);
    if (resumeId && spec.resumeMode === "flag" && namedResumeFlag) {
      argv.push(namedResumeFlag, resumeId);
    }
  }

  if (choices.profile) {
    pushFlag(argv, spec.profileFlag, choices.profile);
  }

  if (choices.provider) {
    pushFlag(argv, spec.providerFlag, choices.provider);
  }

  if (choices.model) {
    // Cursor carries effort inside the model value as a hyphenated catalog
    // slug (`claude-opus-4-8-high`), not `[effort=…]` — that form is rejected
    // on 2026.09.10-fd3934a. The two dials are resolved together.
    pushFlag(
      argv,
      spec.modelFlag,
      spec.effortModelBracketKey && choices.effort
        ? withModelEffortSlug(choices.model, choices.effort)
        : choices.model,
    );
  }

  if (choices.mode) {
    pushFlag(argv, spec.modeFlag, choices.mode);
  }

  if (choices.effort) {
    if (spec.effortModelBracketKey) {
      // Already merged into the model slug above. With no model selected the
      // suffix has nothing to attach to, so the effort is dropped rather than
      // invented onto a model the operator did not choose.
    } else if (spec.effortConfigKey) {
      // Codex: -c model_reasoning_effort="low"
      argv.push("-c", `${spec.effortConfigKey}=${JSON.stringify(choices.effort)}`);
    } else {
      pushFlag(argv, spec.effortFlag, choices.effort);
    }
  }

  // Permission / approval. Bare flags like --yolo or --dangerously-skip-permissions are emitted without value when enabled.
  const permission =
    choices.permissionMode ?? template.defaultPermissionMode;
  if (permission !== undefined) {
    if (
      spec.permissionModeFlag === "--yolo" ||
      spec.permissionModeFlag === "--dangerously-skip-permissions"
    ) {
      if (
        permission === "yolo" ||
        permission === "true" ||
        permission === "1" ||
        permission === spec.permissionModeFlag ||
        permission === "--yolo"
      ) {
        argv.push(spec.permissionModeFlag);
      }
      // "off"/false/default → omit
    } else {
      // Devin 3000.10.21: `Error: --permission-mode autonomous requires --sandbox`.
      // Pair the flags so a saved or hand-authored mode cannot produce a
      // spawn that dies at parse. Other modes stay unchanged.
      if (
        template.harness === "devin" &&
        isSandboxGatedPermissionMode(permission) &&
        !argv.includes("--sandbox")
      ) {
        argv.push("--sandbox");
      }
      pushFlag(argv, spec.permissionModeFlag, permission);
    }
  }

  if (choices.sessionId && spec.sessionIdFlag) {
    pushFlag(argv, spec.sessionIdFlag, choices.sessionId);
  }

  // The operator's own arguments: after everything the template owns, before
  // the prompt (a positional prompt must stay the last token).
  argv.push(...sanitizeExtraArgs(template.harness, choices.extraArgs).args);

  // Prompt last (positional, with optional separator), as -q for Hermes TUI
  // auto-submit, as -i for Antigravity auto-submit, or not at all when the
  // harness has no argv prompt slot (kimi, amp, fx).
  if (choices.prompt) {
    if (spec.promptMode === "flag-q") {
      argv.push("-q", choices.prompt);
    } else if (spec.promptMode === "flag-i") {
      argv.push("-i", choices.prompt);
    } else if (spec.promptMode === "positional") {
      if (spec.promptSeparator) argv.push(spec.promptSeparator);
      argv.push(choices.prompt);
    }
  }

  return stripIdlessSessionContinue(argv);
};

// ── Public resolve ─────────────────────────────────────────────────────────

export const resolveTemplate = (
  harnessOrTemplate: HarnessId | ManagedTerminalTemplate,
): ManagedTerminalTemplate => {
  if (typeof harnessOrTemplate === "string") {
    if (!isHarnessId(harnessOrTemplate)) {
      throw new Error(`unknown managed harness: ${harnessOrTemplate}`);
    }
    return templateFor(harnessOrTemplate);
  }
  return harnessOrTemplate;
};

/**
 * Turn template + picker choices into a TerminalLaunch compatible with
 * LocalSessionHost / EtherTerminalLaunch (`kind: "harness"`).
 */
export const resolveManagedLaunch = (
  harnessOrTemplate: HarnessId | ManagedTerminalTemplate,
  choices: ManagedLaunchChoices = {},
  ambientEnv: Readonly<Record<string, string | undefined>> = process.env,
): TerminalLaunch => resolveManagedLaunchPlan(harnessOrTemplate, choices, ambientEnv).launch;

/** A resolved launch. It holds argv, cwd and env, and nothing to type. */
export type ManagedLaunchPlan = {
  readonly launch: TerminalLaunch;
};

export const resolveManagedLaunchPlan = (
  harnessOrTemplate: HarnessId | ManagedTerminalTemplate,
  choices: ManagedLaunchChoices = {},
  ambientEnv: Readonly<Record<string, string | undefined>> = process.env,
): ManagedLaunchPlan => {
  const template = resolveTemplate(harnessOrTemplate);
  const argv = buildArgv(template, choices);
  // Dials go on AFTER the scrub, and deliberately so. The scrub exists to kill
  // the value a nested seat would INHERIT (an fx seat launched from inside an
  // fx session); the value the picker chose for this seat is the opposite of
  // that — it is the answer the scrub is clearing the way for.
  const env = {
    ...buildSpawnEnv(ambientEnv, choices.env),
    ...envDials(template, choices),
  };

  const launch: TerminalLaunch = {
    kind: "harness",
    argv,
    ...(choices.cwd ? { cwd: choices.cwd } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
  };

  return { launch };
};
