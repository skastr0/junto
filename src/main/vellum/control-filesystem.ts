/** Hardened owner-local lifecycle for Unix control sockets and bearer tokens. */
import { randomBytes } from "node:crypto";
import { closeSync, constants, fchmodSync, fsyncSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { basename, dirname, join } from "node:path";

export const CONTROL_DIRECTORY_MODE = 0o700;
export const CONTROL_FILE_MODE = 0o600;

type Identity = Readonly<{ dev: bigint; ino: bigint; birthtimeNs: bigint; uid: bigint }>;
const identityOf = (path: string): Identity => {
  const value = lstatSync(path, { bigint: true });
  return { dev: value.dev, ino: value.ino, birthtimeNs: value.birthtimeNs, uid: value.uid };
};
// dev+ino+uid identify the exact directory entry's inode for this lifecycle.
// birthtime metadata is not stable across every supported Node filesystem.
const sameIdentity = (a: Identity, b: Identity): boolean => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid;

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

/** Removes only an observed stale Unix socket, never a symlink or arbitrary file. */
export const removeObservedSocket = async (
  path: string,
  runtime: { readonly beforeQuarantineRename?: () => void } = {},
): Promise<void> => {
  let first: ReturnType<typeof lstatSync>;
  try { first = lstatSync(path, { bigint: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (!first.isSocket() || first.isSymbolicLink()) throw new Error("refusing to replace non-socket control path");
  const active = await new Promise<boolean>((resolve) => {
    const socket = createConnection({ path }); let done = false;
    const finish = (value: boolean) => { if (done) return; done = true; socket.destroy(); resolve(value); };
    const timer = setTimeout(() => finish(true), 100);
    socket.once("connect", () => { clearTimeout(timer); finish(true); });
    socket.once("error", (error: NodeJS.ErrnoException) => { clearTimeout(timer); finish(error.code !== "ECONNREFUSED" && error.code !== "ENOENT"); });
  });
  if (active) throw new Error("control socket has a live listener or ambiguous ownership");
  const id: Identity = { dev: first.dev, ino: first.ino, birthtimeNs: first.birthtimeNs, uid: first.uid };
  const quarantine = mkdtempSync(join(dirname(path), ".vellum-stale-"));
  const quarantined = join(quarantine, basename(path));
  try {
    const qdir = lstatSync(quarantine);
    if (!qdir.isDirectory() || qdir.isSymbolicLink() || (qdir.mode & 0o777) !== CONTROL_DIRECTORY_MODE) throw new Error("stale socket quarantine is not owner-only");
    runtime.beforeQuarantineRename?.();
    // This catches every deterministic swap before the destructive rename.
    // A same-UID racing rename can still occur after this check; the
    // post-rename identity check below prevents deletion of that replacement.
    const finalCanonical = lstatSync(path, { bigint: true });
    const finalId: Identity = { dev: finalCanonical.dev, ino: finalCanonical.ino, birthtimeNs: finalCanonical.birthtimeNs, uid: finalCanonical.uid };
    if (!finalCanonical.isSocket() || finalCanonical.isSymbolicLink() || !sameIdentity(id, finalId)) throw new Error("control socket changed before quarantine");
    // rename moves the directory entry itself and never follows a symlink target.
    renameSync(path, quarantined);
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
