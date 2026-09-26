/**
 * Picker choices recovered from a harness seat's launch argv.
 *
 * Launch argv is the document's single representation of the picker's
 * choices (model, effort, mode, permission, Hermes profile and provider).
 * Spawn reads them back to replan a launch; profiles and squads read them to
 * capture a seat as reusable configuration.
 */
import type { ManagedLaunchChoices } from "./managed-terminal-launch";
import { templateFor, type HarnessId } from "./managed-terminal-templates";
import type { TerminalLaunch } from "./terminal";

export type RecoveredLaunchChoices = Pick<
  ManagedLaunchChoices,
  "model" | "effort" | "mode" | "permissionMode" | "profile" | "provider"
>;

const valueForFlag = (
  argv: ReadonlyArray<string>,
  flag: string | undefined,
): string | undefined => {
  if (!flag) return undefined;
  for (let i = argv.length - 1; i >= 0; i -= 1) {
    const token = argv[i];
    if (token === flag) {
      const value = argv[i + 1]?.trim();
      if (value && value.length > 0) return value;
      continue;
    }
    const inline = `${flag}=`;
    if (token.startsWith(inline)) {
      const value = token.slice(inline.length).trim();
      if (value.length > 0) return value;
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

  const argv = launch.argv;
  const spec = templateFor(harness).argvSpec;

  const effort = spec.effortConfigKey
    ? parseEffortConfig(valueForFlag(argv, spec.effortFlag), spec.effortConfigKey)
    : valueForFlag(argv, spec.effortFlag);

  const permissionMode = spec.permissionModeFlag === "--yolo"
    ? (argv.includes("--yolo") ? "yolo" : undefined)
    : valueForFlag(argv, spec.permissionModeFlag);

  // Named agent mode (Amp `-m`). Recovered like every other template-owned
  // flag so a wake or restart relaunches the seat in the mode it was created
  // with, rather than silently dropping back to the harness default.
  const mode = valueForFlag(argv, spec.modeFlag);

  switch (harness) {
    case "claude":
      return {
        ...(valueForFlag(argv, spec.modelFlag) ? { model: valueForFlag(argv, spec.modelFlag) } : {}),
        ...(effort ? { effort } : {}),
        ...(permissionMode ? { permissionMode } : {}),
      };
    case "codex": {
      const effortArg = valueForFlag(argv, "-c");
      const codexEffort = effortArg
        ? parseEffortConfig(effortArg, spec.effortConfigKey ?? "model_reasoning_effort")
        : undefined;
      return {
        ...(valueForFlag(argv, spec.modelFlag) ? { model: valueForFlag(argv, spec.modelFlag) } : {}),
        ...(codexEffort ? { effort: codexEffort } : {}),
        ...(permissionMode ? { permissionMode } : {}),
      };
    }
    case "grok":
      return {
        ...(valueForFlag(argv, spec.modelFlag) ? { model: valueForFlag(argv, spec.modelFlag) } : {}),
        ...(effort
          ? { effort }
          : {}),
        ...(permissionMode ? { permissionMode } : {}),
      };
    case "hermes":
      // Provider is recovered next to the model on purpose: a Hermes resume
      // that carries one without the other reverts the model silently, and the
      // only place the revert shows is a session_model_usage row.
      return {
        ...(valueForFlag(argv, spec.profileFlag)
          ? { profile: valueForFlag(argv, spec.profileFlag) }
          : {}),
        ...(valueForFlag(argv, spec.modelFlag) ? { model: valueForFlag(argv, spec.modelFlag) } : {}),
        ...(valueForFlag(argv, spec.providerFlag)
          ? { provider: valueForFlag(argv, spec.providerFlag) }
          : {}),
        ...(permissionMode ? { permissionMode } : {}),
      };
    // pi / prime-agent / kimi / muse / devin: generic template slots
    // (model/effort/permission from the template's own flags; no profile).
    default:
      return {
        ...(valueForFlag(argv, spec.modelFlag) ? { model: valueForFlag(argv, spec.modelFlag) } : {}),
        ...(effort ? { effort } : {}),
        ...(mode ? { mode } : {}),
        ...(permissionMode ? { permissionMode } : {}),
      };
  }
};
