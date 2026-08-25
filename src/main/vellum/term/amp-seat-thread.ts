/**
 * The seat's thread, minted before the seat exists.
 *
 * A provision-session harness (Amp) cannot have its session id invented by
 * Vellum Command the way a pin harness can: the id names a thread that lives
 * on the harness's side, and only the harness's own CLI can create one. So the
 * node's `ether.terminal.sessionId` is filled in here — once — before any PTY
 * opens, and every later wake resumes that exact thread.
 *
 * Two properties this has to hold, because the side effect is external:
 *
 * - **Idempotent.** A node that already carries a valid thread id never calls
 *   the CLI again. Otherwise every wake, restart, and retry would leave a
 *   stray thread on the operator's account.
 * - **Fail closed.** A failure returns a reason for the seat to surface as
 *   attention; it never falls back to a different thread, and it never lets a
 *   spawn proceed without an id (`planManagedSpawn` refuses that shape too, so
 *   a missed call here cannot become a seat on Amp's thread picker).
 */

import { Effect } from "effect";
import type { CanvasDoc } from "@shared/canvas";
import {
  isHarnessId,
  templateFor,
  type HarnessId,
} from "@shared/managed-terminal-templates";
import { AppRuntime } from "../../runtime";
import { CanvasesService } from "../canvases";
import { isAmpThreadId, provisionAmpThread } from "./templates/amp-thread";

export type SeatThreadResult =
  | {
      readonly ok: true;
      readonly sessionId: string;
      /**
       * True when this call created the thread. A minted thread is EMPTY, so
       * the seat still needs its Tier-B doctrine; a thread that was already on
       * the node carries its own history and must not be re-bootstrapped.
       */
      readonly minted: boolean;
    }
  | { readonly ok: false; readonly reason: string };

/** Harnesses whose session id is minted by their own CLI before spawn. */
export const usesProvisionedSession = (harness: string): boolean =>
  isHarnessId(harness) &&
  templateFor(harness).capabilityBadges.sessionId === "provision";

const provisionFor = async (
  harness: HarnessId,
  cwd: string | undefined,
): Promise<SeatThreadResult> => {
  switch (harness) {
    case "amp": {
      const minted = await provisionAmpThread(
        cwd === undefined ? {} : { cwd },
      );
      return minted.ok
        ? { ok: true, sessionId: minted.threadId, minted: true }
        : { ok: false, reason: minted.failure.reason };
    }
    default:
      return {
        ok: false,
        reason: `${harness} declares a provisioned session but has no provisioner`,
      };
  }
};

/** A stored id is only reusable when it still looks like that harness's id. */
const storedSessionId = (
  harness: HarnessId,
  raw: string | undefined,
): string | undefined => {
  const value = raw?.trim();
  if (!value) return undefined;
  if (harness === "amp") return isAmpThreadId(value) ? value : undefined;
  return value;
};

const writeSessionId = (
  canvasName: string,
  nodeId: string,
  sessionId: string,
): Effect.Effect<void, unknown, CanvasesService> =>
  Effect.gen(function* () {
    const canvases = yield* CanvasesService;
    // Transactional RMW: another writer may be touching the same canvas, and
    // the id must not be lost to a stale full-document write.
    yield* canvases.mutate(canvasName, (doc: CanvasDoc) => ({
      ...doc,
      nodes: doc.nodes.map((node) =>
        node.id === nodeId && node.ether?.terminal
          ? {
              ...node,
              ether: {
                ...node.ether,
                terminal: { ...node.ether.terminal, sessionId },
              },
            }
          : node,
      ),
    }));
  });

/**
 * Return the seat's provisioned session id, minting and persisting one on the
 * first call. Harnesses that do not use provisioned sessions return `ok` with
 * whatever the node already carries, so a caller can run this unconditionally.
 */
export const ensureProvisionedSessionId = async (input: {
  readonly canvasName: string;
  readonly nodeId: string;
  readonly harness: string;
  readonly storedSessionId?: string;
  readonly cwd?: string;
}): Promise<SeatThreadResult> => {
  const harness = input.harness.trim();
  if (!isHarnessId(harness) || !usesProvisionedSession(harness)) {
    return {
      ok: true,
      sessionId: input.storedSessionId?.trim() ?? "",
      minted: false,
    };
  }
  const existing = storedSessionId(harness, input.storedSessionId);
  if (existing !== undefined) {
    return { ok: true, sessionId: existing, minted: false };
  }

  const minted = await provisionFor(harness, input.cwd);
  if (!minted.ok) return minted;

  try {
    await AppRuntime.runPromise(
      writeSessionId(input.canvasName, input.nodeId, minted.sessionId),
    );
  } catch (error) {
    // The thread exists but the node does not know about it. Refusing here
    // keeps the seat off a thread it cannot resume later, and the operator
    // sees why instead of silently getting a second thread on the next wake.
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      reason: `provisioned ${minted.sessionId} but could not store it on the seat: ${message}`,
    };
  }
  return { ok: true, sessionId: minted.sessionId, minted: true };
};
