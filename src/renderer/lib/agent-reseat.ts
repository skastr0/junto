/**
 * Re-seat a managed agent onto another harness (kill old process, new binding).
 * Confirmation skip is a process-local operator preference (not product state;
 * not durable browser storage — see settings-state architecture).
 */
import type { TextNode } from "@shared/canvas";
import { resolveTerminalBinding } from "@shared/terminal";
import { templateFor, type HarnessId } from "@shared/managed-terminal-templates";
import type { AgentConfigurationChoices } from "../components/node-palette/agent-launch-model";
import {
  reseatManagedAgentNode,
  type ManagedAgentSeatOptions,
} from "./node-factories";
import { applyManagedAgentReseat } from "./mutations";
import { killTerminal, openTerminal } from "./terminal-actions";
import { closeTerminalSurface, terminal$ } from "./terminal-state";
import {
  closeWorkbenchSurface,
  terminalSurfaceId,
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

/**
 * Stop the old process, commit the reseated node, reopen if the surface was open.
 * Preserves the prior launch cwd (and host) so the new harness lands in the
 * same workspace path.
 */
export const performManagedAgentReseat = async (
  node: TextNode,
  choices: AgentConfigurationChoices,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }> => {
  if (node.ether?.entity?.kind !== "agent") {
    return { ok: false, message: "not an agent seat" };
  }
  const priorBinding = resolveTerminalBinding(node);
  const surfaceWasOpen = Boolean(terminal$.openByNodeId[node.id].peek());
  const priorCwd = seatLaunchCwd(node);

  try {
    if (priorBinding?.kind === "native") {
      await killTerminal(node);
    }
  } catch (error: unknown) {
    // Still reseat — stale process may already be gone.
    console.warn(
      "[agent-reseat] kill prior seat failed",
      error instanceof Error ? error.message : error,
    );
  }

  // Drop open surface before binding id changes so attach cannot race.
  if (surfaceWasOpen) {
    closeWorkbenchSurface(terminalSurfaceId(node.id));
    closeTerminalSurface(node.id);
  }

  let next: TextNode;
  try {
    next = reseatManagedAgentNode(
      node,
      reseatChoicesFromConfiguration(choices, priorCwd),
    );
  } catch (error: unknown) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  applyManagedAgentReseat(next);

  if (surfaceWasOpen) {
    await openTerminal(next, "focus", { resume: false });
  }

  return { ok: true };
};
