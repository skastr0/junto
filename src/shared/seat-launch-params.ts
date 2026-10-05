/**
 * A managed seat's starting parameters, as the operator sees and edits them.
 *
 * Reading: the seat's launch argv is the single stored form, so the current
 * parameters are recovered from it. Writing: a new launch is resolved for the
 * SAME seat (same binding, same session id), so restarting with different
 * parameters continues the conversation instead of re-seating the agent.
 */
import type { CanvasNode, EtherTerminalLaunch } from "./canvas";
import { recoverDocumentLaunchChoices } from "./launch-choices";
import {
  sanitizeExtraArgs,
  type RejectedExtraArg,
} from "./launch-extra-args";
import { resolveManagedLaunch } from "./managed-terminal-launch";
import {
  isHarnessId,
  templateFor,
  type HarnessId,
} from "./managed-terminal-templates";

/** The parameters an operator may set on a seat's harness launch. */
export type SeatLaunchParams = {
  readonly model?: string;
  readonly effort?: string;
  /** Named agent mode (Amp). */
  readonly mode?: string;
  readonly permissionMode?: string;
  /** Extra harness arguments, one argv token each. */
  readonly extraArgs?: readonly string[];
};

export type SeatLaunchParamsView = {
  readonly harness: HarnessId;
  readonly params: SeatLaunchParams;
  /** The argv the seat is stored with today. */
  readonly argv: readonly string[];
};

const trimmed = (value: string | undefined): string | undefined => {
  const next = value?.trim();
  return next && next.length > 0 ? next : undefined;
};

const harnessOf = (node: CanvasNode): HarnessId | undefined => {
  if (node.ether?.entity?.kind !== "agent") return undefined;
  const harness = node.ether.terminal?.harness;
  return harness && isHarnessId(harness) ? harness : undefined;
};

/** Current starting parameters of a managed seat; undefined for other nodes. */
export const seatLaunchParamsOf = (
  node: CanvasNode,
): SeatLaunchParamsView | undefined => {
  const harness = harnessOf(node);
  if (!harness) return undefined;
  const launch = node.ether?.terminal?.launch;
  const recovered = recoverDocumentLaunchChoices(harness, launch);
  return {
    harness,
    params: {
      ...(recovered.model ? { model: recovered.model } : {}),
      ...(recovered.effort ? { effort: recovered.effort } : {}),
      ...(recovered.mode ? { mode: recovered.mode } : {}),
      ...(recovered.permissionMode
        ? { permissionMode: recovered.permissionMode }
        : {}),
      ...(recovered.extraArgs ? { extraArgs: recovered.extraArgs } : {}),
    },
    argv: launch?.argv ?? [],
  };
};

export type SeatLaunchPlan = {
  readonly launch: EtherTerminalLaunch;
  /** Extra arguments that were refused, with the reason for each. */
  readonly rejected: readonly RejectedExtraArg[];
};

/**
 * Resolve the stored launch for `harness` with `params`. `base` supplies what
 * the operator does not edit here: the working directory, the Hermes profile
 * and provider, and the pinned session id.
 */
export const planSeatLaunch = (input: {
  readonly harness: HarnessId;
  readonly params: SeatLaunchParams;
  readonly base?: {
    readonly cwd?: string;
    readonly profile?: string;
    readonly provider?: string;
    readonly sessionId?: string;
  };
}): SeatLaunchPlan => {
  const { harness, params, base } = input;
  const extra = sanitizeExtraArgs(harness, params.extraArgs);
  const model = trimmed(params.model);
  const effort = trimmed(params.effort);
  const mode = trimmed(params.mode);
  const permissionMode = trimmed(params.permissionMode);
  const cwd = trimmed(base?.cwd);
  const profile = trimmed(base?.profile);
  const provider = trimmed(base?.provider);
  // Pin harnesses carry their minted id on the stored argv; every other
  // session shape is added by the spawn planner from the node's session id.
  const pinned =
    templateFor(harness).capabilityBadges.sessionId === "pin"
      ? trimmed(base?.sessionId)
      : undefined;
  const resolved = resolveManagedLaunch(
    harness,
    {
      ...(profile ? { profile } : {}),
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(mode ? { mode } : {}),
      ...(permissionMode ? { permissionMode } : {}),
      ...(extra.args.length > 0 ? { extraArgs: extra.args } : {}),
      ...(cwd ? { cwd } : {}),
      ...(pinned ? { sessionId: pinned } : {}),
      injection: { seatBound: false, connected: false },
    },
    {},
  );
  return {
    launch: {
      kind: "harness",
      argv: resolved.argv,
      ...(resolved.cwd ? { cwd: resolved.cwd } : {}),
      ...(extra.args.length > 0 ? { extraArgs: [...extra.args] } : {}),
    },
    rejected: extra.rejected,
  };
};

/**
 * The same seat with new starting parameters: binding, session id, identity,
 * label and geometry are untouched; only the stored launch changes. Returns
 * undefined when the node is not a managed agent seat.
 */
export const relaunchManagedAgentNode = <N extends CanvasNode>(
  node: N,
  params: SeatLaunchParams,
): { readonly node: N; readonly rejected: readonly RejectedExtraArg[] } | undefined => {
  const harness = harnessOf(node);
  const terminal = node.ether?.terminal;
  if (!harness || !terminal || !node.ether) return undefined;
  const recovered = recoverDocumentLaunchChoices(harness, terminal.launch);
  const plan = planSeatLaunch({
    harness,
    params,
    base: {
      cwd: terminal.launch?.cwd,
      profile: recovered.profile,
      provider: recovered.provider,
      sessionId: terminal.sessionId,
    },
  });
  return {
    node: {
      ...node,
      ether: {
        ...node.ether,
        terminal: { ...terminal, launch: plan.launch },
      },
    },
    rejected: plan.rejected,
  };
};

/** True when two parameter sets resolve to a different launch. */
export const seatLaunchParamsDiffer = (
  a: SeatLaunchParams,
  b: SeatLaunchParams,
): boolean => {
  const same =
    (trimmed(a.model) ?? "") === (trimmed(b.model) ?? "") &&
    (trimmed(a.effort) ?? "") === (trimmed(b.effort) ?? "") &&
    (trimmed(a.mode) ?? "") === (trimmed(b.mode) ?? "") &&
    (trimmed(a.permissionMode) ?? "") === (trimmed(b.permissionMode) ?? "") &&
    (a.extraArgs ?? []).join("\u0000") === (b.extraArgs ?? []).join("\u0000");
  return !same;
};

/**
 * Permission modes offered for a harness: its template default, the stored
 * choice, then the spellings the supported harnesses share. The value is
 * passed to the harness as typed, so an unlisted mode can still be entered
 * as an extra argument.
 */
export const permissionModeOptions = (
  harness: HarnessId,
  current?: string,
): readonly string[] => {
  const spec = templateFor(harness);
  if (
    !spec.argvSpec.permissionModeFlag &&
    !spec.argvSpec.permissionModeEnvKey
  ) {
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const mode of [
    spec.defaultPermissionMode,
    trimmed(current),
    "default",
    "acceptEdits",
    "plan",
    "bypassPermissions",
    "yolo",
    "normal",
  ]) {
    if (!mode || seen.has(mode)) continue;
    seen.add(mode);
    out.push(mode);
  }
  return out;
};
