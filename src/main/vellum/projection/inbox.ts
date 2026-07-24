/**
 * Remote live projection inbox — bounded interval poll of incoming.frame.
 *
 * Safety poll (not fs.watch): flaky across NFS; 2–5s is enough for beta.
 * Applies are serialized (mutex) — never concurrent.
 */

import { constants } from "node:fs";
import { open } from "node:fs/promises";
import {
  applyIncomingProjectionFrame,
  incomingProjectionFramePath,
  type ApplyIncomingProjectionDeps,
  type ApplyIncomingProjectionResult,
} from "./incoming";
import { writeProjectionAppliedAck } from "./ack";

export const DEFAULT_PROJECTION_INBOX_INTERVAL_MS = 3_000;

export type ProjectionInboxDeps = ApplyIncomingProjectionDeps & {
  /** Local station host id written into applied.ack. */
  readonly stationHostId: string;
  /**
   * Local station witness for ack + targetWitness gate.
   * Prefer this over localStationWitness when both set.
   */
  readonly stationWitness: string;
  readonly intervalMs?: number;
  readonly onOutcome?: (result: ApplyIncomingProjectionResult) => void;
};

export type ProjectionInboxHandle = {
  readonly stop: () => void;
  /** Test seam: run one poll tick (still serialized). */
  readonly tick: () => Promise<ApplyIncomingProjectionResult | undefined>;
};

type FrameSignature = {
  readonly mtimeMs: number;
  readonly size: number;
};

const readFrameSignature = async (
  path: string,
): Promise<FrameSignature | undefined> => {
  try {
    const noFollow = constants.O_NOFOLLOW ?? 0;
    const file = await open(path, constants.O_RDONLY | noFollow);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size <= 0) return undefined;
      return { mtimeMs: info.mtimeMs, size: info.size };
    } finally {
      await file.close();
    }
  } catch {
    return undefined;
  }
};

const sigKey = (sig: FrameSignature): string =>
  `${sig.mtimeMs}:${sig.size}`;

/**
 * Start a bounded interval poll of the projection drop path.
 * Call after first boot apply. stop() clears the interval (abort flag).
 */
export const startProjectionInboxPoll = (
  deps: ProjectionInboxDeps,
): ProjectionInboxHandle => {
  let stopped = false;
  let chain: Promise<void> = Promise.resolve();
  /** Last observed drop signature we already attempted (success or reject). */
  let lastAttempted: string | undefined;

  const applyDeps: ApplyIncomingProjectionDeps = {
    storeRoot: deps.storeRoot,
    dropRoot: deps.dropRoot,
    replaceLiveAuthorityDocuments: deps.replaceLiveAuthorityDocuments,
    localStationRole: deps.localStationRole ?? "remote",
    localStationWitness: deps.stationWitness,
    stationHostId: deps.stationHostId,
    writeAck: true,
  };

  const runOnce = async (): Promise<
    ApplyIncomingProjectionResult | undefined
  > => {
    if (stopped) return undefined;
    const framePath = incomingProjectionFramePath(deps.dropRoot);
    const sig = await readFrameSignature(framePath);
    if (!sig) return undefined;
    const key = sigKey(sig);
    if (key === lastAttempted) return undefined;
    lastAttempted = key;

    const result = await applyIncomingProjectionFrame(applyDeps);
    deps.onOutcome?.(result);

    // If rejected but drop remains (fail closed), allow re-attempt only when
    // the file changes again (signature advances). Absent/applied consume drop.
    if (result.status === "applied" || result.status === "idempotent") {
      // Signature may still exist briefly; consume clears it — next tick absent.
      lastAttempted = key;
    }
    return result;
  };

  const enqueue = (): Promise<ApplyIncomingProjectionResult | undefined> => {
    const job = chain.then(runOnce, runOnce);
    // Keep chain alive even if a tick rejects.
    chain = job.then(
      () => undefined,
      () => undefined,
    );
    return job;
  };

  const intervalMs = deps.intervalMs ?? DEFAULT_PROJECTION_INBOX_INTERVAL_MS;
  const timer = setInterval(() => {
    if (stopped) return;
    void enqueue();
  }, intervalMs);
  // Unref so a pure poll loop does not keep the process alive alone when
  // Electron/main has other keepalives; product main always has those.
  if (typeof timer === "object" && "unref" in timer) {
    timer.unref();
  }

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
    tick: () => enqueue(),
  };
};

/**
 * Write applied.ack from a successful apply result + station identity.
 * Exported for boot path (first apply before inbox starts).
 */
export const writeAckFromApplyResult = async (input: {
  readonly result: Extract<
    ApplyIncomingProjectionResult,
    { status: "applied" | "idempotent" }
  >;
  readonly stationHostId: string;
  readonly stationWitness: string;
  readonly dropRoot?: string;
}): Promise<void> => {
  const pointer = input.result.store.snapshot.pointer;
  await writeProjectionAppliedAck({
    stationHostId: input.stationHostId,
    stationWitness: input.stationWitness,
    generation: input.result.generation,
    frameSha256: input.result.frameSha256,
    manifestSha256: pointer.manifestSha256,
    intentSha256: pointer.intentSha256,
    dropRoot: input.dropRoot,
  });
};
