import type { Socket } from "node:net";
import {
  getProcessIdentityMap,
  readParentPid,
  readUnixPeerPid,
  type PeerPidReader,
  type ProcessIdentityMap,
} from "../process-identity";

/**
 * The operator socket is an explicitly enabled same-owner surface, not a
 * human-authentication boundary. This admission check prevents a registered
 * Vellum agent or terminal process tree from accidentally exercising it.
 *
 * An incomplete ancestry walk is not evidence that a peer is outside a
 * registered tree. Fail closed on every missing parent, cycle, and depth
 * exhaustion.
 */
export type OperatorPeerAdmission =
  | {
      readonly ok: true;
      readonly peerPid: number;
    }
  | {
      readonly ok: false;
      readonly reason:
        | "peer-pid-unavailable"
        | "registered-process-tree"
        | "ancestry-indeterminate";
    };

export interface OperatorPeerAdmissionOptions {
  readonly processMap?: ProcessIdentityMap;
  readonly readPeerPid?: PeerPidReader;
  readonly readParentPid?: (pid: number) => number | undefined;
  /** Tests may lower, never raise, the complete ancestry-walk ceiling. */
  readonly maxDepth?: number;
}

const OPERATOR_ANCESTRY_MAX_DEPTH = 64;

const boundedDepth = (value: number | undefined): number =>
  value === undefined || !Number.isFinite(value) || value < 1
    ? OPERATOR_ANCESTRY_MAX_DEPTH
    : Math.min(Math.floor(value), OPERATOR_ANCESTRY_MAX_DEPTH);

export const admitOperatorPeer = (
  socket: Socket,
  options: OperatorPeerAdmissionOptions = {},
): OperatorPeerAdmission => {
  const peerPid = (options.readPeerPid ?? readUnixPeerPid)(socket);
  if (peerPid === undefined) {
    return { ok: false, reason: "peer-pid-unavailable" };
  }

  const processMap = options.processMap ?? getProcessIdentityMap();
  // Snapshot once so admission cannot alternate between two registry epochs
  // during the ancestry walk. A stale registered PID is denied
  // conservatively; this surface never needs to distinguish it from reuse.
  const registeredPids = new Set(
    processMap.snapshot().map((entry) => entry.pid),
  );
  const parentOf = options.readParentPid ?? readParentPid;
  const visited = new Set<number>();
  const maxDepth = boundedDepth(options.maxDepth);
  let current = peerPid;

  for (let depth = 0; depth < maxDepth; depth += 1) {
    if (!Number.isInteger(current) || current <= 0 || visited.has(current)) {
      return { ok: false, reason: "ancestry-indeterminate" };
    }
    visited.add(current);

    if (registeredPids.has(current)) {
      return { ok: false, reason: "registered-process-tree" };
    }
    // PID 1 is the only complete root witness accepted on supported Unix
    // platforms. readParentPid intentionally rejects its numeric parent 0.
    if (current === 1) {
      return { ok: true, peerPid };
    }

    const parent = parentOf(current);
    if (
      parent === undefined ||
      !Number.isInteger(parent) ||
      parent <= 0 ||
      parent === current
    ) {
      return { ok: false, reason: "ancestry-indeterminate" };
    }
    current = parent;
  }

  return { ok: false, reason: "ancestry-indeterminate" };
};
