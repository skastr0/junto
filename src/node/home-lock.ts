/**
 * The home database lock: one core, or one install's restore, on a home's
 * state at a time. The core takes it before it finishes a restore or probes
 * the schema and holds it for its life; the installer takes the same lock
 * around its restore point and restore (native/cli/src/install/restore.rs).
 *
 * Both sides use `<home>/.junto/state/home.lock`, owner-private, holding a
 * 32-byte random id made whole before it is linked into place
 * (owner-secret-file.ts), never unlinked or renamed, since a new inode would
 * split the lock.
 * - Darwin: an exclusive flock (O_EXLOCK|O_NONBLOCK|O_NOFOLLOW) on that file.
 * - Linux: the lock is the abstract Unix address `\0junto-home-<hex of the
 *   32-byte random id the file holds>`.
 *   Abstract names carry no permissions, so a name derived from a path could
 *   be taken first by any local user; the id is readable only by this uid.
 *   Every path to the directory reads the same id, so gives the same name.
 * The kernel releases either with the process, and neither is inherited by a
 * child: libuv opens descriptors and sockets close-on-exec.
 */
import { lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { acquireDarwinFileLock, acquireLinuxAbstractAddress, type KernelListenerLease } from "./control-filesystem";
import { ownerSecretFile, OwnerSecretFileRefused } from "./owner-secret-file";

export const HOME_LOCK_FILE = "home.lock";
const HOME_LOCK_ID_BYTES = 32;

export type HomeLock = Readonly<{ held: () => boolean; release: () => Promise<void> }>;

/** Why the lock was not taken: `held` is another core or an install; `unsafe` is a state directory or lock file this uid does not own alone. */
export class HomeLockRefused extends Error {
  readonly reason: "held" | "unsafe";
  constructor(reason: "held" | "unsafe", message: string, options?: ErrorOptions) {
    super(message, options);
    this.reason = reason;
    this.name = "HomeLockRefused";
  }
}

const uid = (): bigint | undefined => (typeof process.getuid === "function" ? BigInt(process.getuid()) : undefined);

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

const held = (home: string, cause: unknown): HomeLockRefused =>
  new HomeLockRefused("held", `Another Junto core or an install is using ${home}`, { cause });

/** Take the home lock on `<home>/.junto/state`, or refuse at once: it is never waited on. */
export const acquireHomeLock = async (home: string): Promise<HomeLock> => {
  const stateDirectory = join(home, ".junto", "state");
  const lockPath = join(stateDirectory, HOME_LOCK_FILE);
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  requireStateDirectory(stateDirectory);
  // Both platforms keep the whole id in the file, as the installer reads it.
  let id: Buffer;
  try {
    id = ownerSecretFile(lockPath, HOME_LOCK_ID_BYTES);
  } catch (cause) {
    const short = cause instanceof OwnerSecretFileRefused && cause.fault === "short";
    throw new HomeLockRefused("unsafe", short ? `${lockPath} is not a home lock. No core can hold it: remove it and start Junto again` : `${lockPath} is not a file only this user owns`, { cause });
  }
  let kernel: KernelListenerLease;
  if (process.platform === "darwin") {
    try {
      kernel = await acquireDarwinFileLock(lockPath);
    } catch (cause) {
      const contended = cause instanceof Error && /already held by another process/u.test(cause.message);
      throw contended ? held(home, cause) : new HomeLockRefused("unsafe", `${lockPath} cannot be locked`, { cause });
    }
  } else if (process.platform === "linux") {
    try {
      kernel = await acquireLinuxAbstractAddress(`\0junto-home-${id.toString("hex")}`);
    } catch (cause) {
      throw held(home, cause);
    }
  } else {
    throw new HomeLockRefused("unsafe", `The home lock is not supported on ${process.platform}`);
  }
  return Object.freeze({ held: kernel.held, release: kernel.release });
};
