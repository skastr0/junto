import { opendir } from "node:fs/promises";
import { join } from "node:path";
import { resolvedSpawnEnv, resolvedSpawnEnvSync } from "../adapters/exec";
import { GIT_GUARD_ARGS } from "../adapters/git-guard";
import { spawnServiceChild } from "../../services/process";

/**
 * Where a Files root's filenames come from: `git ls-files` when the root is
 * in a work tree (tracked plus untracked, minus ignored), else a walk that
 * skips `.git` and `node_modules`. Names only, never a stat per file. Both
 * stream into `sink` in chunks, so a 200k root never blocks the loop.
 */

export type NameSink = (names: ReadonlyArray<string>) => void;

/** Folders neither the walk, the watcher nor the index descends into. */
export const SKIPPED_DIRS: ReadonlySet<string> = new Set([".git", "node_modules"]);

/** Whether any segment of a relative path is a skipped folder. */
export const inSkippedDir = (path: string): boolean => path.split("/").some((segment) => SKIPPED_DIRS.has(segment));

/** A walk stops here: a root this large (a home folder) is not a project. */
export const WALK_CAP = 1_000_000;
const WALK_BATCH = 2048;

const SOURCE = "files-index";

const spawnEnv = (): Promise<NodeJS.ProcessEnv> => resolvedSpawnEnv().catch(() => resolvedSpawnEnvSync());

/**
 * Run git in `cwd` and stream its NUL-separated stdout to `onNames`.
 * Resolves with the exit code; aborting terminates the child.
 */
const streamGit = async (
  cwd: string,
  args: ReadonlyArray<string>,
  onNames: NameSink,
  signal: AbortSignal,
  stdin?: string,
): Promise<number | null> => {
  if (signal.aborted) return null;
  const child = spawnServiceChild({
    source: SOURCE,
    purpose: "files name index",
    command: "git",
    // ls-files, check-ignore and rev-parse run no filter: the fixed overrides suffice.
    args: [...GIT_GUARD_ARGS, "-c", "core.quotepath=off", ...args],
    cwd,
    env: await spawnEnv(),
  });
  const abort = (): void => {
    void child.requestTermination();
  };
  signal.addEventListener("abort", abort, { once: true });
  let rest = "";
  child.io.stdout.setEncoding("utf8");
  child.io.stdout.on("data", (chunk: string) => {
    const parts = (rest + chunk).split("\0");
    rest = parts.pop() ?? "";
    if (parts.length > 0) onNames(parts);
  });
  child.io.stderr.resume();
  child.io.stdin.on("error", () => undefined);
  child.io.stdin.end(stdin);
  try {
    const exit = await child.io.exited;
    if (rest !== "") onNames([rest]);
    return exit.code;
  } finally {
    signal.removeEventListener("abort", abort);
  }
};

/** Whether `root` is inside a git work tree. */
export const isGitRoot = async (root: string, signal: AbortSignal): Promise<boolean> => {
  let answer = "";
  const code = await streamGit(root, ["rev-parse", "--is-inside-work-tree"], (parts) => {
    answer += parts.join("");
  }, signal).catch(() => null);
  return code === 0 && answer.trim() === "true";
};

/** Tracked and untracked files under `root`, relative to it, ignored ones left out. */
export const gitNames = async (root: string, sink: NameSink, signal: AbortSignal): Promise<void> => {
  const code = await streamGit(
    root,
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--deduplicate"],
    (names) => sink(names.filter((name) => !inSkippedDir(name))),
    signal,
  );
  if (code !== 0 && !signal.aborted) throw new Error(`git ls-files exited ${String(code)}`);
};

/** Which of `paths` (relative to `root`) git ignores, for deltas in a git root. */
export const gitIgnored = async (
  root: string,
  paths: ReadonlyArray<string>,
  signal: AbortSignal,
): Promise<ReadonlySet<string>> => {
  if (paths.length === 0) return new Set();
  const ignored = new Set<string>();
  // check-ignore exits 1 when nothing is ignored; its stdout is the answer either way.
  await streamGit(root, ["check-ignore", "-z", "--stdin"], (names) => {
    for (const name of names) if (name !== "") ignored.add(name);
  }, signal, `${paths.join("\0")}\0`).catch(() => null);
  return ignored;
};

/** Every file under `root`, skipping `SKIPPED_DIRS` and never following a symlinked folder. */
export const walkNames = async (
  root: string,
  sink: NameSink,
  signal: AbortSignal,
  cap = WALK_CAP,
): Promise<void> => {
  const queue: string[] = [""];
  let batch: string[] = [];
  let seen = 0;
  const flush = (): void => {
    if (batch.length === 0) return;
    sink(batch);
    batch = [];
  };
  while (queue.length > 0 && seen < cap && !signal.aborted) {
    const dir = queue.pop()!;
    let handle;
    try {
      handle = await opendir(join(root, dir), { bufferSize: 128 });
    } catch {
      continue; // unreadable or gone: the rest of the tree still counts
    }
    try {
      for await (const entry of handle) {
        const path = dir === "" ? entry.name : `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          if (!SKIPPED_DIRS.has(entry.name)) queue.push(path);
        } else if (entry.isFile() || entry.isSymbolicLink()) {
          batch.push(path);
          seen += 1;
          if (batch.length >= WALK_BATCH) flush();
          if (seen >= cap) break;
        }
      }
    } catch {
      // a folder removed mid-read: keep what was read
    }
  }
  flush();
};
