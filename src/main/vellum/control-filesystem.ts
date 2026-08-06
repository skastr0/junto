/** Hardened owner-local lifecycle for Unix control sockets and bearer tokens. */
import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, fchmodSync, fsyncSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, Socket, type Server } from "node:net";
import { basename, dirname, join } from "node:path";
import {
  appProcessPlane,
  type AppProcessClose,
  type AppProcessLease,
} from "./app-process-plane";

export const CONTROL_DIRECTORY_MODE = 0o700;
export const CONTROL_FILE_MODE = 0o600;
/**
 * A local Unix connect normally settles immediately, but Electron can delay
 * JavaScript callbacks while its cold main loop is busy. The confirmation
 * probe keeps an aged refusal from authorizing a later destructive rename.
 */
const CONTROL_SOCKET_DISCOVERY_TIMEOUT_MS = 5_000;
const CONTROL_SOCKET_CONFIRM_TIMEOUT_MS = 100;

type ControlSocketLiveness = "active" | "inactive" | "ambiguous";

const probeControlSocketLiveness = (
  path: string,
  timeoutMs: number,
): Promise<ControlSocketLiveness> =>
  new Promise((resolve) => {
    const socket = new Socket();
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (outcome: ControlSocketLiveness): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      socket.destroy();
      resolve(outcome);
    };
    socket.once("connect", () => finish("active"));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      // A captured Unix socket inode is eligible for stale cleanup only when
      // the kernel definitively reports that no listener accepts its path.
      // Bun reports ENOENT for the same stale-inode connect that Node reports
      // as ECONNREFUSED on Darwin; the later exact-inode check still guards a
      // concurrent pathname removal or replacement.
      finish(
        error.code === "ECONNREFUSED" || error.code === "ENOENT"
          ? "inactive"
          : "ambiguous",
      );
    });
    timer = setTimeout(
      () => finish("ambiguous"),
      timeoutMs,
    );
    try {
      socket.connect({ path });
    } catch {
      finish("ambiguous");
    }
  });

type Identity = Readonly<{ dev: bigint; ino: bigint; birthtimeNs: bigint; uid: bigint }>;
const identityOf = (path: string): Identity => {
  const value = lstatSync(path, { bigint: true });
  return { dev: value.dev, ino: value.ino, birthtimeNs: value.birthtimeNs, uid: value.uid };
};
// dev+ino+uid identify the exact directory entry's inode for this lifecycle.
// birthtime metadata is not stable across every supported Node filesystem.
const sameIdentity = (a: Identity, b: Identity): boolean => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid;

declare const controlListenerLeaseBrand: unique symbol;
/** Opaque authority proving exclusive ownership of one control-listener path. */
export type ControlListenerLease = Readonly<{
  readonly [controlListenerLeaseBrand]: true;
}>;

export type ControlSocketPathIdentity = Readonly<{
  readonly dev: bigint;
  readonly ino: bigint;
  readonly birthtimeNs: bigint;
  readonly uid: bigint;
}>;

interface KernelListenerLease {
  readonly held: () => boolean;
  readonly release: () => Promise<void>;
}

interface ControlListenerLeaseState {
  readonly socketPath: string;
  readonly kernel: KernelListenerLease;
  releaseFlight?: Promise<void>;
  released: boolean;
}

const listenerLeaseStates = new WeakMap<object, ControlListenerLeaseState>();

const requireListenerLease = (
  lease: ControlListenerLease,
): ControlListenerLeaseState => {
  const state = listenerLeaseStates.get(lease);
  if (state === undefined) throw new Error("invalid control listener lease");
  if (state.released || !state.kernel.held()) {
    throw new Error("control listener lease is not held");
  }
  return state;
};

const listenUnix = (server: Server, path: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen({ path, readableAll: false, writableAll: false }, () => {
      server.off("error", onError);
      resolve();
    });
  });

const closeUnix = (server: Server): Promise<void> =>
  new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });

