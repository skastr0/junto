import { lstat, mkdir, readFile, readdir, realpath, unlink, writeFile } from "node:fs/promises";
import type { Stats } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

const missing = (cause: unknown): boolean => cause instanceof Error && "code" in cause && cause.code === "ENOENT";
export const optionalMetadata = async (path: string) => {
  try { return await lstat(path); } catch (cause) { if (missing(cause)) return undefined; throw cause; }
};

const assertOwned = (path: string, metadata: Stats): void => {
  if (metadata.uid !== process.getuid!() || (metadata.mode & 0o022) !== 0) {
    throw new Error(`machine path must be owned by this user and not writable by others: ${path}`);
  }
};

/** Refuse links at every component below the real account home. */
export const machineHomePath = async (value: string, allowHome = false): Promise<string> => {
  const home = await realpath(homedir());
  const path = resolve(value);
  const suffix = relative(home, path);
  if ((!suffix && !allowHome) || suffix === ".." || suffix.startsWith("../") || isAbsolute(suffix)) {
    throw new Error("machine files must live under the user home");
  }
  let component = home;
  for (const part of ["", ...suffix.split("/").filter(Boolean)]) {
    component = join(component, part);
    const metadata = await optionalMetadata(component);
    if (metadata === undefined) continue;
    assertOwned(component, metadata);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`machine directory is not a real directory: ${component}`);
  }
  return path;
};

export const ensureMachineDirectory = async (path: string, allowHome = false): Promise<void> => {
  await machineHomePath(path, allowHome);
  await mkdir(path, { recursive: true, mode: 0o700 });
  await machineHomePath(path, allowHome);
};

export const ownedMachineFile = async (path: string): Promise<boolean> => {
  const metadata = await optionalMetadata(path);
  if (metadata === undefined) return false;
  assertOwned(path, metadata);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`machine file is not a regular file: ${path}`);
  return true;
};

export const checkMachineTree = async (path: string): Promise<void> => {
  await machineHomePath(path);
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) await checkMachineTree(child);
    else await ownedMachineFile(child);
  }
};

export const writeMachineServiceFile = async (file: string, body: string): Promise<void> => {
  if (await ownedMachineFile(file)) {
    if (await readFile(file, "utf8") !== body) throw new Error("existing service definition belongs to a different install");
    return;
  }
  await writeFile(file, body, { mode: 0o600, flag: "wx" });
};

export const removeMachineServiceFile = async (file: string, body: string): Promise<void> => {
  if (!await ownedMachineFile(file)) return;
  if (await readFile(file, "utf8") !== body) throw new Error("service definition changed; cleanup refused");
  await unlink(file);
};
