import { constants, realpathSync, statSync } from "node:fs";
import type { Socket } from "node:net";
import { normalize } from "node:path";
import {
  readUnixPeerProcessChain,
  type PeerProcessChainReader,
  type UnixPeerProcessChain,
} from "../process-identity";

const SYSTEM_SSHD_PATHS = Object.freeze(
  process.platform === "darwin" || process.platform === "linux"
    ? ["/usr/sbin/sshd"]
    : [],
);

export interface StationExecutableIdentity {
  readonly path: string;
  readonly device: string;
  readonly inode: string;
}

export interface StationPeerPolicy {
  readonly platform: "Darwin" | "Linux";
  readonly accountUid: number;
  readonly stationExecutable: StationExecutableIdentity;
  readonly systemSshd: readonly StationExecutableIdentity[];
}

export interface StationControlPeerAdmission {
  readonly snapshot: UnixPeerProcessChain;
}

/**
 * The Station server consumes only this seam. Production builds it from exact
 * executable identities; focused tests may inject a closed in-memory authority
 * but no wire field, environment value, or CLI argument can select one.
 */
export interface StationControlPeerAuthority {
  readonly capture: (
    socket: Socket,
  ) => StationControlPeerAdmission | undefined;
  readonly revalidate: (
    socket: Socket,
    admission: StationControlPeerAdmission,
  ) => boolean;
}

const observeExecutable = (
  requestedPath: string,
  requireRootOwned: boolean,
): StationExecutableIdentity | undefined => {
  try {
    const path = normalize(realpathSync(requestedPath));
    const metadata = statSync(path, { bigint: true });
    if (
      !metadata.isFile() ||
      (metadata.mode & BigInt(constants.S_IXUSR)) === 0n ||
      (requireRootOwned && metadata.uid !== 0n) ||
      (requireRootOwned && (metadata.mode & 0o022n) !== 0n)
    ) {
      return undefined;
    }
    return Object.freeze({
      path,
      device: metadata.dev.toString(10),
      inode: metadata.ino.toString(10),
    });
  } catch {
    return undefined;
  }
};

const sameExecutable = (
  observed: UnixPeerProcessChain["chain"][number],
  expected: StationExecutableIdentity,
): boolean =>
  observed.executable === expected.path &&
  observed.device === expected.device &&
  observed.inode === expected.inode;

export const stationPeerSnapshotSatisfiesPolicy = (
  snapshot: UnixPeerProcessChain,
  policy: StationPeerPolicy,
): boolean => {
  if (
    snapshot.platform !== policy.platform ||
    snapshot.peerUid !== policy.accountUid ||
    snapshot.chain.length < 2 ||
    snapshot.chain[0]?.pid !== snapshot.peerPid ||
    snapshot.chain[0]?.uid !== policy.accountUid ||
    !sameExecutable(snapshot.chain[0], policy.stationExecutable)
  ) {
    return false;
  }

  for (let index = 1; index < snapshot.chain.length; index += 1) {
    const child = snapshot.chain[index - 1];
    const ancestor = snapshot.chain[index];
    if (
      child === undefined ||
      ancestor === undefined ||
      child.ppid !== ancestor.pid
    ) {
      return false;
    }
  }

  return snapshot.chain.slice(1).some((ancestor) =>
    policy.systemSshd.some((sshd) => sameExecutable(ancestor, sshd))
  );
};

const sameSnapshot = (
  left: UnixPeerProcessChain,
  right: UnixPeerProcessChain,
): boolean => {
  if (
    left.platform !== right.platform ||
    left.peerPid !== right.peerPid ||
    left.peerUid !== right.peerUid ||
    left.chain.length !== right.chain.length
  ) {
    return false;
  }
  return left.chain.every((hop, index) => {
    const current = right.chain[index];
    return current !== undefined &&
      hop.pid === current.pid &&
      hop.ppid === current.ppid &&
      hop.uid === current.uid &&
      hop.startKey === current.startKey &&
      hop.executable === current.executable &&
      hop.device === current.device &&
      hop.inode === current.inode;
  });
};

const platformName = (): "Darwin" | "Linux" | undefined =>
  process.platform === "darwin"
    ? "Darwin"
    : process.platform === "linux"
      ? "Linux"
      : undefined;

export const makeSshStationControlPeerAuthority = (options: {
  readonly stationExecutablePath: string;
  readonly readProcessChain?: PeerProcessChainReader;
}): StationControlPeerAuthority => {
  const platform = platformName();
  const accountUid =
    typeof process.getuid === "function" ? process.getuid() : undefined;
  const stationExecutable = observeExecutable(
    options.stationExecutablePath,
    false,
  );
  const systemSshd = SYSTEM_SSHD_PATHS.flatMap((candidate) => {
    const identity = observeExecutable(candidate, true);
    return identity === undefined ? [] : [identity];
  });
  const policy =
    platform === undefined ||
      accountUid === undefined ||
      stationExecutable === undefined ||
      systemSshd.length === 0
      ? undefined
      : Object.freeze({
        platform,
        accountUid,
        stationExecutable,
        systemSshd: Object.freeze(systemSshd),
      });
  const readProcessChain =
    options.readProcessChain ?? readUnixPeerProcessChain;
  const issued = new WeakSet<StationControlPeerAdmission>();

  return Object.freeze({
    capture: (socket: Socket) => {
      const snapshot = readProcessChain(socket);
      if (
        policy === undefined ||
        snapshot === undefined ||
        !stationPeerSnapshotSatisfiesPolicy(snapshot, policy)
      ) {
        return undefined;
      }
      const admission = Object.freeze({ snapshot });
      issued.add(admission);
      return admission;
    },
    revalidate: (
      socket: Socket,
      admission: StationControlPeerAdmission,
    ): boolean => {
      if (!issued.has(admission) || policy === undefined) return false;
      const current = readProcessChain(socket);
      return current !== undefined &&
        stationPeerSnapshotSatisfiesPolicy(current, policy) &&
        sameSnapshot(admission.snapshot, current);
    },
  });
};
