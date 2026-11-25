/** Hardened owner-local lifecycle for Unix control sockets and bearer tokens. */
import { createHash, createHmac, randomBytes } from "node:crypto";
import { accessSync, closeSync, constants, fchmodSync, fsyncSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, Socket, type Server } from "node:net";
import { userInfo } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { ownerPrivateFile, ownerSecretFile } from "./owner-secret-file";

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

export interface KernelListenerLease {
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

/** Hold one Linux abstract Unix address for this process's life, or until released. */
export const acquireLinuxAbstractAddress = async (
  abstractPath: string,
): Promise<KernelListenerLease> => {
  const server = createServer((socket) => socket.destroy());
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
 * Linux control lease names. Abstract names carry no permissions, so a name
 * any local user can compute can be taken first, and every core's control
 * socket then refuses to start. Each name is HMAC-SHA256 under a key only
 * this uid can read, kept under its passwd home, which every start of the uid
 * agrees on and a relinked Junto home does not change:
 * `<account home>/.local/state/junto/control-lease.key`. The input is a
 * domain tag and the absolute normalized path, through one function for the
 * resolved path and the written one. Only the core binds these names; any
 * other reader derives them the same way from the same key.
 *
 * The fallback is decided from facts about the account home alone, before the
 * key is touched: no passwd home, one not this uid's, or one it cannot write,
 * as in a container with no home. Then the names are the sha256 of the path,
 * logged once: the relink is still refused, and only the squat protection is
 * given up. Once the home is usable, any fault on the key or its directories
 * refuses the start and never falls back, so a passing error cannot give one
 * core the other set of names. (remote-security, 25 November.)
 */
const CONTROL_LEASE_KEY_BYTES = 32;
const CONTROL_LEASE_DOMAIN = "junto-control-lease\0";
const CONTROL_LEASE_KEY_PATH = [".local", "state", "junto"] as const;
const CONTROL_LEASE_KEY_FILE = "control-lease.key";

/** The control lease key or its directories cannot be used: the start refuses rather than fall back. */
export class ControlLeaseKeyRefused extends Error {
  readonly path: string;
  constructor(path: string, options?: ErrorOptions) {
    super(`The control lease key at ${path} cannot be used: it, or a directory above it, is not this user's alone. Junto does not start until it is`, options);
    this.name = "ControlLeaseKeyRefused";
    this.path = path;
  }
}

type ControlLeaseNaming = Readonly<{ keyed: boolean; name: (leaseKey: string) => string }>;
let controlLeaseNaming: ControlLeaseNaming | undefined;
let accountHomeForTests: string | undefined;

/** Tests only: the account home the key lives under, in place of the passwd home. */
export const setControlLeaseAccountHomeForTests = (home: string | undefined): void => {
  if (process.env.VITEST === undefined) throw new Error("the control lease account home is set only by tests");
  accountHomeForTests = home;
  controlLeaseNaming = undefined;
};

const ownUid = (): bigint | undefined => (typeof process.getuid === "function" ? BigInt(process.getuid()) : undefined);
const errorCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;

/** The account home when it is usable for the key, or why not; any other fault on it refuses. */
const usableAccountHome = (): { home: string } | { fallback: string } => {
  let home: string | undefined = accountHomeForTests;
  if (home === undefined) {
    try {
      home = userInfo().homedir;
    } catch {
      return { fallback: "this user has no passwd home" };
    }
  }
  if (home === "") return { fallback: "this user has no passwd home" };
  let stat;
  try {
    stat = lstatSync(home, { bigint: true });
    if (stat.isSymbolicLink()) stat = fstatHome(home);
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return { fallback: `the passwd home ${home} does not exist` };
    throw new ControlLeaseKeyRefused(home, { cause: error });
  }
  const uid = ownUid();
  if (!stat.isDirectory()) return { fallback: `the passwd home ${home} is not a directory` };
  if (uid !== undefined && stat.uid !== uid) return { fallback: `the passwd home ${home} is not this user's` };
  try {
    accessSync(home, constants.W_OK);
  } catch (error) {
    if (errorCode(error) === "EACCES" || errorCode(error) === "EROFS" || errorCode(error) === "EPERM") return { fallback: `the passwd home ${home} cannot be written` };
    throw new ControlLeaseKeyRefused(home, { cause: error });
  }
  if ((stat.mode & 0o022n) !== 0n) throw new ControlLeaseKeyRefused(home);
  return { home };
};

/** The home through a symlink to it, as the passwd entry may name one. */
const fstatHome = (home: string) => {
  const fd = openSync(home, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
  try {
    return fstatSync(fd, { bigint: true });
  } finally {
    closeSync(fd);
  }
};

/** `.local`, `.local/state` and `junto` under the home: real directories of this uid that no group or other user can write. */
const controlLeaseKeyDirectory = (home: string): string => {
  let directory = home;
  for (const part of CONTROL_LEASE_KEY_PATH) {
    directory = join(directory, part);
    try {
      mkdirSync(directory, { mode: CONTROL_DIRECTORY_MODE });
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw new ControlLeaseKeyRefused(directory, { cause: error });
    }
    let stat;
    try {
      stat = lstatSync(directory, { bigint: true });
    } catch (error) {
      throw new ControlLeaseKeyRefused(directory, { cause: error });
    }
    const uid = ownUid();
    if (!stat.isDirectory() || stat.isSymbolicLink() || (uid !== undefined && stat.uid !== uid) || (stat.mode & 0o022n) !== 0n) {
      throw new ControlLeaseKeyRefused(directory);
    }
  }
  return directory;
};

const resolveControlLeaseNaming = (): ControlLeaseNaming => {
  if (controlLeaseNaming !== undefined) return controlLeaseNaming;
  const account = usableAccountHome();
  if ("fallback" in account) {
    console.warn(`[control] control lease names come from their paths: ${account.fallback}`);
    controlLeaseNaming = { keyed: false, name: (leaseKey) => createHash("sha256").update(leaseKey).digest("hex") };
    return controlLeaseNaming;
  }
  const path = join(controlLeaseKeyDirectory(account.home), CONTROL_LEASE_KEY_FILE);
  let key: Buffer;
  try {
    key = ownerSecretFile(path, CONTROL_LEASE_KEY_BYTES);
  } catch (error) {
    throw new ControlLeaseKeyRefused(path, { cause: error });
  }
  controlLeaseNaming = {
    keyed: true,
    name: (leaseKey) => createHmac("sha256", key).update(CONTROL_LEASE_DOMAIN, "utf8").update(leaseKey, "utf8").digest("hex"),
  };
  return controlLeaseNaming;
};

const acquireLinuxAbstractLease = (naming: ControlLeaseNaming, leaseKey: string): Promise<KernelListenerLease> =>
  acquireLinuxAbstractAddress(`\0junto-control-${naming.name(leaseKey)}`);

/**
 * Darwin `open(2)` flags that Node does not expose as constants: `O_EXLOCK`
 * takes an exclusive kernel flock on the opened description atomically, and
 * `O_NONBLOCK` turns a contended lock into an immediate `EAGAIN` instead of a
 * wait. Both are stable BSD values on every macOS this app supports.
 */
const DARWIN_O_EXLOCK = 0x0020;

/** Hold an exclusive Darwin flock on one owner-private no-follow file, never waited on. */
export const acquireDarwinFileLock = async (
  lockPath: string,
): Promise<KernelListenerLease> => {
  let fd: number;
  try {
    fd = openSync(
      lockPath,
      constants.O_CREAT |
        constants.O_RDWR |
        (constants.O_NOFOLLOW ?? 0) |
        constants.O_NONBLOCK |
        DARWIN_O_EXLOCK,
      CONTROL_FILE_MODE,
    );
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === "EAGAIN" || code === "EWOULDBLOCK") {
      throw new Error(
        "control listener lock unavailable: already held by another process " +
          `(flock ${code})`,
        { cause },
      );
    }
    throw new Error(`control listener lock unavailable (${String(code)})`, { cause });
  }
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile()) throw new Error("control listener lock is not a regular file");
    const currentUid = typeof process.getuid === "function"
      ? BigInt(process.getuid())
      : undefined;
    if (currentUid !== undefined && stat.uid !== currentUid) {
      throw new Error("control listener lock is not owned by this user");
    }
    if (!ownerPrivateFile(fd, lockPath)) {
      throw new Error("control listener lock is not an owner-private inode");
    }
  } catch (error) {
    closeSync(fd);
    throw error;
  }

