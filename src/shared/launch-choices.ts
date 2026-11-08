/**
 * Picker choices recovered from a harness seat's launch argv.
 *
 * Launch argv is the document's single representation of the picker's
 * choices (model, effort, mode, permission, Hermes profile and provider).
 * Spawn reads them back to replan a launch; profiles and squads read them to
 * capture a seat as reusable configuration.
 */
import type { HarnessParamSpec } from "./harness-domain";
import { HARNESS_RECORDS } from "./harness-records";
import { argvWithoutExtraArgs } from "./launch-extra-args";
import type { ManagedLaunchChoices } from "./managed-terminal-launch";
import type { HarnessId } from "./managed-terminal-templates";
import type { TerminalLaunch } from "./terminal";

export type RecoveredLaunchChoices = Pick<
  ManagedLaunchChoices,
  | "model"
  | "effort"
  | "mode"
  | "permissionMode"
  | "profile"
  | "provider"
  | "extraArgs"
>;

const valueForFlag = (
  argv: ReadonlyArray<string>,
  flag: string | undefined,
  aliases: readonly string[] = [],
): string | undefined => {
  if (!flag) return undefined;
  const names = [flag, ...aliases];
  for (let i = argv.length - 1; i >= 0; i -= 1) {
    const token = argv[i];
    if (names.includes(token)) {
      const value = argv[i + 1]?.trim();
      if (value && value.length > 0) return value;
      continue;
    }
    for (const name of names) {
      const inline = `${name}=`;
      if (token.startsWith(inline)) {
        const value = token.slice(inline.length).trim();
        if (value.length > 0) return value;
      }
    }
  }
  return undefined;
};

const parseEffortConfig = (argvValue: string | undefined, key: string): string | undefined => {
  if (!argvValue) return undefined;
  const match = argvValue.match(new RegExp(`^${key}=(?:\"([^\"]+)\"|(.+))$`));
  return match?.[1] ?? match?.[2] ?? undefined;
};

/**
 * Recover durable picker selections from the authorial harness argv.
 *
 * Launch argv is the document's single representation of picker choices; this
 * deliberately reads only template-owned flags, then lets the current session
 * and edge-aware injection be rebuilt by resolveManagedLaunchPlan.
 */
export const recoverDocumentLaunchChoices = (
  harness: HarnessId,
  launch: TerminalLaunch | undefined,
): RecoveredLaunchChoices => {
  if (launch?.kind !== "harness" || !launch.argv) return {};
  const extraArgs = launch.extraArgs ?? [];
  return {
    ...recoverTemplateChoices(
      harness,
      // Template flags are read from the part of the launch the template
      // wrote; the operator's own arguments travel separately, verbatim.
      argvWithoutExtraArgs(launch.argv, extraArgs),
      launch.env,
    ),
    ...(extraArgs.length > 0 ? { extraArgs } : {}),
  };
};

/** Does `argv` hold `tokens` back to back? */
const holdsRun = (argv: ReadonlyArray<string>, tokens: readonly string[]): boolean =>
  argv.some((_, at) => tokens.every((token, offset) => argv[at + offset] === token));

/**
 * The value a param emitted, read back from argv and env. The inverse of the
 * launch's emission: a switch is its flag's presence, a per-value param is
 * the longest token run it finds (an empty run, Cursor allowlist, is the same
 * launch as unset), and an effort inside a model slug stays in the model.
 */
const recoverParam = (
  param: HarnessParamSpec,
  argv: ReadonlyArray<string>,
  env: Readonly<Record<string, string>> | undefined,
): string | undefined => {
  const emit = param.emit;
  switch (emit.via) {
    case "flag":
      return valueForFlag(argv, emit.flag, param.aliases ?? []);
    case "switch":
      return argv.includes(emit.flag) ? emit.value : undefined;
    case "configKey":
      return parseEffortConfig(valueForFlag(argv, "-c"), emit.key);
    case "env":
      return env?.[emit.key]?.trim() || undefined;
    case "perValue": {
      const found = Object.entries(emit.argv)
        .filter(([, tokens]) => tokens.length > 0 && holdsRun(argv, tokens))
        .sort(([, a], [, b]) => b.length - a.length);
      return found[0]?.[0];
    }
    case "modelSlug":
    case "args":
      return undefined;
  }
};

const recoverTemplateChoices = (
  harness: HarnessId,
  argv: ReadonlyArray<string>,
  env: Readonly<Record<string, string>> | undefined,
): Omit<RecoveredLaunchChoices, "extraArgs"> => {
  const recovered: Record<string, string> = {};
  for (const param of HARNESS_RECORDS[harness].params.params) {
    if (param.key === "extraArgs") continue;
    const value = recoverParam(param, argv, env);
    if (value) recovered[param.key] = value;
  }
  return recovered;
};
