/**
 * Writing a seat's session id onto its node.
 *
 * Two harness families need this and they learn the id at opposite ends of the
 * spawn: a provisioned harness (Amp) is told its thread before the PTY opens,
 * while a capture harness (Muse) only reveals its id after the process is
 * already running. Both end in the same place — `ether.terminal.sessionId` on
 * the canvas — because that is the one field a cold wake reads to resume the
 * exact session rather than starting a new one.
 *
 * Transactional by construction: a full-document write from this path could
 * lose a concurrent edit, and an id that goes missing is a seat that silently
 * forks its session on the next wake.
 */

import { Effect } from "effect";
import type { CanvasDoc } from "@shared/canvas";
import { AppRuntime } from "../../runtime";
import { CanvasesService } from "../canvases";

const mutation = (
  canvasName: string,
  nodeId: string,
  sessionId: string,
  onlyIfAbsent: boolean,
): Effect.Effect<void, unknown, CanvasesService> =>
  Effect.gen(function* () {
    const canvases = yield* CanvasesService;
    yield* canvases.mutate(canvasName, (doc: CanvasDoc) => ({
      ...doc,
      nodes: doc.nodes.map((node) => {
        if (node.id !== nodeId || !node.ether?.terminal) return node;
        // Check-and-set inside the transaction. A seat that is resuming
        // already carries its id, and overwriting it with a sibling session
        // discovered in the store is how a seat quietly loses its history.
        if (onlyIfAbsent && (node.ether.terminal.sessionId ?? "").trim()) {
          return node;
        }
        return {
          ...node,
          ether: {
            ...node.ether,
            terminal: { ...node.ether.terminal, sessionId },
          },
        };
      }),
    }));
  });

/**
 * Persist the id, or report why it did not land. Never throws: a caller in a
 * PTY event path must not be taken down by a canvas write.
 */
export const writeSeatSessionId = async (input: {
  readonly canvasName: string;
  readonly nodeId: string;
  readonly sessionId: string;
  /** Leave an id that is already on the node alone (capture harnesses). */
  readonly onlyIfAbsent?: boolean;
}): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> => {
  try {
    await AppRuntime.runPromise(
      mutation(
        input.canvasName,
        input.nodeId,
        input.sessionId,
        input.onlyIfAbsent === true,
      ),
    );
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
};
