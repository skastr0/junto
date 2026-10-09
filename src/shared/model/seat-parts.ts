import { ulid } from "ulid";
import { managedHarnessEnabled } from "../features";
import { sanitizeExtraArgs } from "../launch-extra-args";
import { resolveManagedLaunch } from "../managed-terminal-launch";
import { templateFor, type HarnessId } from "../managed-terminal-templates";
import { isValidMachineName } from "../machine-identity";
import type { NodeOf } from "./kinds";

// Which agent runs in a seat and how it is started, worked out from what was
// chosen: the one place for the launch rules. The window uses it when the
// operator seats or reseats an agent, and main when an overseer does.

type Launch = NonNullable<NodeOf<"agent">["launch"]>;
type BindingId = NodeOf<"agent">["bindingId"];

/** A new session binding. Minted the same way wherever a seat or terminal is made. */
export const newBinding = (): BindingId => ulid() as BindingId;

/** The machine name, trimmed; throws when it is not one. */
export const requireHostId = (value: string): string => {
  const host = value.trim();
  if (!isValidMachineName(host)) {
    throw new Error(`invalid machine name: ${JSON.stringify(value)}`);
  }
  return host;
};

/** The first part of an agent key, trimmed. It is the agent's own text and need not be a machine name. */
const requireAgentKeyHost = (value: string): string => {
  const prefix = value.trim();
  if (!/^(?!-)[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(prefix)) {
    throw new Error(`invalid agent key: ${JSON.stringify(value)}`);
  }
  return prefix;
};

/** What the operator chooses when seating an agent. */
export type SeatChoices = {
  readonly harness: HarnessId;
  /** The machine the seat runs on. */
  readonly host: string;
  /** Hermes routing prefix when the host declares a distinct key. */
  readonly agentHost?: string;
  readonly profile?: string;
  readonly model?: string;
  readonly effort?: string;
  /** Named agent mode (Amp `-m low|medium|high|ultra`). */
  readonly mode?: string;
  readonly permissionMode?: string;
  /** Extra harness arguments beyond the dials. */
  readonly extraArgs?: readonly string[];
  readonly cwd?: string;
  readonly label?: string;
};

/** Everything that says which agent runs in a seat and how it is started. */
export type SeatParts = {
  readonly label: string;
  readonly agentKey: string;
  readonly host: string;
  readonly bindingId: BindingId;
  readonly harness: HarnessId;
  readonly launch: Launch;
};

/**
 * Work out a seat from the operator's choices: the one place for the launch
 * rules, shared by a new seat and a reseat. The launch holds arguments only;
 * main adds the seat's environment when it starts it, and no secret is kept.
 */
export const seatParts = (choices: SeatChoices): SeatParts => {
  if (!managedHarnessEnabled(choices.harness)) {
    throw new Error(`managed harness ${choices.harness} is disabled in this build`);
  }
  const host = requireHostId(choices.host);
  const agentHost = requireAgentKeyHost(choices.agentHost ?? host);
  const template = templateFor(choices.harness);
  const extraArgs = sanitizeExtraArgs(choices.harness, choices.extraArgs).args;
  const resolved = resolveManagedLaunch(
    choices.harness,
    {
      ...(choices.profile ? { profile: choices.profile } : {}),
      ...(choices.model ? { model: choices.model } : {}),
      ...(choices.effort ? { effort: choices.effort } : {}),
      ...(choices.mode ? { mode: choices.mode } : {}),
      ...(choices.permissionMode ? { permissionMode: choices.permissionMode } : {}),
      ...(extraArgs.length > 0 ? { extraArgs } : {}),
      ...(choices.cwd ? { cwd: choices.cwd } : {}),
    },
    {},
  );
  const launch: Launch = {
    kind: "harness",
    argv: resolved.argv,
    ...(resolved.cwd ? { cwd: resolved.cwd } : {}),
    ...(extraArgs.length > 0 ? { extraArgs: [...extraArgs] } : {}),
  };
  const agentKey =
    choices.harness === "hermes" && choices.profile
      ? `${agentHost}:${choices.profile}`
      : `${agentHost}:${choices.harness}`;
  const dials = [template.displayName, choices.profile, choices.model, choices.effort, choices.mode].filter(
    (part): part is string => Boolean(part && part.trim()),
  );
  return {
    label: choices.label?.trim() || dials.join(" - "),
    agentKey,
    host,
    bindingId: newBinding(),
    harness: choices.harness,
    launch,
  };
};
