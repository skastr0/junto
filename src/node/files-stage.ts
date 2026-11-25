/**
 * Where a file dropped onto this machine's Files node from another machine
 * waits, whole, before it is imported (0.12.1, plan 12-files-over-ssh, X3,
 * remote-security term 4).
 *
 * On disk, never in a tmpfs: `<account home>/.cache/junto/stage/<home tag>`,
 * each directory from the home down this user's alone, with no group or other
 * write. The system temp folder is used only when that cannot be. The home tag
 * keeps two Junto homes of one account apart, so one core's start sweeps only
 * its own stale stages. Never under Junto's home, whose files an import
 * refuses, and never under a Files root.
 */

import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, rmSync, statfsSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

const STAGE_MODE = 0o700;
const STAGE_PATH = [".cache", "junto", "stage"] as const;

const ownUid = (): number | undefined => (typeof process.getuid === "function" ? process.getuid() : undefined);

/** Makes each part under `base`, and requires each to be a real directory of this uid that no group or other user can write. */
const ownedChain = (base: string, parts: ReadonlyArray<string>): string => {
  let directory = base;
  for (const part of parts) {
    directory = join(directory, part);
    try {
      mkdirSync(directory, { mode: STAGE_MODE });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const stat = lstatSync(directory);
    const uid = ownUid();
    if (!stat.isDirectory() || stat.isSymbolicLink() || (uid !== undefined && stat.uid !== uid) || (stat.mode & 0o022) !== 0) {
      throw new Error("a stage directory is not this user's alone");
    }
  }
  return directory;
};

/** The account home, when it is a directory of this uid that no group or other user can write. */
const ownedHome = (): string | undefined => {
  try {
    const home = userInfo().homedir;
    if (home === "") return undefined;
    const stat = lstatSync(home);
    const uid = ownUid();
    return stat.isDirectory() && (uid === undefined || stat.uid === uid) && (stat.mode & 0o022) === 0 ? home : undefined;
  } catch {
    return undefined;
  }
};

let stageParentForTests: string | undefined;
/** Tests only: the folder stages are made under. */
export const setFilesStageParentForTests = (parent: string | undefined): void => {
  if (process.env.VITEST === undefined) throw new Error("the files stage is set only by tests");
  stageParentForTests = parent;
};

/** This Junto home's stage folder: under the account home, or else under the system temp folder. */
export const filesStageParent = (juntoHome: string): string => {
  const tag = createHash("sha256").update(juntoHome, "utf8").digest("hex").slice(0, 16);
  if (stageParentForTests !== undefined) return ownedChain(stageParentForTests, [tag]);
  const home = ownedHome();
  if (home !== undefined) {
    try {
      return ownedChain(home, [...STAGE_PATH, tag]);
    } catch {
      // Falls through to the temp folder, which is checked the same way.
    }
  }
  return ownedChain(tmpdir(), [`junto-stage-${String(ownUid() ?? "user")}`, tag]);
};

/** Removes every stage a core of this home left behind; run once at start, before any upload. */
export const sweepFilesStages = (parent: string): number => {
  let removed = 0;
  for (const entry of readdirSync(parent)) {
    rmSync(join(parent, entry), { recursive: true, force: true });
    removed += 1;
  }
  return removed;
};

/** Bytes free to this user on the stage's filesystem, or undefined when it cannot say. */
export const stageFreeBytes = (parent: string): number | undefined => {
  try {
    const stats = statfsSync(parent);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return undefined;
  }
};