const acquireLinuxAbstractLease = async (
  leaseKey: string,
): Promise<KernelListenerLease> => {
  const server = createServer((socket) => socket.destroy());
  const abstractPath =
    `\0vellum-control-${createHash("sha256").update(leaseKey).digest("hex")}`;
  await listenUnix(server, abstractPath);
  // The product listener itself owns process lifetime. This server owns only
  // the collision-proof kernel address and must not create a second exit gate.
  server.unref();
  server.on("error", () => undefined);
  let releaseFlight: Promise<void> | undefined;
  return {
    held: () => server.listening,
    release: () => {
      releaseFlight ??= closeUnix(server);
      return releaseFlight;
    },
  };
};

/**
 * Darwin `lockf(1)` sysexits we care about when holding the control lease.
 * EX_TEMPFAIL (75) means the inode is already flocked by another process —
 * not an fd-inheritance failure. Broken/missing child fd 3 surfaces as
 * EX_CANTCREAT (73) with stderr like "cannot lock fd 3: Bad file descriptor".
 */
const LOCKF_EX_CANTCREAT = 73;
const LOCKF_EX_TEMPFAIL = 75;

const describeDarwinLockfFailure = (
  event: AppProcessClose,
  stderrText: string,
): string => {
  const detail = stderrText.trim();
  const detailSuffix = detail.length > 0 ? `: ${detail}` : "";
  if (event.code === LOCKF_EX_TEMPFAIL) {
    return (
      "control listener lock unavailable: already held by another process " +
      `(lockf EX_TEMPFAIL code=${String(event.code)}; not an fd-inheritance failure)`
    );
  }
  if (event.code === LOCKF_EX_CANTCREAT) {
    return (
      "control listener lock unavailable: cannot open inherited lock descriptor " +
      `(lockf EX_CANTCREAT code=${String(event.code)}${detailSuffix})`
    );
  }
  return (
    `control listener lock unavailable (code=${String(event.code)} ` +
    `signal=${String(event.signal)}${detailSuffix})`
  );
};

const acquireDarwinFileLease = async (
  leaseKey: string,
): Promise<KernelListenerLease> => {
  const lockPath = `${leaseKey}.lease`;
  const fd = openSync(
    lockPath,
    constants.O_CREAT | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
    CONTROL_FILE_MODE,
  );
  let child: AppProcessLease;
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile()) throw new Error("control listener lock is not a regular file");
    const currentUid = typeof process.getuid === "function"
      ? BigInt(process.getuid())
      : undefined;
    if (currentUid !== undefined && stat.uid !== currentUid) {
      throw new Error("control listener lock is not owned by this user");
    }
    if (stat.nlink !== 1n || (stat.mode & 0o077n) !== 0n) {
      throw new Error("control listener lock is not an owner-private inode");
    }
    // Parent keeps ownership of `fd` and may close it after spawn returns.
    // The process plane maps it as child fd 3; lockf locks via /dev/fd/3 so
    // the held lock is on the exact O_NOFOLLOW inode (not a re-opened path).
    child = appProcessPlane.spawnChild({
      source: "control-listener-lease",
      purpose: "hold the Darwin control-listener lock",
      command: "/usr/bin/lockf",
      args: [
        "-s",
        "-t",
        "0",
        "-k",
        "/dev/fd/3",
        "/bin/sh",
        "-c",
        // Defense in depth with isolateProcessGroup: ignore SIGINT if the
        // child still shares a signal path. SIGTERM and parent-pipe close
        // still terminate the holder for intentional release.
        "trap '' INT; printf '\\001'; /bin/cat >/dev/null",
      ],
      // Own session so Ctrl+C to the Electron process group cannot kill the
      // flock holder before quit drain releases it via stdin EOF.
      isolateProcessGroup: true,
      inheritedFileDescriptor: {
        parentFd: fd,
        childFd: 3,
      },
    });
  } finally {
    closeSync(fd);
  }

  let closed: AppProcessClose | undefined;
  void child.io.closed.then((event) => {
    closed = event;
  });
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let stderrText = "";
    let unsubscribeError = (): void => undefined;
    let unsubscribeClose = (): void => undefined;
    const cleanup = (): void => {
      unsubscribeError();
      unsubscribeClose();
      child.io.stdout.off("data", onData);
      child.io.stderr.off("data", onStderr);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      child.io.stdin.end();
      reject(error);
    };
    const onStderr = (chunk: Buffer): void => {
      // Bounded diagnostic capture only — lockf writes at most one short line.
      if (stderrText.length >= 512) return;
      stderrText += chunk.toString("utf8").slice(0, 512 - stderrText.length);
    };
    const onClose = (event: AppProcessClose): void => {
      fail(new Error(describeDarwinLockfFailure(event, stderrText)));
    };
    const onData = (chunk: Buffer): void => {
      if (settled) return;
      if (chunk[0] !== 1) {
        fail(new Error("control listener lock readiness handshake failed"));
        return;
      }
      settled = true;
      cleanup();
      resolve();
    };
    unsubscribeError = child.io.onError(fail);
    unsubscribeClose = child.io.onClose(onClose);
    child.io.stderr.on("data", onStderr);
    if (settled) return;
    child.io.stdout.once("data", onData);
  });

  let releaseFlight: Promise<void> | undefined;
  return {
    held: () => closed === undefined,
    release: () => {
      releaseFlight ??= (async () => {
        // Any terminal exit releases the kernel flock. Prefer a clean stdin
        // EOF release, but a prior SIGINT/SIGTERM that already reaped the
        // holder must not fail shutdown.
        if (closed !== undefined) return;
        child.io.stdin.end();
        await child.io.closed;
      })();
      return releaseFlight;
    },
  };
};

