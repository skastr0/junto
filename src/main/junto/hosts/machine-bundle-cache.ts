import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { MachineReleaseArchive } from "@shared/machine-release";

declare const cacheBrand: unique symbol;
declare const attemptBrand: unique symbol;
export interface OwnedMachineBundleCache { readonly [cacheBrand]: true }
export interface OwnedMachineBundleAttempt { readonly [attemptBrand]: true }
interface Directory { readonly path: string; readonly dev: number; readonly ino: number }
interface CacheAuthority { readonly root: Directory; readonly build: Directory; readonly key: string }
const caches = new WeakMap<OwnedMachineBundleCache, CacheAuthority>();
const attempts = new WeakMap<OwnedMachineBundleAttempt, Directory>();
const activeBuilds = new Map<string, number>();
const mutations = new Map<string, Promise<void>>();
const mutate = async <A>(root: Directory, run: () => Promise<A>): Promise<A> => {
  const key = `${root.dev}:${root.ino}`, previous = mutations.get(key) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  mutations.set(key, held);
  await previous;
  try { return await run(); } finally { release(); if (mutations.get(key) === held) mutations.delete(key); }
};
const buildName = /^[a-f0-9]{64}$/;
const archiveName = /^[a-z0-9]+(?:-[a-z0-9]+)+\.tar\.gz$/;
const missing = (error: unknown): boolean => error instanceof Error && "code" in error && error.code === "ENOENT";
const metadata = async (path: string): Promise<Stats | undefined> => {
  try { return await lstat(path); } catch (error) { if (missing(error)) return undefined; throw error; }
};
const owned = (info: Stats): boolean => info.uid === process.getuid?.() && (info.mode & 0o022) === 0;
const directory = async (path: string): Promise<Directory> => {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || !owned(info)) throw new Error("Junto's download folder is not owned by this account");
  return { path, dev: info.dev, ino: info.ino };
};
const recheck = async (value: Directory): Promise<void> => {
  const current = await directory(value.path);
  if (current.dev !== value.dev || current.ino !== value.ino) throw new Error("Junto's download folder changed while it was in use");
};
const childDirectory = async (parent: Directory, name: string): Promise<Directory> => {
  await recheck(parent);
  const path = join(parent.path, name);
  try { await mkdir(path, { mode: 0o700 }); } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
  await recheck(parent);
  return directory(path);
};
const authority = (handle: OwnedMachineBundleCache): CacheAuthority => {
  const value = caches.get(handle);
  if (value === undefined) throw new Error("Machine downloads require an owned cache");
  return value;
};
const filePath = (value: CacheAuthority, target: string): string => {
  if (!archiveName.test(`${target}.tar.gz`)) throw new Error("Invalid machine download target");
  return join(value.build.path, `${target}.tar.gz`);
};
const requireFile = (info: Stats): void => {
  if (!info.isFile() || !owned(info) || info.nlink !== 1) throw new Error("Junto's saved download is not an owned regular file");
};

/** The configured home is read-only authority; only fixed cache descendants are created. */
export const acquireMachineBundleCache = async (home: string, build: string): Promise<OwnedMachineBundleCache> => {
  if (!buildName.test(build)) throw new Error("Invalid machine download build");
  let parent = await directory(await realpath(home));
  for (const name of [".junto", "cache", "machine-bundles"]) parent = await childDirectory(parent, name);
  const root = parent;
  return mutate(root, async () => {
    const buildDirectory = await childDirectory(root, build);
    const key = `${root.dev}:${root.ino}:${build}`;
    activeBuilds.set(key, (activeBuilds.get(key) ?? 0) + 1);
    const handle = Object.freeze({}) as OwnedMachineBundleCache;
    caches.set(handle, { root, build: buildDirectory, key });
    return handle;
  });
};

export const releaseMachineBundleCache = (handle: OwnedMachineBundleCache): void => {
  const value = authority(handle);
  const count = activeBuilds.get(value.key) ?? 0;
  if (count > 1) activeBuilds.set(value.key, count - 1);
  else activeBuilds.delete(value.key);
  caches.delete(handle);
};

/** A fresh private directory, never a caller-selected cleanup path. */
export const createMachineBundleAttempt = async (handle: OwnedMachineBundleCache): Promise<OwnedMachineBundleAttempt> => {
  const value = authority(handle);
  await recheck(value.root);
  const path = await mkdtemp(join(value.root.path, ".attempt-"));
  const attempt = Object.freeze({}) as OwnedMachineBundleAttempt;
  attempts.set(attempt, await directory(path));
  return attempt;
};

export const machineBundleAttemptPath = async (handle: OwnedMachineBundleAttempt): Promise<string> => {
  const value = attempts.get(handle);
  if (value === undefined) throw new Error("Machine unpacking requires an owned attempt");
  await recheck(value);
  return value.path;
};

