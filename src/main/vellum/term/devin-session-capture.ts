/**
 * Devin session-id capture — the lockfile names the session, the process tree
 * says which lock is ours.
 *
 * Devin mints a slug id (`ionized-pluto`) and never prints it, so the PTY-text
 * capture path that serves Codex and Kimi finds nothing. What it does do at
 * startup is write `session_locks/<slug>.lock` containing a bare PID.
 *
 * Two facts, both probed on devin 3000.4.16, shape this module:
 *
 * - **The lock PID is not the PID Vellum Command spawned.** `~/.local/bin/devin`
 *   is a shim that runs the versioned binary as a child, and the CHILD writes
 *   the lock. Matching the spawned pid alone never hits; the match is against
 *   the spawned process's descendants.
 * - **A lock is not a resumable session.** Locks are never removed, so 48 of
 *   them name dead processes, and `devin -r <slug>` on a lock-only slug answers
 *   `No session found matching '<slug>'`. The lock is a DISCOVERY channel; the
 *   proof that the id can be resumed is the `sessions` row, which appears only
 *   after the session's first real turn (see `session-existence`).
 *
 * Everything here is read-only: no lock is written, removed, or repaired.
 */

import { execFile } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Devin slugs are lower-case hyphenated words — never a path fragment. */
const DEVIN_SESSION_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const isDevinSessionSlug = (value: string): boolean => {
  const slug = value.trim();
  return slug.length > 0 && slug.length <= 64 && DEVIN_SESSION_SLUG.test(slug);
};

/** `~/.local/share/devin/cli` — the CLI's own state root. */
export const devinCliRoot = (home: string = homedir()): string =>
  join(home, ".local", "share", "devin", "cli");

export const devinSessionLocksDir = (home: string = homedir()): string =>
  join(devinCliRoot(home), "session_locks");

/** One lock file: `<slug>.lock` holding a bare PID. */
type DevinLock = {
  readonly sessionId: string;
  readonly pid: number;
  /** Lock mtime — the tiebreak when a dead lock's PID has been recycled. */
  readonly mtimeMs: number;
};

const readLock = (dir: string, name: string): DevinLock | undefined => {
  if (!name.endsWith(".lock")) return undefined;
  const sessionId = name.slice(0, -".lock".length);
  if (!isDevinSessionSlug(sessionId)) return undefined;
  const path = join(dir, name);
  try {
    const pid = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
    if (!Number.isInteger(pid) || pid <= 0) return undefined;
    return { sessionId, pid, mtimeMs: statSync(path).mtimeMs };
  } catch {
    return undefined;
  }
};

/** Every readable lock, newest first. */
export const readDevinLocks = (
  home: string = homedir(),
): readonly DevinLock[] => {
  const dir = devinSessionLocksDir(home);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const locks: DevinLock[] = [];
  for (const name of names) {
    const lock = readLock(dir, name);
    if (lock) locks.push(lock);
  }
  return locks.sort((a, b) => b.mtimeMs - a.mtimeMs);
};

/**
 * The session held by one of these PIDs. Newest lock wins: stale locks are
 * never cleaned, so a long-dead session can hold a PID the OS has since
 * recycled onto our own process tree.
 */
export const devinSessionIdForPids = (
  pids: ReadonlySet<number>,
  home: string = homedir(),
): string | undefined => {
  if (pids.size === 0) return undefined;
  for (const lock of readDevinLocks(home)) {
    if (pids.has(lock.pid)) return lock.sessionId;
  }
  return undefined;
};

/**
 * The spawned process and everything under it. Devin's launcher shim means the
 * lock-writing process is a child, and a future launcher could nest deeper, so
 * this walks the whole tree rather than checking one generation.
 */
export const collectProcessTreePids = async (
  rootPid: number,
  run: (
    file: string,
    args: readonly string[],
  ) => Promise<{ stdout: string }> = (file, args) =>
    execFileAsync(file, [...args]),
): Promise<ReadonlySet<number>> => {
  const tree = new Set<number>([rootPid]);
  if (!Number.isInteger(rootPid) || rootPid <= 0) return tree;
  let stdout: string;
  try {
    ({ stdout } = await run("ps", ["-eo", "pid=,ppid="]));
  } catch {
    return tree;
  }
  const children = new Map<number, number[]>();
  for (const line of stdout.split("\n")) {
    const [pidText, ppidText] = line.trim().split(/\s+/);
    const pid = Number.parseInt(pidText ?? "", 10);
    const ppid = Number.parseInt(ppidText ?? "", 10);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    const siblings = children.get(ppid);
    if (siblings) siblings.push(pid);
    else children.set(ppid, [pid]);
  }
  const queue = [rootPid];
  while (queue.length > 0) {
    const parent = queue.pop()!;
    for (const child of children.get(parent) ?? []) {
      if (tree.has(child)) continue;
      tree.add(child);
      queue.push(child);
    }
  }
  return tree;
};

/**
 * Discovery ladder. The lock lands within a second of spawn, but the launcher
 * shim, a version check, or a slow disk can delay it — and unlike the proof
 * ladder there is nothing to lose by asking again a few seconds later.
 */
export const DEVIN_DISCOVERY_DELAYS_MS: readonly number[] = [
  250, 750, 2_000, 5_000,
];

const sleep = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((r) => setTimeout(r, ms).unref?.());

/**
 * Find the session id a freshly spawned Devin seat is running under, or
 * undefined when the ladder runs out. Never throws: this is recovery for the
 * cold-resume loop, never a spawn gate.
 */
export const discoverDevinSessionId = async (input: {
  readonly pid: number;
  readonly home?: string;
  readonly delays?: readonly number[];
  readonly stillRunning?: () => boolean;
}): Promise<string | undefined> => {
  const home = input.home ?? homedir();
  for (const delay of input.delays ?? DEVIN_DISCOVERY_DELAYS_MS) {
    await sleep(delay);
    if (input.stillRunning && !input.stillRunning()) return undefined;
    try {
      const pids = await collectProcessTreePids(input.pid);
      const sessionId = devinSessionIdForPids(pids, home);
      if (sessionId) return sessionId;
    } catch {
      // keep laddering
    }
  }
  return undefined;
};

/**
 * Proof ladder for a discovered Devin id — deliberately longer than the shared
 * one. The `sessions` row that makes an id resumable is written after the first
 * real turn, which is the operator (or the seat's own doctrine turn) typing,
 * not something that happens inside the first eight seconds. Attempts stop at
 * the first proof, and an id that is never proven is simply never stored.
 */
export const DEVIN_PROOF_RETRY_DELAYS_MS: readonly number[] = [
  0, 2_000, 5_000, 15_000, 30_000, 60_000, 120_000,
];
