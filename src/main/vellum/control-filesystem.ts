/** Hardened owner-local lifecycle for Unix control sockets and bearer tokens. */
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants, fchmodSync, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

export const CONTROL_DIRECTORY_MODE = 0o700;
export const CONTROL_FILE_MODE = 0o600;

type Identity = Readonly<{ dev: bigint; ino: bigint; birthtimeNs: bigint }>;
const identityOf = (path: string): Identity => {
  const value = lstatSync(path, { bigint: true });
  return { dev: value.dev, ino: value.ino, birthtimeNs: value.birthtimeNs };
};
const sameIdentity = (a: Identity, b: Identity): boolean => a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs;

export const prepareControlDirectory = (path: string): void => {
  mkdirSync(path, { recursive: true, mode: CONTROL_DIRECTORY_MODE });
  chmodSync(path, CONTROL_DIRECTORY_MODE);
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== CONTROL_DIRECTORY_MODE) throw new Error("control directory permissions could not be hardened");
};

/** Removes only an observed stale Unix socket, never a symlink or arbitrary file. */
export const removeObservedSocket = (path: string): void => {
  let first: ReturnType<typeof lstatSync>;
  try { first = lstatSync(path, { bigint: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (!first.isSocket() || first.isSymbolicLink()) throw new Error("refusing to replace non-socket control path");
  const id: Identity = { dev: first.dev, ino: first.ino, birthtimeNs: first.birthtimeNs };
  const current = lstatSync(path, { bigint: true });
  if (!current.isSocket() || current.isSymbolicLink() || !sameIdentity(id, { dev: current.dev, ino: current.ino, birthtimeNs: current.birthtimeNs })) throw new Error("control socket changed during stale cleanup");
  unlinkSync(path);
};

/** Atomic, no-follow token publication; cleanup is restricted to our inode. */
export const rotateControlFileToken = (tokenPath: string, suppliedToken?: string): string => {
  const token = suppliedToken ?? randomBytes(32).toString("hex");
  const temp = `${tokenPath}.${randomBytes(16).toString("hex")}.tmp`;
  let fd: number | undefined; let owned: Identity | undefined;
  try {
    fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), CONTROL_FILE_MODE);
    const stat = fstatSync(fd, { bigint: true }); owned = { dev: stat.dev, ino: stat.ino, birthtimeNs: stat.birthtimeNs };
    fchmodSync(fd, CONTROL_FILE_MODE); writeFileSync(fd, `${token}\n`, "utf8"); fsyncSync(fd); closeSync(fd); fd = undefined;
    const current = identityOf(temp); if (!sameIdentity(owned, current) || !lstatSync(temp).isFile()) throw new Error("control token temporary path changed");
    renameSync(temp, tokenPath); chmodSync(tokenPath, CONTROL_FILE_MODE);
    const final = lstatSync(tokenPath); if (!final.isFile() || final.isSymbolicLink() || (final.mode & 0o777) !== CONTROL_FILE_MODE) throw new Error("control token permissions could not be hardened");
    return token;
  } catch (error) {
    if (fd !== undefined) try { closeSync(fd); } catch {}
    if (owned !== undefined) try { if (sameIdentity(owned, identityOf(temp))) unlinkSync(temp); } catch {}
    throw error;
  }
};
