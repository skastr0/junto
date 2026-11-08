import type { Node } from "@shared/model";
import type {
  TerminalManagedPromptDisposition,
  TerminalManagedPromptResult,
} from "@shared/ipc";
import { getJuntoApi } from "./junto-api";
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
  readonly failed: ReadonlyArray<MultiPromptSeatNote>;
};

export type MultiPromptOps = {
  readonly writePrompt: (input: {
    readonly bindingId: string;
    readonly text: string;
    readonly canvasName?: string;
    readonly nodeId?: string;
    readonly wake?: boolean;
  }) => Promise<TerminalManagedPromptResult>;
  readonly canvasName?: string;
};

export type MultiPromptOptions = {
  /** False never starts a down seat; the prompt waits in its mailbox. */
  readonly wake?: boolean;
};

/**
 * One target per seat: multi-prompt types into the managed seat, and the
 * model requires a binding and a harness of every seat.
 */
export const multiPromptTargetsOf = (nodes: ReadonlyArray<Node>): ReadonlyArray<MultiPromptTarget> =>
  nodes.flatMap((node) =>
    node.kind === "agent" ? [{ nodeId: node.id, bindingId: node.bindingId, agentKey: node.agentKey }] : [],
  );

const defaultOps = (): MultiPromptOps => ({
  writePrompt: async (input) => {
    const api = getJuntoApi();
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
  const keys = [
    ...result.queued.map((item) => item.agentKey),
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
  options: MultiPromptOptions = {},
): Promise<MultiPromptResult> {
  const trimmed = text.trim();
  if (!trimmed || targets.length === 0) {
    return { sent: 0, queued: [], failed: [] };
  }

  const queued: MultiPromptSeatNote[] = [];
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
          ...(options.wake !== undefined ? { wake: options.wake } : {}),
        });
        switch (dispositionOf(result)) {
          case "submitted":
            sent += 1;
            return;
          case "queued":
            queued.push(seatNote(target, result, "waiting for the seat to start"));
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

  return { sent, queued, failed };
}
