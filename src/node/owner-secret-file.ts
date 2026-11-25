/**
 * A small random secret this user keeps in a file only it can read: the
 * home lock's id (home-lock.ts) and the control lease key
 * (control-filesystem.ts). Made the way the native installer makes
 * home.lock (native/cli/src/install/homelock.rs): the bytes go to a private
 * temporary file, fsynced, then hard-linked into place. `link` refuses a name
 * that exists, so a crash leaves no file or a whole one, and whoever loses
 * the link reads the winner's bytes. The file is never rewritten, renamed or
 * unlinked.
 */
import { randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, linkSync, openSync, readSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const code = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;
const ownUid = (): bigint | undefined => (typeof process.getuid === "function" ? BigInt(process.getuid()) : undefined);

export type OwnerSecretFault = "unreadable" | "not-owner-private" | "short";

/** Why a secret file was not read. `short` is a file that is not one of these: no maker leaves it. */
export class OwnerSecretFileRefused extends Error {
  constructor(readonly fault: OwnerSecretFault, readonly path: string, options?: ErrorOptions) {
    super(fault === "short" ? `${path} is not whole` : fault === "not-owner-private" ? `${path} is not a file only this user owns` : `${path} cannot be read`, options);
    this.name = "OwnerSecretFileRefused";
  }
}

/** A regular file of this uid, one link, no group or other bits. */
const ownerPrivate = (fd: number): boolean => {
  const stat = fstatSync(fd, { bigint: true });
  const uid = ownUid();
  return stat.isFile() && (uid === undefined || stat.uid === uid) && stat.nlink === 1n && (stat.mode & 0o077n) === 0n;
};

/** Make `path` with `bytes` random bytes unless it exists; never replaces one that does. */
const makeOwnerSecretFile = (path: string, bytes: number): void => {
  const secret = randomBytes(bytes);
  const temporary = join(dirname(path), `${basename(path)}.${randomBytes(16).toString("hex")}`);
  const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    try {
      let written = 0;
      while (written < secret.length) written += writeSync(fd, secret, written, secret.length - written);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(temporary, path);
    } catch (error) {
      if (code(error) !== "EEXIST") throw error;
    }
  } finally {
    try { unlinkSync(temporary); } catch { /* already gone */ }
  }
};

/** Read `path`'s whole secret, making it first if no one has; refuses at once a file that is short, linked twice, or not this user's alone. */
export const ownerSecretFile = (path: string, bytes: number): Buffer => {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (code(error) !== "ENOENT") throw new OwnerSecretFileRefused("unreadable", path, { cause: error });
  }
  if (fd === undefined) {
    try {
      makeOwnerSecretFile(path, bytes);
      fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    } catch (error) {
      throw new OwnerSecretFileRefused("unreadable", path, { cause: error });
    }
  }
  try {
    if (!ownerPrivate(fd)) throw new OwnerSecretFileRefused("not-owner-private", path);
    const secret = Buffer.alloc(bytes + 1);
    let read = 0;
    for (;;) {
      const n = readSync(fd, secret, read, secret.length - read, read);
      read += n;
      if (n === 0 || read >= secret.length) break;
    }
    if (read !== bytes) throw new OwnerSecretFileRefused("short", path);
    return secret.subarray(0, bytes);
  } finally {
    closeSync(fd);
  }
};