/**
 * Acquire the kernel-released exclusion authority for one listener pathname.
 *
 * Linux uses the abstract Unix namespace, so a crash releases the address
 * without leaving another stale filesystem inode. Darwin uses the system
 * `lockf(1)` over an exact no-follow descriptor; the fixed lock holder exits
 * on parent-pipe EOF, so abrupt parent exit releases the kernel flock.
 */
export const acquireControlListenerLease = async (
  socketPath: string,
): Promise<ControlListenerLease> => {
  const leaseKey = join(realpathSync(dirname(socketPath)), basename(socketPath));
  let kernel: KernelListenerLease;
  try {
    kernel =
      process.platform === "linux"
        ? await acquireLinuxAbstractLease(leaseKey)
        : process.platform === "darwin"
          ? await acquireDarwinFileLease(leaseKey)
          : (() => {
              throw new Error(`control listener leases unsupported on ${process.platform}`);
            })();
  } catch (cause) {
    throw new Error(
      "control listener lease unavailable: live listener or startup in progress",
      { cause },
    );
  }
  const lease = Object.freeze({}) as ControlListenerLease;
  listenerLeaseStates.set(lease, {
    socketPath,
    kernel,
    released: false,
  });
  return lease;
};

export const controlListenerLeaseHeld = (
  lease: ControlListenerLease,
): boolean => {
  const state = listenerLeaseStates.get(lease);
  return state !== undefined &&
    !state.released &&
    state.kernel.held();
};

/** Idempotently release only the exact branded kernel lease. */
export const releaseControlListenerLease = (
  lease: ControlListenerLease,
): Promise<void> => {
  const state = listenerLeaseStates.get(lease);
  if (state === undefined) return Promise.reject(new Error("invalid control listener lease"));
  if (state.released) return Promise.resolve();
  if (state.releaseFlight !== undefined) return state.releaseFlight;
  state.releaseFlight = state.kernel.release().then(() => {
    state.released = true;
  });
  return state.releaseFlight;
};

