/**
 * Resolve a managed-terminal template + picker choices into a TerminalLaunch
 * for LocalSessionHost. Pure argv/env construction — no process spawn, no
 * harness config writes.
 */
import type { TerminalLaunch } from "@shared/terminal";
import {
  type HarnessId,
  type ManagedTerminalTemplate,
  SPAWN_ENV_SCRUB,
  isHarnessId,
  templateFor,
} from "@shared/managed-terminal-templates";

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
   */
  readonly systemPrompt?: string;
  /** Grok `--agent <file>` (takes precedence over systemPrompt for injection). */
  readonly agentFile?: string;
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
 * Strip ambient Claude nested-session markers so a Vellum launched from inside
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
 * Turn template + picker choices into a TerminalLaunch compatible with
 * LocalSessionHost / EtherTerminalLaunch (`kind: "harness"`).
 */
export const resolveManagedLaunch = (
  harnessOrTemplate: HarnessId | ManagedTerminalTemplate,
  choices: ManagedLaunchChoices = {},
  ambientEnv: Readonly<Record<string, string | undefined>> = process.env,
): TerminalLaunch => {
  const template = resolveTemplate(harnessOrTemplate);
  const argv = buildArgv(template, choices);
  const env = buildSpawnEnv(ambientEnv, choices.env);

  const launch: TerminalLaunch = {
    kind: "harness",
    argv,
    ...(choices.cwd ? { cwd: choices.cwd } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
  };
  return launch;
};