export const discardMachineBundleAttempt = async (handle: OwnedMachineBundleAttempt): Promise<void> => {
  const value = attempts.get(handle);
  if (value === undefined) throw new Error("Machine cleanup requires an owned attempt");
  await recheck(value);
  let entries = 0;
  const inspect = async (path: string, depth: number): Promise<void> => {
    if (depth > 64) throw new Error("Machine attempt exceeds cleanup depth");
    for (const name of await readdir(path)) {
      if (++entries > 4096) throw new Error("Machine attempt exceeds cleanup bounds");
      const child = join(path, name), info = await lstat(child);
      if (info.isDirectory() && !info.isSymbolicLink() && owned(info)) await inspect(child, depth + 1);
      else requireFile(info);
    }
  };
  await inspect(value.path, 0);
  await recheck(value);
  await rm(value.path, { recursive: true, force: false });
  attempts.delete(handle);
};

/** Authenticate a private snapshot, so later parsing cannot reopen mutable cache bytes. */
export const snapshotCachedMachineArchive = async (
  handle: OwnedMachineBundleCache, attempt: OwnedMachineBundleAttempt, expected: MachineReleaseArchive,
): Promise<boolean> => {
  const value = authority(handle);
  await recheck(value.root); await recheck(value.build);
  const path = filePath(value, expected.target);
  const before = await metadata(path);
  if (before === undefined) return false;
  requireFile(before);
  const source = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let destination: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const snapshot = join(await machineBundleAttemptPath(attempt), "archive.tar.gz");
    destination = await open(snapshot, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    const info = await source.stat(); requireFile(info);
    if (info.dev !== before.dev || info.ino !== before.ino || info.size !== expected.archiveBytes) throw new Error("Saved download size changed");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(128 * 1024);
    let total = 0;
    for (;;) {
      const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > expected.archiveBytes) throw new Error("Saved download exceeds its expected size");
      const bytes = buffer.subarray(0, bytesRead); hash.update(bytes);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesWritten } = await destination.write(bytes, offset, bytes.length - offset, null);
        if (bytesWritten === 0) throw new Error("Cannot save Junto's verified download");
        offset += bytesWritten;
      }
    }
    if (total !== expected.archiveBytes || hash.digest("hex") !== expected.archiveSha256) throw new Error("Saved download checksum changed");
    await destination.sync();
    return true;
  } catch (error) {
    // Retire only this admitted file, and fail this action. The next explicit send downloads afresh.
    const current = await metadata(path);
    if (current?.dev === before.dev && current.ino === before.ino) {
      requireFile(current); await recheck(value.build); await unlink(path);
    }
    throw new Error("Junto's saved download failed its check. Send Junto again to download a fresh copy", { cause: error });
  } finally { await destination?.close(); await source.close(); }
};

/** Publish verified bytes atomically, with all names derived from the admitted build. */
export const publishMachineArchive = async (
  handle: OwnedMachineBundleCache, attempt: OwnedMachineBundleAttempt, target: string,
): Promise<void> => {
  const value = authority(handle);
  await recheck(value.root); await recheck(value.build);
  const destination = filePath(value, target);
  const existing = await metadata(destination);
  if (existing !== undefined) requireFile(existing);
  const source = join(await machineBundleAttemptPath(attempt), "download.tar.gz");
  requireFile(await lstat(source));
  await rename(source, destination);
};

/** Old builds contain archives only. Unknown descendants and active users are retained. */
export const pruneMachineBundleCache = async (handle: OwnedMachineBundleCache): Promise<void> => {
  const value = authority(handle);
  await mutate(value.root, async () => {
    await recheck(value.root);
    for (const name of (await readdir(value.root.path)).slice(0, 256)) {
      if (!buildName.test(name) || activeBuilds.has(`${value.root.dev}:${value.root.ino}:${name}`)) continue;
      const path = join(value.root.path, name), info = await metadata(path);
      if (!info?.isDirectory() || info.isSymbolicLink() || !owned(info)) continue;
      const old = await directory(path);
      const names = await readdir(path);
      if (names.length > 32 || names.some(file => !archiveName.test(file))) continue;
      let recognized = true;
      for (const file of names) {
        const entry = await lstat(join(path, file));
        if (!entry.isFile() || !owned(entry) || entry.nlink !== 1) { recognized = false; break; }
      }
      if (!recognized) continue;
      await recheck(value.root); await recheck(old);
      if (activeBuilds.has(`${value.root.dev}:${value.root.ino}:${name}`)) continue;
      for (const file of names) { requireFile(await lstat(join(path, file))); await unlink(join(path, file)); }
      await recheck(old); await rmdir(path);
    }
  });
};
