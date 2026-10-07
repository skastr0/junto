/**
 * Re-seat a managed agent onto another harness (kill old process, new binding).
 * Confirmation skip is a process-local operator preference (not product state;
 * not durable browser storage — see settings-state architecture).
 */
import type { TextNode } from "@shared/canvas";
import { asCanvasName, type Command, type NodeOf } from "@shared/model";
import { seatParts } from "@shared/model/seat-parts";
import { templateFor, type HarnessId } from "@shared/managed-terminal-templates";
import type { AgentConfigurationChoices } from "../components/node-palette/agent-launch-model";
import { getJuntoApi } from "./junto-api";
import { type ManagedAgentSeatOptions } from "./node-factories";
import { commitCommands } from "./mutations";
import { state$ } from "./state";
import { openTerminal } from "./terminal-actions";
import { terminal$ } from "./terminal-state";
import { nodeAt } from "./use-model";
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

/** Working directory stamped on the seat launch (if any). */
export const seatLaunchCwd = (node: TextNode): string | undefined => {
  const cwd = node.ether?.terminal?.launch?.cwd;
  if (typeof cwd !== "string") return undefined;
  const trimmed = cwd.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

export const reseatChoicesFromConfiguration = (
  choices: AgentConfigurationChoices,
  cwd?: string,
): Omit<ManagedAgentSeatOptions, "host"> => ({
  harness: choices.harness,
  ...(choices.profile ? { profile: choices.profile } : {}),
  ...(choices.model ? { model: choices.model } : {}),
  ...(choices.effort ? { effort: choices.effort } : {}),
  ...(choices.mode ? { mode: choices.mode } : {}),
  ...(cwd ? { cwd } : {}),
});

type ReseatResult = { readonly ok: true } | { readonly ok: false; readonly message: string };

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
    sessionFromMain: true,
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

/**
 * Re-seat a seat onto another harness: stop the old process, say the Reseat,
 * and open the terminal again if it was open. The seat is read from the node
 * store by canvas and id, as it stands when the operator confirms.
 */
export const reseatSeat = async (
  canvas: string,
  id: string,
  choices: AgentConfigurationChoices,
): Promise<ReseatResult> => {
  const seat = nodeAt(canvas, id);
  if (seat?.kind !== "agent") return { ok: false, message: "not an agent seat" };
  const surfaceWasOpen = Boolean(terminal$.openByNodeId[id].peek());

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

  // Drop the open surface before the binding changes, so attach cannot race.
  if (surfaceWasOpen) closeTerminalView(id);

  let command: Command;
  try {
    command = reseatCommand(canvas, seat, choices);
  } catch (error: unknown) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  commitCommands(() => [command]);

  if (surfaceWasOpen) {
    // The terminal still opens on a document node; this one is the document's
    // own, as it follows the store. It goes when openTerminal takes an id.
    const next = state$.doc.peek().nodes.find((node) => node.id === id);
    if (next !== undefined) await openTerminal(next, "focus", { resume: false });
  }
  return { ok: true };
};

/** The same, for a caller that still holds a document node. Goes with its last caller. */
export const performManagedAgentReseat = (
  node: TextNode,
  choices: AgentConfigurationChoices,
): Promise<ReseatResult> => reseatSeat(state$.canvasName.peek(), node.id, choices);
