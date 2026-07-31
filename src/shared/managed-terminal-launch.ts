/**
 * Resolve a managed-terminal template + picker choices into a TerminalLaunch
 * for LocalSessionHost. Pure argv/env construction — no process spawn, no
 * harness config writes.
 *
 * Phase 6: optional `injection` context fills Tier-A system-prompt flags from
 * the shared doctrine builder. Tier-B first typed message is returned on the
 * plan (drive delivers after idle). Unconnected → nothing injected.
 */
import type { EtherTerminalLaunch } from "./canvas";
import {
  type InjectionContext,
  type ManagedInjectionPlan,
  planManagedInjection,
} from "./managed-terminal-injection";
import {
  type HarnessId,
  type ManagedTerminalTemplate,
  SPAWN_ENV_SCRUB,
  isHarnessId,
  templateFor,
} from "./managed-terminal-templates";

/** Alias matching runtime TerminalLaunch (document launch profile). */
export type TerminalLaunch = EtherTerminalLaunch;

// ── Picker input ───────────────────────────────────────────────────────────

/**
 * Progressive-specificity picker choices. Any level may be omitted — defaults
 * below that level apply (click Codex → spawn with defaults).
 */
export type ManagedLaunchChoices = {
  readonly model?: string;
  readonly effort?: string;
  /** Hermes profile name. */
  readonly profile?: string;
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
   * Seat connection + context slots. When set:
   * - connected=false → no Tier-A flags from injection (unconnected silence)
   * - connected=true + tier A → systemPrompt filled from doctrine builder
   * - connected=true + tier B → firstTypedMessage on the resolved plan
   */
  readonly injection?: InjectionContext;
  /** Working directory. Grok requires a git work tree. */
  readonly cwd?: string;
  /**
   * Extra env (seat/socket/token/PATH prefix). Merged after scrub; never used
   * to re-introduce scrubbed Claude child-session keys.
   */
  readonly env?: Readonly<Record<string, string>>;
};

// ── Env scrub ──────────────────────────────────────────────────────────────

/**
 * Strip ambient Claude nested-session markers so a Vellum Command launched from inside
 * Claude does not disable the child's transcript / resume.
 */
export const scrubSpawnEnv = (
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if ((SPAWN_ENV_SCRUB as readonly string[]).includes(key)) continue;
    out[key] = value;
  }
  return out;
};

/**
 * Merge ambient + host inject, scrub nested-session traps, then re-apply
 * deliberate inject (inject still cannot reintroduce scrubbed keys).
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

const buildArgv = (
  template: ManagedTerminalTemplate,
  choices: ManagedLaunchChoices,
): string[] => {
  const { argvSpec: spec } = template;
  const argv: string[] = [spec.binary];

  // Codex resume is a subcommand: `codex resume <id> …flags… [prompt]`
  // Re-pass every flag — resume does not inherit spawn options.
  if (choices.resumeId && spec.resumeMode === "subcommand") {
    argv.push("resume", choices.resumeId);
  } else {
    argv.push(...spec.prefix);
    if (choices.resumeId && spec.resumeMode === "flag" && spec.resumeFlag) {
      argv.push(spec.resumeFlag, choices.resumeId);
    }
  }

  if (choices.profile) {
    pushFlag(argv, spec.profileFlag, choices.profile);
  }

  if (choices.model) {
    pushFlag(argv, spec.modelFlag, choices.model);
  }

  if (choices.effort) {
    if (spec.effortConfigKey) {
      // Codex: -c model_reasoning_effort="low"
      argv.push("-c", `${spec.effortConfigKey}=${JSON.stringify(choices.effort)}`);
    } else {
      pushFlag(argv, spec.effortFlag, choices.effort);
    }
  }

  // Permission / approval. Hermes --yolo is bare when enabled.
  const permission =
    choices.permissionMode ?? template.defaultPermissionMode;
  if (permission !== undefined) {
    if (spec.permissionModeFlag === "--yolo") {
      if (
        permission === "yolo" ||
        permission === "true" ||
        permission === "1" ||
        permission === "--yolo"
      ) {
        argv.push("--yolo");
      }
      // "off"/false/default → omit
    } else {
      pushFlag(argv, spec.permissionModeFlag, permission);
    }
  }

  if (choices.sessionId && spec.sessionIdFlag) {
    pushFlag(argv, spec.sessionIdFlag, choices.sessionId);
  }

  // Tier-A injection. Grok prefers --agent file when provided.
  if (choices.agentFile && spec.agentFlag) {
    pushFlag(argv, spec.agentFlag, choices.agentFile);
  } else if (choices.systemPrompt && spec.systemPromptFlag) {
    pushFlag(argv, spec.systemPromptFlag, choices.systemPrompt);
  }

  // Prompt last (positional) or as -q for Hermes TUI auto-submit.
  if (choices.prompt) {
    if (spec.promptMode === "flag-q") {
      argv.push("-q", choices.prompt);
    } else {
      argv.push(choices.prompt);
    }
  }

  return argv;
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
      ...rest
    } = choices;
    return { choices: rest, plan };
  }
  if (!plan.systemPrompt) {
    // Tier B: firstTypedMessage on plan; no spawn system-prompt flags.
    return { choices, plan };
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
  const env = buildSpawnEnv(ambientEnv, merged.env);

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
