/** Prove an announced session against harness-local state, then record the
 * current occupant's pin. A delayed receipt cannot replace a named session or
 * write after its generation has left the seat. Failed probes keep retrying
 * on the bounded ladder while the process stays running.
 */

import {
  isHarnessId,
  templateFor,
} from "@shared/managed-terminal-templates";
import { harnessSessionExists } from "./session-existence";

export type CapturedSeatSession = {
  readonly canvasName: string;
  readonly nodeId: string;
  readonly bindingId: string;
  readonly harness: string;
  readonly sessionId: string;
  readonly cwd?: string;
  /**
   * Is the generation that announced this id still the seat's own? The proof
   * ladder runs for seconds; a seat that offboards or is replaced meanwhile
   * must not have its pin replaced with the session it just left. Absent
   * means the caller makes no such claim and the id is written as before.
   */
  readonly isCurrent?: () => boolean;
};

export type CapturePersistOutcome =
  /** Written to the local seat store; the next wake resumes this session. */
  | "written"
  /** The store already names this session — nothing to do. */
  | "already-stored"
  /** No harness-local state proves the id yet (or ever). Not written. */
  | "unverified"
  /** Pin / provisioned / unknown harness: the pin is not ours to set. */
  | "not-captured"
  /** The generation that announced the id is no longer the seat's. Not written. */
  | "not-current"
  /** The store write itself failed. */
  | "failed";

/** Only a capture harness's session id may be learned from the running seat. */
export const usesCapturedSession = (harness: string): boolean =>
  isHarnessId(harness) &&
  templateFor(harness).capabilityBadges.sessionId === "capture";

type SessionIdWriter = (
  input: CapturedSeatSession,
) => Promise<CapturePersistOutcome>;

const writeSessionIdToStore: SessionIdWriter = async (input) => {
  // Imported at call time: this module sits under the terminal host, which the
  // runtime layer itself pulls in. A top-level import would close that loop.
  const [{ coreRunner }, { recordSeatSessionId }] = await Promise.all([
    import("../../core-runner"), import("./seat-session-id"),
  ]);
  return coreRunner.runPromise(recordSeatSessionId({ ...input, onlyIfAbsent: true,
    capture: { bindingId: input.bindingId, harness: input.harness, isCurrent: input.isCurrent ?? (() => true) },
  }));
};

let writer: SessionIdWriter = writeSessionIdToStore;

/** Test seam. Pass undefined to restore the store writer. */
export const __setCapturedSessionWriterForTest = (
  next: SessionIdWriter | undefined,
): void => {
  writer = next ?? writeSessionIdToStore;
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
  if (input.isCurrent !== undefined && !input.isCurrent()) return "not-current";

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

  // Asked again right before the write: the probe above touches the disk.
  if (input.isCurrent !== undefined && !input.isCurrent()) return "not-current";

  try {
    return await writer({
      canvasName,
      nodeId,
      bindingId: input.bindingId,
      harness,
      sessionId,
      ...(cwd ? { cwd } : {}),
      ...(input.isCurrent ? { isCurrent: input.isCurrent } : {}),
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