  let held = true;
  let releaseFlight: Promise<void> | undefined;
  return {
    held: () => held,
    release: () => {
      releaseFlight ??= (async () => {
        if (!held) return;
        held = false;
        // Closing the last descriptor of this open file description releases
        // the kernel flock; abrupt process exit does the same.
        closeSync(fd);
      })();
      return releaseFlight;
    },
  };
};

/**
 * The names one listener path is held under: the directory it resolves to,
 * and the path as written when that differs, as under a home that is a
 * symlink. A home relinked to a fresh directory under a running listener
 * still names the old listener's text, so a second one is refused; a second
 * path to the same directory still names the resolved one.
 */
const listenerLeaseKeys = (socketPath: string): ReadonlyArray<string> => {
  const resolved = join(realpathSync(dirname(socketPath)), basename(socketPath));
  const written = resolve(socketPath);
  return written === resolved ? [resolved] : [resolved, written];
};

/** Every key's abstract address, or none: one held by another listener refuses the lease. */
const acquireLinuxAbstractLeases = async (
  naming: ControlLeaseNaming,
  leaseKeys: ReadonlyArray<string>,
): Promise<KernelListenerLease> => {
  const leases: KernelListenerLease[] = [];
  try {
    for (const leaseKey of leaseKeys) leases.push(await acquireLinuxAbstractLease(naming, leaseKey));
  } catch (error) {
    await Promise.all(leases.map((lease) => lease.release()));
    throw error;
  }
  if (leases.length === 1) return leases[0]!;
  let releaseFlight: Promise<void> | undefined;
  return {
    held: () => leases.every((lease) => lease.held()),
    release: () => {
      releaseFlight ??= Promise.all(leases.map((lease) => lease.release())).then(() => undefined);
      return releaseFlight;
    },
  };
};

