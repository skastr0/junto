/**
 * Re-seat a managed agent onto another harness (kill old process, new binding).
 * Confirmation skip is a process-local operator preference (not product state;
 * not durable browser storage — see settings-state architecture).
 */
import type { Seat } from "@shared/model";
import { asCanvasName, type Command, type NodeOf } from "@shared/model";
import { seatParts, type SeatChoices } from "@shared/model/seat-parts";
import { templateFor, type HarnessId } from "@shared/managed-terminal-templates";
import { recoverDocumentLaunchChoices } from "@shared/launch-choices";
import { profileFromAgentKey } from "@shared/harness-records";
import {
  withHarnessSettingsDefaults,
  type AgentConfigurationChoices,
} from "../components/node-palette/agent-launch-model";
import { getJuntoApi } from "./junto-api";
import { canvasTakesEdits, commitCommands } from "./mutations";
import { openTerminal } from "./terminal-actions";
import { terminal$ } from "./terminal-state";
import { nodeAt } from "./use-model";
import { state$ } from "./state";
import {
  closeTerminalView,
} from "./dock-state";

/** Process-local only — resets on app restart. */
let skipReseatConfirm = false;

export const readSkipReseatConfirm = (): boolean => skipReseatConfirm;

export const writeSkipReseatConfirm = (skip: boolean): void => {
  skipReseatConfirm = skip;
};

export const harnessDisplayName = (harness: HarnessId): string =>
  templateFor(harness).displayName;

/** A pick as the operator reads it: the harness, then each dial it sets. */
export const reseatPickLabel = (choices: AgentConfigurationChoices): string =>
  [
    harnessDisplayName(choices.harness),
    choices.profile,
    choices.model,
    choices.effort,
    choices.mode,
    choices.permissionMode,
  ]
    .filter((part): part is string => Boolean(part?.trim()))
    .join(", ");

