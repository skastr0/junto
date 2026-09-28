/**
 * Codex session discovery.
 *
 * Codex mints its thread id and the TUI never prints it (0.157.1), so a seat
 * finds its own the way Muse, fx and omp seats do: in the rollout Codex writes
 * once the first turn starts.
 *
 *   ~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<local ts>-<thread id>.jsonl
 *
 * The first line is `session_meta`; its payload carries the thread `id`, the
 * workspace `cwd`, the creation `timestamp`, and `thread_source` ("user" for
 * the operator's root thread, anything else for a thread Codex spawned
 * itself). The day directories are local dates.
 *
 * Read-only: readdir of the day directories the seat has lived through, and
 * the first line of each rollout touched since it spawned.
 */

import { closeSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";

const ROLLOUT_FILE = /^rollout-.+\.jsonl$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** `base_instructions` rides on the first line; 20KB today. */
const FIRST_LINE_MAX_BYTES = 1024 * 1024;
const DEFAULT_GRACE_MS = 2_000;
const DAY_MS = 86_400_000;

export const isCodexSessionId = (value: string): boolean => UUID.test(value.trim());

export type CodexDiscoveryInput = {
  readonly cwd: string;
  readonly spawnedAtMs: number;
  readonly home: string;
  readonly nowMs?: number;
  readonly graceMs?: number;
};

const canonical = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return path.replace(/\/+$/, "");
  }
};

const firstLine = (path: string): string | undefined => {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const chunk = Buffer.alloc(64 * 1024);
    const parts: Buffer[] = [];
    let total = 0;
    while (total < FIRST_LINE_MAX_BYTES) {
      const read = readSync(fd, chunk, 0, chunk.length, total);
      if (read <= 0) break;
      const slice = chunk.subarray(0, read);
      const newline = slice.indexOf(0x0a);
      if (newline >= 0) {
        parts.push(Buffer.from(slice.subarray(0, newline)));
        return Buffer.concat(parts).toString("utf8");
      }
      parts.push(Buffer.from(slice));
      total += read;
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
};

const dayDirs = (root: string, fromMs: number, toMs: number): string[] => {
  const dirs: string[] = [];
  const pad = (n: number): string => String(n).padStart(2, "0");
  for (let at = fromMs; at <= toMs + DAY_MS; at += DAY_MS) {
    const d = new Date(Math.min(at, toMs));
    const dir = join(root, String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()));
    if (!dirs.includes(dir)) dirs.push(dir);
    if (at >= toMs) break;
  }
  return dirs;
};

type Meta = { readonly id: string; readonly cwd: string; readonly createdMs: number; readonly root: boolean };

const readMeta = (path: string): Meta | undefined => {
  const line = firstLine(path);
  if (line === undefined) return undefined;
  try {
    const row = JSON.parse(line) as {
      type?: unknown;
      payload?: { id?: unknown; cwd?: unknown; timestamp?: unknown; thread_source?: unknown };
    };
    const p = row.payload;
    if (row.type !== "session_meta" || !p) return undefined;
    if (typeof p.id !== "string" || !isCodexSessionId(p.id)) return undefined;
    if (typeof p.cwd !== "string" || typeof p.timestamp !== "string") return undefined;
    const createdMs = Date.parse(p.timestamp);
    if (!Number.isFinite(createdMs)) return undefined;
    return {
      id: p.id,
      cwd: p.cwd,
      createdMs,
      root: p.thread_source === undefined || p.thread_source === "user",
    };
  } catch {
    return undefined;
  }
};

/**
 * The root thread this seat started, or undefined while Codex has written
 * none. A rollout from before the spawn, from another workspace, or a thread
 * Codex spawned itself is never this seat's; among the rest the earliest wins,
 * because the operator's thread is created before any it spawns.
 */
export const discoverCodexSessionId = (input: CodexDiscoveryInput): string | undefined => {
  const floor = input.spawnedAtMs - (input.graceMs ?? DEFAULT_GRACE_MS);
  const cwd = canonical(input.cwd);
  const root = join(input.home, ".codex", "sessions");
  let best: Meta | undefined;
  for (const dir of dayDirs(root, floor, input.nowMs ?? Date.now())) {
    let names: readonly string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!ROLLOUT_FILE.test(name)) continue;
      const path = join(dir, name);
      try {
        if (statSync(path).mtimeMs < floor) continue;
      } catch {
        continue;
      }
      const meta = readMeta(path);
      if (!meta || !meta.root || meta.createdMs < floor) continue;
      if (canonical(meta.cwd) !== cwd) continue;
      if (!best || meta.createdMs < best.createdMs) best = meta;
    }
  }
  return best?.id;
};