/**
 * Acquire the kernel-released exclusion authority for one listener pathname.
 *
 * Linux uses the abstract Unix namespace, so a crash releases the address
 * without leaving another stale filesystem inode. It holds one address for
 * the resolved path and one for the written path when they differ, and
 * refuses when another listener holds either. Darwin takes an exclusive
 * kernel flock (`O_EXLOCK`) on an exact no-follow descriptor held by this
 * process, so abrupt exit releases the lock with the descriptor. Its lock
 * file sits in the resolved directory, so it holds the resolved path only.
 */
export const acquireControlListenerLease = async (
  socketPath: string,
): Promise<ControlListenerLease> => {
  const leaseKeys = listenerLeaseKeys(socketPath);
  // A key fault refuses here, in its own words, not as a held lease.
  const naming = process.platform === "linux" ? resolveControlLeaseNaming() : undefined;
  let kernel: KernelListenerLease;
  try {
    kernel =
      naming !== undefined
        ? await acquireLinuxAbstractLeases(naming, leaseKeys)
        : process.platform === "darwin"
          ? await acquireDarwinFileLock(`${leaseKeys[0]!}.lease`)
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
 * The lease excludes conforming Junto startups, while the bounded connect
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
  const quarantine = mkdtempSync(join(dirname(path), ".junto-stale-"));
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
