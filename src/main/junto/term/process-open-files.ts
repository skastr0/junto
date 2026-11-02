/**
 * The regular files a seat's process tree holds open.
 *
 * A harness that keeps its session file open while it runs (Codex) names its
 * own session this way: the file is held by the seat's process and by no
 * other seat's. Read-only; nothing here signals or touches a process.
 *
 * Undefined means the answer could not be had (no lsof, no /proc, a timeout),
 * and a caller falls back to whatever it did without it. An empty list is an
 * answer: the tree holds no regular file yet.
 */

import { execFile } from "node:child_process";
import { existsSync, readdirSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { collectProcessTreePids } from "./devin-session-capture";

const LSOF_TIMEOUT_MS = 5_000;

const lsofBinary = (): string | undefined => {
  for (const candidate of ["/usr/sbin/lsof", "/usr/bin/lsof"]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
};

/** `lsof -Fn` output: one `n<path>` line per open file. */
export const parseLsofNames = (stdout: string): readonly string[] => {
  const names = new Set<string>();
  for (const line of stdout.split("\n")) {
    if (line.startsWith("n/")) names.add(line.slice(1));
  }
  return [...names];
};

/** Linux: each `/proc/<pid>/fd/<n>` links to what it holds. */
const procOpenFiles = (pids: ReadonlySet<number>): readonly string[] => {
  const names = new Set<string>();
  for (const pid of pids) {
    const dir = join("/proc", String(pid), "fd");
    let fds: readonly string[];
    try {
      fds = readdirSync(dir);
    } catch {
      continue;
    }
    for (const fd of fds) {
      try {
        const target = readlinkSync(join(dir, fd));
        if (target.startsWith("/")) names.add(target);
      } catch {
        // closed between the listing and the read
      }
    }
  }
  return [...names];
};

const lsofOpenFiles = (lsof: string, pids: ReadonlySet<number>): Promise<readonly string[] | undefined> =>
  new Promise((resolve) => {
    // -a: only regular files of these pids. lsof exits 1 when a pid has
    // gone; what it printed for the others still stands.
    execFile(
      lsof,
      ["-n", "-a", "-p", [...pids].join(","), "-d", "^txt,^mem", "-Fn"],
      { timeout: LSOF_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => {
        if (error && (typeof stdout !== "string" || stdout.length === 0)) {
          resolve(typeof (error as { code?: unknown }).code === "number" ? [] : undefined);
          return;
        }
        resolve(parseLsofNames(stdout));
      },
    );
  });

export type OpenFilesOf = (rootPid: number) => Promise<readonly string[] | undefined>;

/** Files held open by this process and everything under it. */
export const openFilesOfProcessTree: OpenFilesOf = async (rootPid) => {
  if (!Number.isInteger(rootPid) || rootPid <= 0) return undefined;
  const pids = await collectProcessTreePids(rootPid);
  if (existsSync("/proc/self/fd")) return procOpenFiles(pids);
  const lsof = lsofBinary();
  return lsof === undefined ? undefined : lsofOpenFiles(lsof, pids);
};