export const prepareControlDirectory = (path: string): void => {
  mkdirSync(path, { recursive: true, mode: CONTROL_DIRECTORY_MODE });
  // Do not chmod a pathname: open the final component with O_NOFOLLOW and
  // mutate only that descriptor. A symlink at the control-root leaf fails.
  const fd = openSync(
    path,
    constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isDirectory()) throw new Error("control root is not a directory");
    fchmodSync(fd, CONTROL_DIRECTORY_MODE);
    const hardened = fstatSync(fd, { bigint: true });
    if ((hardened.mode & BigInt(0o777)) !== BigInt(CONTROL_DIRECTORY_MODE)) throw new Error("control directory permissions could not be hardened");
  } finally {
    closeSync(fd);
  }
};

const socketIdentity = (
  lease: ControlListenerLease,
): ControlSocketPathIdentity => {
  const state = requireListenerLease(lease);
  const current = lstatSync(state.socketPath, { bigint: true });
  if (!current.isSocket() || current.isSymbolicLink()) {
    throw new Error("control listener path is not an owned Unix socket");
  }
  return Object.freeze({
    dev: current.dev,
    ino: current.ino,
    birthtimeNs: current.birthtimeNs,
    uid: current.uid,
  });
};

const sameSocketPathIdentity = (
  expected: ControlSocketPathIdentity,
  current: ControlSocketPathIdentity,
): boolean =>
  expected.dev === current.dev &&
  expected.ino === current.ino &&
  expected.birthtimeNs === current.birthtimeNs &&
  expected.uid === current.uid;

/** Capture the exact listener inode while the caller holds its path lease. */
export const captureControlSocketPathIdentity = (
  lease: ControlListenerLease,
): ControlSocketPathIdentity => socketIdentity(lease);

