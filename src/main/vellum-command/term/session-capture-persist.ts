/**
 * Capture → proof → canvas. The half of the cold-resume loop that was missing.
 *
 * A capture harness (Codex, Kimi, Muse, Devin, Cursor, Antigravity, Prime
 * Agent) never accepts a session id from Vellum Command: it mints its own and
 * announces it — in a hook payload, an env echo, or a labeled card once one
 * exists. Kimi 0.34.0+ starts with a blank welcome-card `Session:` line; that
 * spawn card is not a receipt. The id is scraped later if the card fills,
 * then proved against `~/.kimi-code/sessions/<workDirKey>/<id>/`. Until a
 * proven id is written to the seat's node, it lives only in this process's
 * diagnostic map, so the next wake opens a brand-new session and the
 * operator's conversation is gone even though the harness still has it on disk.
 *
 * Three rules hold here, because the input is terminal text:
 *
 * - **Proof before persistence.** PTY output is untrusted — arbitrary command
 *   output contains uuid-shaped strings. Nothing is written until
 *   `harnessSessionExists` finds the harness's own durable state for that id.
 * - **Capture harnesses only.** A pin harness already carries the authorial id
 *   the node minted, and a provisioned thread (Amp) is filled in before the PTY
 *   opens. Letting scraped text overwrite either would hand the seat to a
 *   session the node does not own.
 * - **Never a hard failure.** This is recovery, not a spawn gate. A failed
 *   probe or write leaves the seat exactly as it was: running, with the id
 *   still in the process-local map for this generation.
 */

import type { CanvasDoc } from "@shared/canvas";
import {
  isHarnessId,
  templateFor,
} from "@shared/managed-terminal-templates";
import { harnessSessionExists } from "./session-existence";

export type CapturedSeatSession = {
  readonly canvasName: string;
  readonly nodeId: string;
  readonly harness: string;
  readonly sessionId: string;
  readonly cwd?: string;
};

export type CapturePersistOutcome =
  /** Written to `ether.terminal.sessionId`; the next wake resumes this session. */
  | "written"
  /** The node already names this session — nothing to do. */
  | "already-stored"
  /** No harness-local state proves the id yet (or ever). Not written. */
  | "unverified"
  /** Pin / provisioned / unknown harness: the node's id is not ours to set. */
  | "not-captured"
  /** The canvas write itself failed. */
  | "failed";

/** Only a capture harness's session id may be learned from the running seat. */
export const usesCapturedSession = (harness: string): boolean =>
  isHarnessId(harness) &&
  templateFor(harness).capabilityBadges.sessionId === "capture";

type SessionIdWriter = (
  input: CapturedSeatSession,
) => Promise<CapturePersistOutcome>;

const writeSessionIdToCanvas: SessionIdWriter = async (input) => {
  // Imported at call time: this module sits under the terminal host, which the
  // runtime layer itself pulls in. A top-level import would close that loop.
  const [{ AppRuntime }, { CanvasesService }, { Effect }] = await Promise.all([
    import("../../runtime"),
    import("../canvases"),
    import("effect"),
  ]);

  let outcome: CapturePersistOutcome = "already-stored";
  await AppRuntime.runPromise(
    Effect.gen(function* () {
      const canvases = yield* CanvasesService;
      // Transactional RMW: other writers touch the same canvas, and a stale
      // full-document write would drop the id we just proved.
      yield* canvases.mutate(input.canvasName, (doc: CanvasDoc) => ({
        ...doc,
        nodes: doc.nodes.map((node) => {
          if (node.id !== input.nodeId || !node.ether?.terminal) return node;
          if (node.ether.terminal.sessionId?.trim() === input.sessionId) {
            return node;
          }
          outcome = "written";
          return {
            ...node,
            ether: {
              ...node.ether,
              terminal: {
                ...node.ether.terminal,
                sessionId: input.sessionId,
              },
            },
          };
        }),
      }));
    }) as never,
  );
  return outcome;
};

let writer: SessionIdWriter = writeSessionIdToCanvas;

/** Test seam. Pass undefined to restore the canvas writer. */
export const __setCapturedSessionWriterForTest = (
  next: SessionIdWriter | undefined,
): void => {
  writer = next ?? writeSessionIdToCanvas;
};

/**
 * Prove a captured id against harness-local state, then store it on the seat.
 * Total: every refusal is a named outcome, never a throw.
 */
export const persistCapturedSessionId = async (
  input: CapturedSeatSession,
): Promise<CapturePersistOutcome> => {
  const sessionId = input.sessionId.trim();
  const harness = input.harness.trim();
  const canvasName = input.canvasName.trim();
  const nodeId = input.nodeId.trim();
  if (!sessionId || !canvasName || !nodeId) return "not-captured";
  if (!usesCapturedSession(harness)) return "not-captured";

  const cwd = input.cwd?.trim();
  if (
    !harnessSessionExists({
      harness,
      sessionId,
      ...(cwd ? { cwd } : {}),
    })
  ) {
    return "unverified";
  }

  try {
    return await writer({
      canvasName,
      nodeId,
      harness,
      sessionId,
      ...(cwd ? { cwd } : {}),
    });
  } catch {
    return "failed";
  }
};

/**
 * Attempt schedule for a freshly announced id.
 *
 * A harness prints its session id as it starts and flushes the session file a
 * moment later, so the first probe legitimately finds nothing. These delays are
 * the retry ladder, not a poll: the attempts stop at the first proof, and a
 * capture that is never proven simply stops after the last one.
 */
export const CAPTURE_PROOF_RETRY_DELAYS_MS: readonly number[] = [
  0, 750, 2_000, 5_000,
];

/** Bindings with a proof ladder in flight — one per seat generation. */
const inFlight = new Set<string>();

const sleep = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((r) => setTimeout(r, ms).unref?.());

/**
 * Run the proof ladder for one captured id and store it once proven.
 * Fire-and-forget from the PTY data path; resolves with the final outcome so
 * tests (and any future caller that cares) can await it.
 */
export const scheduleCapturedSessionPersist = async (
  key: string,
  input: CapturedSeatSession,
  delays: readonly number[] = CAPTURE_PROOF_RETRY_DELAYS_MS,
): Promise<CapturePersistOutcome> => {
  if (!usesCapturedSession(input.harness.trim())) return "not-captured";
  if (inFlight.has(key)) return "unverified";
  inFlight.add(key);
  try {
    let last: CapturePersistOutcome = "unverified";
    for (const delay of delays) {
      await sleep(delay);
      last = await persistCapturedSessionId(input);
      if (last !== "unverified") return last;
    }
    return last;
  } finally {
    inFlight.delete(key);
  }
};

export const resetCapturedSessionPersistForTest = (): void => {
  inFlight.clear();
};
