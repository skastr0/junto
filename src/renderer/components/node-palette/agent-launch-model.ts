import type { HostsOpResult } from "@shared/ipc";
import { TERMINAL_HOST_CAPABILITY } from "@shared/remote-hosts";
import { HERMES_INTEGRATION_ENABLED } from "@shared/features";
import type { HarnessId } from "@shared/managed-terminal-templates";
import { paramSpec } from "@shared/harness-domain";
import { HARNESS_RECORDS } from "@shared/harness-records";
import { resolveHarnessLaunchDefaults } from "@shared/harness-settings";
import type { Settings } from "@shared/settings";

/** Palette / re-seat harness configuration (model, effort, hermes profile). */
export type AgentConfigurationChoices = {
  readonly harness: HarnessId;
  readonly profile?: string;
  readonly model?: string;
  readonly effort?: string;
  /** Named agent mode for harnesses whose one dial is a mode (Amp). */
  readonly mode?: string;
  readonly permissionMode?: string;
  /** Extra harness arguments beyond the dials. */
  readonly extraArgs?: readonly string[];
};

/**
 * Apply Settings → Agents defaults under cascade/explicit picks, for the
 * machine the seat is placed on (its override over the app-wide default).
 * Call at configure time so seats store the resolved launch prefs.
 */
export const withHarnessSettingsDefaults = (
  choices: AgentConfigurationChoices,
  settings: Settings | undefined,
  machine?: string,
): AgentConfigurationChoices => {
  const merged = resolveHarnessLaunchDefaults(settings, choices.harness, machine, {
    model: choices.model,
    effort: choices.effort,
    permissionMode: choices.permissionMode,
    extraArgs: choices.extraArgs,
  });
  return {
    ...choices,
    ...merged,
  };
};

export type AgentHostChoice = {
  readonly id: string;
  readonly agentHost: string;
  readonly label: string;
};

type EnrolledHost = NonNullable<HostsOpResult["hosts"]>[number];

const labelOf = (host: EnrolledHost): string => host.label.trim() || host.id;

/** The machines a new seat can be placed on: this machine first, the rest by label. */
export const actorHostChoicesFromEnrollment = (
  hosts: ReadonlyArray<EnrolledHost>,
  configured: AgentHostChoice,
): ReadonlyArray<AgentHostChoice> => {
  const seen = new Set<string>();
  const enrolled = hosts
    .filter((host) => {
      if (
        seen.has(host.id) ||
        !host.capabilities.includes(TERMINAL_HOST_CAPABILITY)
      ) {
        return false;
      }
      seen.add(host.id);
      return true;
    })
    .sort((left, right) => {
      if (left.isThisMachine !== right.isThisMachine) return left.isThisMachine ? -1 : 1;
      return labelOf(left).localeCompare(labelOf(right));
    })
    .map((host) => ({
      id: host.id,
      agentHost: HERMES_INTEGRATION_ENABLED
        ? host.hermesId ?? host.id
        : host.id,
      label: labelOf(host),
    }));
  return enrolled.some((host) => host.id === configured.id)
    ? enrolled
    : [configured, ...enrolled];
};

/**
 * What the cascade's first column offers for a harness.
 *
 * Three shapes, because harnesses genuinely differ: Hermes picks a profile
 * first, most harnesses pick a model, and a harness whose only dial is a named
 * mode (Amp `-m low|medium|high|ultra`, which selects model, system prompt,
 * and tools together) picks a mode. Naming the shape here — rather than
 * inferring it inside the menu — is what keeps a mode from being labelled or
 * committed as a model.
 */
export type CascadeFirstColumn =
  | { readonly kind: "profiles" }
  | { readonly kind: "models" }
  | { readonly kind: "modes"; readonly modes: readonly string[] };

export const firstCascadeColumn = (harness: HarnessId): CascadeFirstColumn => {
  const params = HARNESS_RECORDS[harness].params;
  if (paramSpec(params, "profile")) return { kind: "profiles" };
  const mode = paramSpec(params, "mode");
  const modes = mode?.options.source === "fixed" ? mode.options.values : [];
  // A mode that replaces the model (Amp) is the first column. A harness with
  // both (Cursor `--mode plan|ask`) keeps the model first.
  return modes.length > 0 && !paramSpec(params, "model")
    ? { kind: "modes", modes }
    : { kind: "models" };
};