/** Test whether the leased canonical path still names the captured socket. */
export const controlSocketPathOwnedByLease = (
  lease: ControlListenerLease,
  expected: ControlSocketPathIdentity,
): boolean => {
  const state = requireListenerLease(lease);
  try {
    const current = lstatSync(state.socketPath, { bigint: true });
    return current.isSocket() &&
      !current.isSymbolicLink() &&
      sameSocketPathIdentity(expected, {
        dev: current.dev,
        ino: current.ino,
        birthtimeNs: current.birthtimeNs,
        uid: current.uid,
      });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};

/**
 * Remove the listener pathname only when the branded lease and captured inode
 * both still agree. The kernel lease, not a bare path, is cleanup authority.
 */
export const removeOwnedControlSocketPath = (
  lease: ControlListenerLease,
  expected: ControlSocketPathIdentity,
): boolean => {
  const state = requireListenerLease(lease);
  if (!controlSocketPathOwnedByLease(lease, expected)) return false;
  unlinkSync(state.socketPath);
  return true;
};

/**
 * Retire a pre-existing socket while holding the exclusive listener lease.
 *
 * The lease excludes conforming Vellum Command startups, while the bounded connect
 * probes prove that a same-user foreign listener is not currently accepting
 * connections. Only fresh definitive inactive results authorize quarantine;
 * timeout, successful connect, and every other error fail closed.
 */
export const removeObservedSocket = async (
  lease: ControlListenerLease,
  runtime: {
    readonly beforeQuarantineRename?: () => void;
  } = {},
): Promise<void> => {
  const state = requireListenerLease(lease);
  const path = state.socketPath;
  let first: ReturnType<typeof lstatSync>;
  try { first = lstatSync(path, { bigint: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (!first.isSocket() || first.isSymbolicLink()) throw new Error("refusing to replace non-socket control path");
  const id: Identity = { dev: first.dev, ino: first.ino, birthtimeNs: first.birthtimeNs, uid: first.uid };
  const discovered = await probeControlSocketLiveness(
    path,
    CONTROL_SOCKET_DISCOVERY_TIMEOUT_MS,
  );
  if (discovered === "active") {
    throw new Error("refusing to replace control socket with a live listener");
  }
  if (discovered !== "inactive") {
    throw new Error("control socket liveness is ambiguous; refusing stale cleanup");
  }
  // Do not let a refusal delayed by a cold Electron loop authorize cleanup:
  // require a second, fresh kernel refusal before touching the directory entry.
  const confirmed = await probeControlSocketLiveness(
    path,
    CONTROL_SOCKET_CONFIRM_TIMEOUT_MS,
  );
  if (confirmed === "active") {
    throw new Error("control socket became live before quarantine");
  }
  if (confirmed !== "inactive") {
    throw new Error("control socket liveness became ambiguous before quarantine");
  }
  requireListenerLease(lease);
  const quarantine = mkdtempSync(join(dirname(path), ".vellum-command-stale-"));
  const quarantined = join(quarantine, basename(path));
  try {
    const qdir = lstatSync(quarantine);
    if (!qdir.isDirectory() || qdir.isSymbolicLink() || (qdir.mode & 0o777) !== CONTROL_DIRECTORY_MODE) throw new Error("stale socket quarantine is not owner-only");
    runtime.beforeQuarantineRename?.();
    requireListenerLease(lease);
    // This catches every deterministic swap before the destructive rename.
    // A same-UID racing rename can still occur after this check; the
    // post-rename identity check below prevents deletion of that replacement.
    const finalCanonical = lstatSync(path, { bigint: true });
    const finalId: Identity = { dev: finalCanonical.dev, ino: finalCanonical.ino, birthtimeNs: finalCanonical.birthtimeNs, uid: finalCanonical.uid };
    if (!finalCanonical.isSocket() || finalCanonical.isSymbolicLink() || !sameIdentity(id, finalId)) throw new Error("control socket changed before quarantine");
    // rename moves the directory entry itself and never follows a symlink target.
    renameSync(path, quarantined);
    requireListenerLease(lease);
    const moved = lstatSync(quarantined, { bigint: true });
    const movedId: Identity = { dev: moved.dev, ino: moved.ino, birthtimeNs: moved.birthtimeNs, uid: moved.uid };
    if (!moved.isSocket() || moved.isSymbolicLink() || !sameIdentity(id, movedId)) throw new Error("control socket changed during quarantine");
    unlinkSync(quarantined);
    rmdirSync(quarantine);
  } catch (error) {
    // A mismatched replacement remains quarantined, never deleted. The caller
    // fails readiness and must not continue to bind a new canonical listener.
    throw error;
  }
};

/** Atomic, no-follow token publication; cleanup is restricted to our inode. */
export const rotateControlFileToken = (
  tokenPath: string,
  suppliedToken?: string,
  /** Test-only deterministic leaf; production always uses random entropy. */
  temporaryLeaf?: string,
): string => {
  const token = suppliedToken ?? randomBytes(32).toString("hex");
  const temp = `${tokenPath}.${temporaryLeaf ?? randomBytes(16).toString("hex")}.tmp`;
  let fd: number | undefined; let owned: Identity | undefined;
  try {
    fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), CONTROL_FILE_MODE);
    const stat = fstatSync(fd, { bigint: true }); owned = { dev: stat.dev, ino: stat.ino, birthtimeNs: stat.birthtimeNs, uid: stat.uid };
    fchmodSync(fd, CONTROL_FILE_MODE); writeFileSync(fd, `${token}\n`, "utf8"); fsyncSync(fd); closeSync(fd); fd = undefined;
    const current = identityOf(temp); if (!sameIdentity(owned, current) || !lstatSync(temp).isFile()) throw new Error("control token temporary path changed");
    renameSync(temp, tokenPath);
    const final = lstatSync(tokenPath); if (!final.isFile() || final.isSymbolicLink() || (final.mode & 0o777) !== CONTROL_FILE_MODE) throw new Error("control token permissions could not be hardened");
    return token;
  } catch (error) {
    if (fd !== undefined) try { closeSync(fd); } catch {}
    if (owned !== undefined) try { if (sameIdentity(owned, identityOf(temp))) unlinkSync(temp); } catch {}
    throw error;
  }
};