/** Working directory stamped on the seat launch (if any). */
export const seatLaunchCwd = (node: Seat): string | undefined => {
  const cwd = node.launch?.cwd;
  if (typeof cwd !== "string") return undefined;
  const trimmed = cwd.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

export const reseatChoicesFromConfiguration = (
  choices: AgentConfigurationChoices,
  cwd?: string,
): Omit<SeatChoices, "host"> => ({
  harness: choices.harness,
  ...(choices.profile ? { profile: choices.profile } : {}),
  ...(choices.model ? { model: choices.model } : {}),
  ...(choices.effort ? { effort: choices.effort } : {}),
  ...(choices.mode ? { mode: choices.mode } : {}),
  ...(choices.permissionMode ? { permissionMode: choices.permissionMode } : {}),
  ...(choices.extraArgs && choices.extraArgs.length > 0 ? { extraArgs: choices.extraArgs } : {}),
  ...(cwd ? { cwd } : {}),
});

type ReseatResult = { readonly ok: true } | { readonly ok: false; readonly message: string };

/** What a re-seat of several seats did, seat by seat. */
export type ReseatOutcome = {
  readonly moved: readonly string[];
  /** Already on that exact pick, so left alone. */
  readonly unchanged: readonly string[];
  readonly failed: ReadonlyArray<{ readonly id: string; readonly message: string }>;
};

/**
 * What a re-seat of several seats did, in one line: how many moved, how many
 * were already on the pick, and which failed and why.
 */
export const reseatOutcomeLine = (outcome: ReseatOutcome, nameOf: (id: string) => string): string => {
  const parts: string[] = [];
  if (outcome.moved.length > 0) parts.push(`${outcome.moved.length} re-seated`);
  if (outcome.unchanged.length > 0) parts.push(`${outcome.unchanged.length} already on it`);
  if (outcome.failed.length > 0) {
    const which = outcome.failed.map((failure) => `${nameOf(failure.id)} (${failure.message})`).join(", ");
    parts.push(`${outcome.failed.length} failed: ${which}`);
  }
  return parts.join(", ") || "nothing to re-seat";
};

/**
 * The pick a seat on `host` is re-seated to: the operator's choices over
 * Settings > Agents defaults for that machine, as a new seat of the same pick
 * would launch.
 */
export const reseatPickFor = (choices: AgentConfigurationChoices, host: string): AgentConfigurationChoices =>
  withHarnessSettingsDefaults(choices, state$.settings.peek(), host);

const sameArgs = (left: readonly string[] | undefined, right: readonly string[] | undefined): boolean => {
  const a = left ?? [];
  const b = right ?? [];
  return a.length === b.length && a.every((token, at) => token === b[at]);
};

/** Whether the seat already launches exactly as `pick` would: same harness and every dial. */
export const seatRunsPick = (seat: Seat, pick: AgentConfigurationChoices): boolean => {
  if (seat.harness !== pick.harness) return false;
  const current = recoverDocumentLaunchChoices(seat.harness, seat.launch);
  const profile = current.profile ?? profileFromAgentKey(seat.harness, seat.agentKey);
  return (
    (current.model ?? "") === (pick.model ?? "") &&
    (current.effort ?? "") === (pick.effort ?? "") &&
    (current.mode ?? "") === (pick.mode ?? "") &&
    (current.permissionMode ?? "") === (pick.permissionMode ?? "") &&
    (profile ?? "") === (pick.profile ?? "") &&
    // A re-seat carries no provider: a seat that has one launches differently.
    current.provider === undefined &&
    sameArgs(current.extraArgs, pick.extraArgs)
  );
};

/**
 * The command that puts another agent in a seat: a new agent key, a fresh
 * binding so the old process can be stopped without colliding with the new
 * one, the harness, and how it is launched. The seat keeps its host and the
 * working directory it was launched in. Its name, its place, its wires and
 * its mailbox are not in the command and so are not touched; its session is
 * main's to mint and record when the seat starts.
 */
export const reseatCommand = (
  canvas: string,
  seat: NodeOf<"agent">,
  choices: AgentConfigurationChoices,
): Extract<Command, { readonly _tag: "Reseat" }> => {
  const cwd = seat.launch?.cwd?.trim();
  const parts = seatParts({
    ...reseatChoicesFromConfiguration(choices, cwd ? cwd : undefined),
    host: seat.host,
  });
  return {
    _tag: "Reseat",
    canvas: asCanvasName(canvas),
    id: seat.id,
    agentKey: parts.agentKey,
    bindingId: parts.bindingId,
    harness: parts.harness,
    host: seat.host,
    launch: parts.launch,
  };
};

const stopSeatProcess = async (seat: Seat): Promise<void> => {
  try {
    await getJuntoApi()?.terminalKill?.(seat.bindingId, seat.host);
    try {
      terminal$.sessionByBindingId[seat.bindingId].set(await getJuntoApi()?.terminalGet?.(seat.bindingId, seat.host));
    } catch {
      terminal$.sessionByBindingId[seat.bindingId].set(undefined);
    }
  } catch (error: unknown) {
    // Still reseat: the stale process may already be gone.
    console.warn("[agent-reseat] kill prior seat failed", error instanceof Error ? error.message : error);
  }
};

const CANVAS_REFUSES_EDITS = "the canvas is not open for edits";

/** Say the commands as one act and wait for main to take or refuse it. */
const sayReseats = (commands: ReadonlyArray<Command>): Promise<string | undefined> =>
  new Promise((resolve) => {
    let said = false;
    commitCommands(
      () => {
        said = true;
        return commands;
      },
      { onTaken: () => resolve(undefined), onRefused: (reason) => resolve(reason) },
    );
    // The canvas was not open for edits: nothing was said, so nothing moved.
    if (!said) resolve(CANVAS_REFUSES_EDITS);
  });

/**
 * Re-seat several seats onto one pick: one Reseat command a seat, said as one
 * act. Each seat gets the pick over its own machine's Settings defaults, so it
 * launches like a new seat of that pick on that machine. A seat already on
 * that exact pick is left alone and counted; a node that is not a seat fails.
 * Each old process is stopped and each open terminal is opened again.
 */
export const reseatSeats = async (
  canvas: string,
  ids: readonly string[],
  choices: AgentConfigurationChoices,
): Promise<ReseatOutcome> => {
  const unchanged: string[] = [];
  const failed: Array<{ readonly id: string; readonly message: string }> = [];
  const plans: Array<{ readonly seat: Seat; readonly command: Command; readonly surfaceWasOpen: boolean }> = [];
  for (const id of new Set(ids)) {
    const seat = nodeAt(canvas, id);
    if (seat?.kind !== "agent") {
      failed.push({ id, message: "not an agent seat" });
      continue;
    }
    const pick = reseatPickFor(choices, seat.host);
    if (seatRunsPick(seat, pick)) {
      unchanged.push(id);
      continue;
    }
    try {
      plans.push({
        seat,
        command: reseatCommand(canvas, seat, pick),
        surfaceWasOpen: Boolean(terminal$.openByNodeId[id].peek()),
      });
    } catch (error: unknown) {
      failed.push({ id, message: error instanceof Error ? error.message : String(error) });
    }
  }
  if (plans.length === 0) return { moved: [], unchanged, failed };
  // Learn that the canvas takes edits before any old process is stopped: a
  // refusal after the stop would leave every picked seat dead on its old harness.
  if (!canvasTakesEdits()) {
    return {
      moved: [],
      unchanged,
      failed: [...failed, ...plans.map((plan) => ({ id: plan.seat.id, message: CANVAS_REFUSES_EDITS }))],
    };
  }

  await Promise.all(plans.map((plan) => stopSeatProcess(plan.seat)));
  // Drop each open surface before its binding changes, so attach cannot race.
  for (const plan of plans) if (plan.surfaceWasOpen) closeTerminalView(plan.seat.id);

  const refused = await sayReseats(plans.map((plan) => plan.command));
  if (refused !== undefined) {
    return { moved: [], unchanged, failed: [...failed, ...plans.map((plan) => ({ id: plan.seat.id, message: refused }))] };
  }
  for (const plan of plans) {
    if (plan.surfaceWasOpen) await openTerminal(canvas, plan.seat.id);
  }
  return { moved: plans.map((plan) => plan.seat.id), unchanged, failed };
};

/**
 * Re-seat one seat: `reseatSeats` with one id. The seat is read from the node
 * store by canvas and id, as it stands when the operator confirms.
 */
export const reseatSeat = async (
  canvas: string,
  id: string,
  choices: AgentConfigurationChoices,
): Promise<ReseatResult> => {
  const outcome = await reseatSeats(canvas, [id], choices);
  const failure = outcome.failed[0];
  return failure ? { ok: false, message: failure.message } : { ok: true };
};
