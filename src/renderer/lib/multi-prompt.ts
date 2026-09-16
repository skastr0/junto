import type { CanvasNode } from "@shared/canvas";
import type {
  TerminalManagedPromptDisposition,
  TerminalManagedPromptResult,
} from "@shared/ipc";
import { resolveTerminalBinding } from "@shared/terminal";
import { getVellumCommandApi } from "./vellum-api";
import { state$ } from "./state";

export type MultiPromptTarget = {
  readonly nodeId: string;
  readonly bindingId: string;
  /** Display key (entity.name) for status lines. */
  readonly agentKey: string;
};

export type MultiPromptSeatNote = {
  readonly nodeId: string;
  readonly agentKey: string;
  readonly error?: string;
  readonly reason?: string;
  readonly messageId?: string;
};

export type MultiPromptResult = {
  readonly sent: number;
  readonly queued: ReadonlyArray<MultiPromptSeatNote>;
  readonly unresolved: ReadonlyArray<MultiPromptSeatNote>;
  readonly failed: ReadonlyArray<MultiPromptSeatNote>;
};

export type MultiPromptOps = {
  readonly writePrompt: (input: {
    readonly bindingId: string;
    readonly text: string;
    readonly canvasName?: string;
    readonly nodeId?: string;
  }) => Promise<TerminalManagedPromptResult>;
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
      return {
        ok: false,
        disposition: "failed",
        error: "managed prompt API unavailable",
      };
    }
    return api.terminalManagedPrompt(input);
  },
  canvasName: state$.canvasName.peek() || undefined,
});

const dispositionOf = (
  result: TerminalManagedPromptResult,
): TerminalManagedPromptDisposition =>
  result.disposition ?? (result.ok ? "submitted" : "failed");

const seatNote = (
  target: MultiPromptTarget,
  result: TerminalManagedPromptResult,
  fallback: string,
): MultiPromptSeatNote => ({
  nodeId: target.nodeId,
  agentKey: target.agentKey,
  error: result.error ?? fallback,
  ...(result.reason !== undefined ? { reason: result.reason } : {}),
  ...(result.messageId !== undefined ? { messageId: result.messageId } : {}),
});

/** Compact RTS status: `sent 2 — queued 1 — failed 0` plus seat keys. */
export const formatMultiPromptStatus = (result: MultiPromptResult): string => {
  const parts = [
    `sent ${result.sent}`,
    `queued ${result.queued.length}`,
    `failed ${result.failed.length}`,
  ];
  if (result.unresolved.length > 0) {
    parts.push(`unconfirmed ${result.unresolved.length}`);
  }
  const keys = [
    ...result.queued.map((item) => item.agentKey),
    ...result.unresolved.map((item) => item.agentKey),
    ...result.failed.map((item) => item.agentKey),
  ];
  const unique = [...new Set(keys)];
  return unique.length > 0
    ? `${parts.join(" — ")} — ${unique.join(", ")}`
    : parts.join(" — ");
};

/**
 * Fan-out one prompt to many managed agent seats.
 * Each target is independent; never throws. Returns per-seat dispositions
 * so the composer can keep the draft whenever any seat did not submit.
 */
export async function multiPromptAgents(
  targets: ReadonlyArray<MultiPromptTarget>,
  text: string,
  ops: MultiPromptOps = defaultOps(),
): Promise<MultiPromptResult> {
  const trimmed = text.trim();
  if (!trimmed || targets.length === 0) {
    return { sent: 0, queued: [], unresolved: [], failed: [] };
  }

  const queued: MultiPromptSeatNote[] = [];
  const unresolved: MultiPromptSeatNote[] = [];
  const failed: MultiPromptSeatNote[] = [];
  let sent = 0;
  const canvasName = ops.canvasName?.trim() || undefined;

  await Promise.all(
    targets.map(async (target) => {
      const { nodeId, bindingId, agentKey } = target;
      try {
        const result = await ops.writePrompt({
          bindingId,
          text: trimmed,
          ...(canvasName ? { canvasName, nodeId } : {}),
        });
        switch (dispositionOf(result)) {
          case "submitted":
            sent += 1;
            return;
          case "queued":
            queued.push(seatNote(target, result, "queued at seat"));
            return;
          case "unresolved":
            unresolved.push(
              seatNote(
                target,
                result,
                "Prompt submission is unconfirmed. Inspect the terminal before retrying.",
              ),
            );
            return;
          case "failed":
            failed.push(seatNote(target, result, "prompt refused"));
            return;
        }
      } catch (error) {
        failed.push({
          nodeId,
          agentKey,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }),
  );

  return { sent, queued, unresolved, failed };
}
