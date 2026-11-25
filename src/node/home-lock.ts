/**
 * The home database lock: one core, or one install's restore, on a home's
 * state at a time. The core takes it before it finishes a restore or probes
 * the schema and holds it for its life; the installer takes the same lock
 * around its restore point and restore (native/cli/src/install/restore.rs).
 *
 * Both sides use `<home>/.junto/state/home.lock`, owner-private, never
 * unlinked or renamed, since a new inode would split the lock.
 * - Darwin: an exclusive flock (O_EXLOCK|O_NONBLOCK|O_NOFOLLOW) on that file.
 * - Linux: the file holds a 32-byte random id, created once with O_EXCL, and
 *   the lock is the abstract Unix address `\0junto-home-<hex of the id>`.
 *   Abstract names carry no permissions, so a name derived from a path could
 *   be taken first by any local user; the id is readable only by this uid.
 *   Every path to the directory reads the same id, so gives the same name.
 * The kernel releases either with the process, and neither is inherited by a
 * child: libuv opens descriptors and sockets close-on-exec.
 */
import { randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, writeSync } from "node:fs";
import { join } from "node:path";
import { acquireDarwinFileLock, acquireLinuxAbstractAddress, type KernelListenerLease } from "./control-filesystem";

export const HOME_LOCK_FILE = "home.lock";
const HOME_LOCK_ID_BYTES = 32;
/** A core that lost the create race reads the id once its creator has written it. */
const HOME_LOCK_ID_WAIT_MS = 2_000;

export type HomeLock = Readonly<{ held: () => boolean; release: () => Promise<void> }>;

/** Why the lock was not taken: `held` is another core or an install; `unsafe` is a state directory or lock file this uid does not own alone. */
export class HomeLockRefused extends Error {
  constructor(readonly reason: "held" | "unsafe", message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "HomeLockRefused";
  }
}

const uid = (): bigint | undefined => (typeof process.getuid === "function" ? BigInt(process.getuid()) : undefined);
const code = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;

/** A real directory of this uid that no group or other user can write. */
const requireStateDirectory = (stateDirectory: string): void => {
  let stat;
  try {
    stat = lstatSync(stateDirectory, { bigint: true });
  } catch (cause) {
    throw new HomeLockRefused("unsafe", `The state directory ${stateDirectory} cannot be read`, { cause });
  }
  const own = uid();
  if (!stat.isDirectory() || stat.isSymbolicLink() || (own !== undefined && stat.uid !== own) || (stat.mode & 0o022n) !== 0n) {
    throw new HomeLockRefused("unsafe", `The state directory ${stateDirectory} is not a directory only this user can write`);
  }
};

/** An open home.lock is a regular file of this uid with one link and no group or other bits. */
const requireLockFile = (fd: number, lockPath: string): void => {
  const stat = fstatSync(fd, { bigint: true });
  const own = uid();
  if (!stat.isFile() || (own !== undefined && stat.uid !== own) || stat.nlink !== 1n || (stat.mode & 0o077n) !== 0n) {
    throw new HomeLockRefused("unsafe", `${lockPath} is not a file only this user owns`);
  }
};

const createLockId = (lockPath: string): void => {
  let fd: number;
  try {
    fd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
  } catch (cause) {
    if (code(cause) === "EEXIST") return;
    throw new HomeLockRefused("unsafe", `${lockPath} cannot be created`, { cause });
  }
  try {
    requireLockFile(fd, lockPath);
    const id = randomBytes(HOME_LOCK_ID_BYTES);
    let written = 0;
    while (written < id.length) written += writeSync(fd, id, written, id.length - written);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
};

const readLockId = async (lockPath: string): Promise<string> => {
  const deadline = Date.now() + HOME_LOCK_ID_WAIT_MS;
  for (;;) {
    let fd: number;
    try {
      fd = openSync(lockPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    } catch (cause) {
      throw new HomeLockRefused("unsafe", `${lockPath} cannot be opened`, { cause });
    }
    const id = Buffer.alloc(HOME_LOCK_ID_BYTES + 1);
    let read = 0;
    try {
      requireLockFile(fd, lockPath);
      for (;;) {
        const n = readSync(fd, id, read, id.length - read, read);
        if (n === 0 || read + n >= id.length) { read += n; break; }
        read += n;
      }
    } finally {
      closeSync(fd);
    }
    if (read === HOME_LOCK_ID_BYTES) return id.subarray(0, HOME_LOCK_ID_BYTES).toString("hex");
    // Short: its creator is still writing it, or stopped in between, before
    // any core could take a name from it.
    if (read > HOME_LOCK_ID_BYTES || Date.now() > deadline) {
      throw new HomeLockRefused("unsafe", `${lockPath} is not a home lock. No core can hold it: remove it and start Junto again`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const held = (home: string, cause: unknown): HomeLockRefused =>
  new HomeLockRefused("held", `Another Junto core or an install is using ${home}`, { cause });

/** Take the home lock on `<home>/.junto/state`, or refuse at once: it is never waited on. */
export const acquireHomeLock = async (home: string): Promise<HomeLock> => {
  const stateDirectory = join(home, ".junto", "state");
  const lockPath = join(stateDirectory, HOME_LOCK_FILE);
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  requireStateDirectory(stateDirectory);
  let kernel: KernelListenerLease;
  if (process.platform === "darwin") {
    try {
      kernel = await acquireDarwinFileLock(lockPath);
    } catch (cause) {
      const contended = cause instanceof Error && /already held by another process/u.test(cause.message);
      throw contended ? held(home, cause) : new HomeLockRefused("unsafe", `${lockPath} cannot be locked`, { cause });
    }
  } else if (process.platform === "linux") {
    createLockId(lockPath);
    const id = await readLockId(lockPath);
    try {
      kernel = await acquireLinuxAbstractAddress(`\0junto-home-${id}`);
    } catch (cause) {
      throw held(home, cause);
    }
  } else {
    throw new HomeLockRefused("unsafe", `The home lock is not supported on ${process.platform}`);
  }
  return Object.freeze({ held: kernel.held, release: kernel.release });
};
