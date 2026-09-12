/**
 * Resolve a managed-terminal template + picker choices into a TerminalLaunch
 * for LocalSessionHost. Pure argv/env construction — no process spawn, no
 * harness config writes. Prime Agent's per-binding daemon socket is main-runtime
 * daemon state and is deliberately absent from this authorial resolver.
 *
 * Phase 6: optional `injection` context fills Tier-A system-prompt flags from
 * the shared doctrine builder. Tier-B first typed message is returned on the
 * plan (drive delivers after idle). Unconnected → nothing injected.
 */
import type { EtherTerminalLaunch } from "./canvas";
import {
  type InjectionContext,
  type ManagedInjectionPlan,
  buildOrientNotice,
  planManagedInjection,
} from "./managed-terminal-injection";
import {
  type HarnessId,
  type ManagedTerminalTemplate,
  SPAWN_ENV_SCRUB,
  SPAWN_ENV_SCRUB_PREFIXES,
  isHarnessId,
  isSandboxGatedPermissionMode,
  reinjectableOnResume,
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
  readonly injection: InjectionContext;
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
  /** Optional first-turn / auto-submit prompt. */
  readonly prompt?: string;
  /** Pin session id (Claude/Grok). Ignored on capture-only harnesses. */
  readonly sessionId?: string;
  /** Resume an existing session (re-passes model/effort/permission flags). */
  readonly resumeId?: string;
  readonly permissionMode?: string;
  /**
   * Tier-A injection body. Claude → `--append-system-prompt`; Grok → `--rules`
   * when `agentFile` is unset.
   * Prefer `injection` context (Phase 6) so doctrine is the single source of truth.
   * When both are set and injection.connected, `injection` wins for Tier A.
   */
  readonly systemPrompt?: string;
  /** Grok `--agent <file>` (takes precedence over systemPrompt for injection). */
  readonly agentFile?: string;
  /**
   * Tier-A rules DIRECTORY for `argvSpec.rulesDirFlag` (Antigravity
   * `--add-dir`). The caller owns the directory and its `AGENTS.md`; this
   * resolver only mounts it. Main-side `planManagedSpawn` fills it — the
   * directory must exist on the spawning host, so the renderer never sets it.
   */
  readonly rulesDir?: string;
  /**
   * Seat connection + context slots. When set:
   * - connected=false → no Tier-A flags from injection (unconnected silence)
   * - connected=true + tier A → systemPrompt filled from doctrine builder
   * - connected=true + tier B → firstTypedMessage on the resolved plan
   */
  readonly injection?: InjectionContext;
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
 * Vellum Command launch boundary.
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
 * inventing one here would be Vellum Command choosing a model, or a permission
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
 * Id-less "continue last session" flags. Not a Vellum Command feature.
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
 * knowing whose it is. Vellum Command never emits a bare `-r` — argv carries a
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

  // Tier-A injection. Grok prefers --agent file when provided.
  //
  // On a resume the carriers ride only where the harness honors them
  // (`resumeReinjection`). Codex ignores re-passed instructions on an existing
  // thread and Kimi refuses `--agent-file` alongside `--session` outright
  // (0.34.0 exits 1: "Cannot combine --agent/--agent-file with
  // --session/--continue"), so emitting the flag there is either a lie about
  // what the seat was told or an argv the harness rejects. Those harnesses
  // keep the doctrine they were given at creation; the injection supervisor
  // re-orients them by notice instead.
  const injectionCarriersAllowed =
    !resumeId || reinjectableOnResume(template);
  if (injectionCarriersAllowed) {
    let emittedInjectionCarrier = false;
    if (choices.agentFile && spec.agentFlag) {
      pushFlag(argv, spec.agentFlag, choices.agentFile);
      emittedInjectionCarrier = true;
    } else if (choices.systemPrompt && spec.systemPromptFlag) {
      pushFlag(argv, spec.systemPromptFlag, choices.systemPrompt);
      emittedInjectionCarrier = true;
    }
    // Rules DIRECTORY carrier (agy `--add-dir`). Independent of the two
    // string carriers above: the harness that mounts a dir has no
    // system-prompt flag at all, so this is not an "else" branch of them.
    if (choices.rulesDir && spec.rulesDirFlag) {
      pushFlag(argv, spec.rulesDirFlag, choices.rulesDir);
      emittedInjectionCarrier = true;
    }
    // Claude 2.1.267+ records `--append-system-prompt` on the first request
    // and reuses that record on resume unless snapshot is turned off.
    if (
      resumeId &&
      emittedInjectionCarrier &&
      spec.resumeReinjectionArgv &&
      spec.resumeReinjectionArgv.length > 0
    ) {
      argv.push(...spec.resumeReinjectionArgv);
    }
  }

  // Prompt last (positional, with optional separator), as -q for Hermes TUI
  // auto-submit, as -i for Antigravity auto-submit, or not at all when the harness
  // has no argv prompt slot (kimi — the drive delivers Tier-B first-typed messages instead).
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
 * Merge injection plan into launch choices for argv construction.
 * Tier A connected → systemPrompt from doctrine (unless agentFile already set).
 * Explicit systemPrompt without injection still works (tests / overrides).
 */
const applyInjectionChoices = (
  harness: HarnessId,
  choices: ManagedLaunchChoices,
): {
  readonly choices: ManagedLaunchChoices;
  readonly plan: ManagedInjectionPlan;
} => {
  if (!choices.injection) {
    // No seat context — treat as unconnected for plan metadata; leave argv as-is
    // (caller may still pass systemPrompt/agentFile manually).
    return {
      choices,
      plan: {
        inject: false,
        tier: templateFor(harness).injectionSpec.tier,
      },
    };
  }
  const plan = planManagedInjection(harness, choices.injection);
  if (!plan.inject) {
    // Unconnected silence: strip Tier-A flag carriers even if caller passed them.
    const {
      systemPrompt: _sp,
      agentFile: _af,
      rulesDir: _rd,
      ...rest
    } = choices;
    return { choices: rest, plan };
  }
  if (!plan.systemPrompt) {
    // Tier B: prefer argv prompt when the harness auto-submits it
    // (Devin `devin -- <prompt>`, Hermes `-q`). Otherwise firstTyped paste.
    // Avoids the stuck "[Pasted text …]" chip when paste+CR races the TUI.
    const template = templateFor(harness);
    const mode = template.argvSpec.promptMode;
    const body = plan.firstTypedMessage?.trim();
    if (
      body &&
      (mode === "positional" || mode === "flag-q" || mode === "flag-i") &&
      !choices.prompt?.trim()
    ) {
      return {
        choices: { ...choices, prompt: body },
        plan: {
          inject: true,
          tier: plan.tier,
          // No firstTyped — body rides argv and auto-submits at spawn.
        },
      };
    }
    // promptMode none (Amp, fx): never firstTyped-paste the full doctrine.
    // Those TUIs have no argv prompt slot; a multiline paste is the chip
    // hole. One-line onboard pointer — live map is `vellum-command onboard`.
    if (body && mode === "none") {
      return {
        choices,
        plan: {
          inject: true,
          tier: plan.tier,
          firstTypedMessage: buildOrientNotice(choices.injection.seatRef),
        },
      };
    }
    return { choices, plan };
  }
  // Tier A whose ONLY carrier is an agent FILE (kimi `--agent-file`): the file
  // has to exist on the spawning host, so a caller with no filesystem — or a
  // failed write — leaves the seat with no carrier at all. Kimi has no argv
  // prompt slot, so the fallback is the typed first message: Tier B, exactly
  // what this harness did before the file carrier existed.
  const agentFileTemplate = templateFor(harness);
  if (
    agentFileTemplate.argvSpec.agentFlag &&
    !agentFileTemplate.argvSpec.systemPromptFlag &&
    !agentFileTemplate.argvSpec.rulesDirFlag &&
    !choices.agentFile
  ) {
    const body = plan.systemPrompt.trim();
    const mode = agentFileTemplate.argvSpec.promptMode;
    if (
      body &&
      (mode === "positional" || mode === "flag-q" || mode === "flag-i") &&
      !choices.prompt?.trim()
    ) {
      return {
        choices: { ...choices, prompt: body },
        plan: { inject: true, tier: plan.tier },
      };
    }
    return {
      choices,
      plan: { inject: true, tier: plan.tier, firstTypedMessage: body },
    };
  }
  // Tier A whose ONLY carrier is a rules directory (agy `--add-dir`): the
  // directory has to exist on the spawning host, so a caller with no
  // filesystem — or a failed write — leaves the seat with no carrier at all.
  // Fall back to typed delivery rather than launching an un-briefed seat.
  const rulesDirTemplate = templateFor(harness);
  if (
    rulesDirTemplate.argvSpec.rulesDirFlag &&
    !rulesDirTemplate.argvSpec.systemPromptFlag &&
    !choices.rulesDir
  ) {
    const body = plan.systemPrompt.trim();
    const mode = rulesDirTemplate.argvSpec.promptMode;
    if (
      body &&
      (mode === "positional" || mode === "flag-q" || mode === "flag-i") &&
      !choices.prompt?.trim()
    ) {
      return {
        choices: { ...choices, prompt: body },
        plan: { inject: true, tier: plan.tier },
      };
    }
    return {
      choices,
      plan: { inject: true, tier: plan.tier, firstTypedMessage: body },
    };
  }
  // Tier A connected: doctrine is SoT for systemPrompt unless agentFile wins.
  if (choices.agentFile) {
    return { choices, plan };
  }
  return {
    choices: { ...choices, systemPrompt: plan.systemPrompt },
    plan,
  };
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

export type ManagedLaunchPlan = {
  readonly launch: TerminalLaunch;
  /** Injection disposition (Tier A flags already applied to launch.argv when inject). */
  readonly injection: ManagedInjectionPlan;
  /**
   * Tier B: same doctrine text for ManagedTerminalDrive.writePrompt after idle.
   * Undefined when unconnected or Tier A (already on argv as system prompt flag).
   */
  readonly firstTypedMessage?: string;
};

/**
 * Full resolve: TerminalLaunch + injection plan for Tier-B drive delivery.
 * Prefer this over resolveManagedLaunch when the caller owns first-message typing.
 */
export const resolveManagedLaunchPlan = (
  harnessOrTemplate: HarnessId | ManagedTerminalTemplate,
  choices: ManagedLaunchChoices = {},
  ambientEnv: Readonly<Record<string, string | undefined>> = process.env,
): ManagedLaunchPlan => {
  const template = resolveTemplate(harnessOrTemplate);
  const { choices: merged, plan } = applyInjectionChoices(template.harness, choices);
  const argv = buildArgv(template, merged);
  // Dials go on AFTER the scrub, and deliberately so. The scrub exists to kill
  // the value a nested seat would INHERIT (an fx seat launched from inside an
  // fx session); the value the picker chose for this seat is the opposite of
  // that — it is the answer the scrub is clearing the way for.
  const env = {
    ...buildSpawnEnv(ambientEnv, merged.env),
    ...envDials(template, merged),
  };

  const launch: TerminalLaunch = {
    kind: "harness",
    argv,
    ...(merged.cwd ? { cwd: merged.cwd } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
  };

  return {
    launch,
    injection: plan,
    ...(plan.firstTypedMessage
      ? { firstTypedMessage: plan.firstTypedMessage }
      : {}),
  };
};
