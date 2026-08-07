import type { CanvasNode } from "@shared/canvas";
import { resolveTerminalBinding } from "@shared/terminal";
import { getVellumCommandApi } from "./vellum-api";
import { state$ } from "./state";

export type MultiPromptTarget = {
  readonly nodeId: string;
  readonly bindingId: string;
  /** Display key (entity.name) for status lines. */
  readonly agentKey: string;
};

export type MultiPromptResult = {
  readonly sent: number;
  readonly failed: ReadonlyArray<{
    readonly nodeId: string;
    readonly agentKey: string;
    readonly error: string;
  }>;
};

export type MultiPromptOps = {
  readonly writePrompt: (input: {
    readonly bindingId: string;
    readonly text: string;
    readonly canvasName?: string;
    readonly nodeId?: string;
  }) => Promise<{ readonly ok: boolean; readonly error?: string }>;
  readonly canvasName?: string;
};

/**
 * Agent seats with a managed terminal binding. entity.name alone is not enough —
 * multi-prompt types into the managed seat, not ACP.
 */
export const multiPromptTargetsFromNodes = (
  nodes: ReadonlyArray<CanvasNode>,
): ReadonlyArray<MultiPromptTarget> => {
  const out: MultiPromptTarget[] = [];
  for (const node of nodes) {
    const entity = node.ether?.entity;
    if (entity?.kind !== "agent") continue;
    const agentKey =
      typeof entity.name === "string" && entity.name.length > 0
        ? entity.name
        : node.id;
    const binding = resolveTerminalBinding(node);
    if (binding?.kind !== "native" || !binding.bindingId) continue;
    if (!binding.harness && !binding.agentKey) continue;
    out.push({
      nodeId: node.id,
      bindingId: binding.bindingId,
      agentKey,
    });
  }
  return out;
};

const defaultOps = (): MultiPromptOps => ({
  writePrompt: async (input) => {
    const api = getVellumCommandApi();
    if (!api?.terminalManagedPrompt) {
      return { ok: false, error: "managed prompt API unavailable" };
    }
    return api.terminalManagedPrompt(input);
  },
  canvasName: state$.canvasName.peek() || undefined,
});

/**
 * Fan-out one prompt to many managed agent seats.
 * Wakes each seat (when canvas known) then paste+CR via the managed drive.
 * Each target is independent; never throws.
 */
export async function multiPromptAgents(
  targets: ReadonlyArray<MultiPromptTarget>,
  text: string,
  ops: MultiPromptOps = defaultOps(),
): Promise<MultiPromptResult> {
  const trimmed = text.trim();
  if (!trimmed || targets.length === 0) {
    return { sent: 0, failed: [] };
  }

  const failed: Array<{ nodeId: string; agentKey: string; error: string }> = [];
  let sent = 0;
  const canvasName = ops.canvasName?.trim() || undefined;

  await Promise.all(
    targets.map(async ({ nodeId, bindingId, agentKey }) => {
      try {
        const result = await ops.writePrompt({
          bindingId,
          text: trimmed,
          ...(canvasName ? { canvasName, nodeId } : {}),
        });
        if (result.ok) {
          sent += 1;
          return;
        }
        failed.push({
          nodeId,
          agentKey,
          error: result.error ?? "prompt refused",
        });
      } catch (error) {
        failed.push({
          nodeId,
          agentKey,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }),
  );

  return { sent, failed };
}
