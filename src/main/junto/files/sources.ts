import { lstat, opendir, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import { GIT_GUARD_ARGS } from "../adapters/git-guard";

/**
 * Where a Files root's filenames come from: `git ls-files` when the root is
 * in a work tree (tracked plus untracked, minus ignored), else a walk that
 * skips `.git` and `node_modules`. Names only, never a stat per tracked
 * file. Both stream into `sink` in chunks, so a 200k root never blocks the
 * loop. A symlink is listed only when it resolves inside the root: one that
 * points out could only answer `outside-root`.
 *
 * Git is reached through a `GitRun`: in the app main spawns it on the
 * process plane (`git-spawn.ts`) and hands its stdout over as bytes, and
 * this module, in the index worker, decodes and splits them.
 */

export type NameSink = (names: ReadonlyArray<string>) => void;

/** Folders neither the walk, the watcher nor the index descends into. */
export const SKIPPED_DIRS: ReadonlySet<string> = new Set([".git", "node_modules"]);

/** Whether any segment of a relative path is a skipped folder. */
export const inSkippedDir = (path: string): boolean => path.split("/").some((segment) => SKIPPED_DIRS.has(segment));

/** A walk stops here: a root this large (a home folder) is not a project. */
export const WALK_CAP = 1_000_000;
const WALK_BATCH = 2048;

/**
 * Run git in `cwd` with `args` (the guard is already in them), stream its
 * stdout bytes to `onBytes`, and resolve with the exit code. Aborting ends
 * the child.
 */
export type GitRun = (
  cwd: string,
  args: ReadonlyArray<string>,
  onBytes: (chunk: Uint8Array) => void,
  signal: AbortSignal,
  stdin?: string,
) => Promise<number | null>;

/** The names a root's index is built from; swapped in tests. */
export type NameSources = {
  readonly isGitRoot: (root: string, signal: AbortSignal) => Promise<boolean>;
  readonly gitNames: (root: string, sink: NameSink, signal: AbortSignal) => Promise<void>;
  readonly walkNames: (root: string, sink: NameSink, signal: AbortSignal, cap?: number, within?: string) => Promise<void>;
  readonly gitIgnored: (root: string, paths: ReadonlyArray<string>, signal: AbortSignal) => Promise<ReadonlySet<string>>;
};

/** ls-files, check-ignore and rev-parse run no filter: the fixed overrides suffice. */
const guarded = (args: ReadonlyArray<string>): ReadonlyArray<string> => [...GIT_GUARD_ARGS, "-c", "core.quotepath=off", ...args];

/** Run git and stream its NUL-separated stdout to `onNames`, decoded here. */
const streamGit = async (
  run: GitRun,
  cwd: string,
  args: ReadonlyArray<string>,
  onNames: NameSink,
  signal: AbortSignal,
  stdin?: string,
): Promise<number | null> => {
  if (signal.aborted) return null;
  const decoder = new TextDecoder("utf-8");
  let rest = "";
  const take = (text: string): void => {
    const parts = (rest + text).split("\0");
    rest = parts.pop() ?? "";
    if (parts.length > 0) onNames(parts);
  };
  const code = await run(cwd, guarded(args), (chunk) => take(decoder.decode(chunk, { stream: true })), signal, stdin);
  take(decoder.decode());
  if (rest !== "") onNames([rest]);
  return code;
};

/** The git-backed sources over `run`, with the plain walk. */
export const makeNameSources = (run: GitRun): NameSources => ({
  isGitRoot: (root, signal) => isGitRoot(run, root, signal),
  gitNames: (root, sink, signal) => gitNames(run, root, sink, signal),
  walkNames,
  gitIgnored: (root, paths, signal) => gitIgnored(run, root, paths, signal),
});

/** Whether `root` is inside a git work tree. */
const isGitRoot = async (run: GitRun, root: string, signal: AbortSignal): Promise<boolean> => {
  let answer = "";
  const code = await streamGit(run, root, ["rev-parse", "--is-inside-work-tree"], (parts) => {
    answer += parts.join("");
  }, signal).catch(() => null);
  return code === 0 && answer.trim() === "true";
};

/** Whether the symlink at `link` (absolute) resolves inside `root` (a realpath). A dangling one does not. */
export const linkInside = async (root: string, link: string): Promise<boolean> => {
  const target = await realpath(link).catch(() => undefined);
  return target !== undefined && (target === root || target.startsWith(root + sep));
};

const GIT_LINK_MODE = "120000";
/** A submodule: a folder, never a file. */
const GIT_SUBMODULE_MODE = "160000";
const UNTRACKED_LSTATS = 64;

/**
 * Tracked and untracked files under `root` (a realpath), relative to it,
 * ignored ones left out. Tracked entries carry their mode, so only symlinks
 * are resolved; untracked ones (few, outside ignored folders) take an lstat
 * each to find theirs.
 */
const gitNames = async (run: GitRun, root: string, sink: NameSink, signal: AbortSignal): Promise<void> => {
  const links: string[] = [];
  let last = "";
  const tracked = await streamGit(
    run,
    root,
    // --format cannot combine with --others; an unmerged path repeats, adjacent.
    ["ls-files", "-z", "--cached", "--format=%(objectmode) %(path)"],
    (records) => {
      const names: string[] = [];
      for (const record of records) {
        const space = record.indexOf(" ");
        const mode = record.slice(0, space);
        const name = record.slice(space + 1);
        if (name === last || inSkippedDir(name) || mode === GIT_SUBMODULE_MODE) continue;
        last = name;
        if (mode === GIT_LINK_MODE) links.push(name);
        else names.push(name);
      }
      if (names.length > 0) sink(names);
    },
    signal,
  );
  if (tracked !== 0 && !signal.aborted) throw new Error(`git ls-files exited ${String(tracked)}`);
  const untracked: string[] = [];
  const others = await streamGit(
    run,
    root,
    ["ls-files", "-z", "--others", "--exclude-standard"],
    (names) => untracked.push(...names.filter((name) => !inSkippedDir(name))),
    signal,
  );
  if (others !== 0 && !signal.aborted) throw new Error(`git ls-files exited ${String(others)}`);
  for (let at = 0; at < untracked.length && !signal.aborted; at += UNTRACKED_LSTATS) {
    const chunk = untracked.slice(at, at + UNTRACKED_LSTATS);
    const isLink = await Promise.all(
      chunk.map((name) => lstat(join(root, name)).then((info) => info.isSymbolicLink(), () => false)),
    );
    sink(chunk.filter((_, i) => !isLink[i]));
    links.push(...chunk.filter((_, i) => isLink[i]));
  }
  const inside = await Promise.all(links.map((name) => linkInside(root, join(root, name))));
  const kept = links.filter((_, i) => inside[i]);
  if (kept.length > 0) sink(kept);
};

/** Which of `paths` (relative to `root`) git ignores, for deltas in a git root. */
const gitIgnored = async (
  run: GitRun,
  root: string,
  paths: ReadonlyArray<string>,
  signal: AbortSignal,
): Promise<ReadonlySet<string>> => {
  if (paths.length === 0) return new Set();
  const ignored = new Set<string>();
  // check-ignore exits 1 when nothing is ignored; its stdout is the answer either way.
  // --no-index: by pattern alone, 0.01 s instead of about 3 ms a path on a
  // 200k repo. A force-added file under an ignore pattern reads as ignored;
  // it stays in the index if it was there, and the next rebuild restores it.
  await streamGit(run, root, ["check-ignore", "--no-index", "-z", "--stdin"], (names) => {
    for (const name of names) if (name !== "") ignored.add(name);
  }, signal, `${paths.join("\0")}\0`).catch(() => null);
  return ignored;
};

/**
 * Every file under `root`, skipping `SKIPPED_DIRS`, never following a
 * symlinked folder, and listing a symlink only when it resolves inside `within`.
 */
export const walkNames = async (
  root: string,
  sink: NameSink,
  signal: AbortSignal,
  cap = WALK_CAP,
  /** The Files root (a realpath) symlinks must resolve inside; `root` itself unless walking a folder of it. */
  within = root,
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
        } else if (entry.isFile() || (entry.isSymbolicLink() && (await linkInside(within, join(root, path))))) {
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
