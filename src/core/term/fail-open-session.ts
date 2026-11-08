/**
 * A dead resume fails open onto a fresh pinned session (local-host.ts). That
 * fresh id becomes the seat's open session here, ending the dead one, so the
 * next wake resumes the session the seat now runs instead of retrying the id
 * that just failed.
 */

export type FreshSeatSession = {
  readonly canvasName: string;
  readonly nodeId: string;
  readonly bindingId: string;
  readonly harness: string;
  readonly sessionId: string;
  readonly cwd?: string;
};

type FreshSessionWriter = (
  input: FreshSeatSession,
) => Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }>;

const writeFreshSessionToStore: FreshSessionWriter = async (input) => {
  // Imported at call time, as the capture writer is: the terminal host sits
  // under the runtime layer the store writer pulls in.
  const { writeSeatSessionId } = await import("./seat-session-id");
  return writeSeatSessionId(input);
};

let writer: FreshSessionWriter = writeFreshSessionToStore;

/** Record the fail-open session as the seat's own. Total: a refusal is logged, never thrown. */
export const recordFailOpenSession = async (input: FreshSeatSession): Promise<boolean> => {
  if (!input.canvasName.trim() || !input.nodeId.trim()) return false;
  try {
    const stored = await writer(input);
    if (!stored.ok)
      console.error(`[term] fail-open session ${input.sessionId} not recorded for ${input.bindingId}: ${stored.reason}`);
    return stored.ok;
  } catch (cause) {
    console.error(`[term] fail-open session ${input.sessionId} not recorded for ${input.bindingId}:`, cause);
    return false;
  }
};
