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
 * the operator's root thread). A thread Codex spawned itself names its parent
 * under `source.subagent`. The day directories are local dates.
 *
 * Read-only: readdir of the day directories the seat has lived through, and
 * the first line of each rollout touched since it spawned.
 */

import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  discoverSpawnedSession,
  isUuid,
  type SpawnedSessionCandidate,
  type SpawnedSessionInput,
  type SpawnedSessionStore,
} from "./spawned-session";

const ROLLOUT_FILE = /^rollout-.+\.jsonl$/;
/** `base_instructions` rides on the first line; 20KB today. */
const FIRST_LINE_MAX_BYTES = 1024 * 1024;
const DAY_MS = 86_400_000;

export const isCodexSessionId = isUuid;

export type CodexDiscoveryInput = SpawnedSessionInput;

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
      payload?: {
        id?: unknown;
        cwd?: unknown;
        timestamp?: unknown;
        thread_source?: unknown;
        source?: unknown;
      };
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
      // A spawned thread names its parent under `source.subagent`.
      root:
        (p.thread_source === undefined || p.thread_source === "user") &&
        !(typeof p.source === "object" && p.source !== null && "subagent" in p.source),
    };
  } catch {
    return undefined;
  }
};

/**
 * Codex's store: every root rollout touched since the floor, in the day
 * directories the seat has lived through. A thread Codex spawned itself is
 * never this seat's; among the rest the earliest wins, because the operator's
 * thread is created before any it spawns.
 */
export const CODEX_SPAWNED_SESSIONS: SpawnedSessionStore = {
  isSessionId: isCodexSessionId,
  sameWorkspace: "real",
  pick: "earliest",
  scan: ({ home, floorMs, nowMs }) => {
    const candidates: SpawnedSessionCandidate[] = [];
    for (const dir of dayDirs(join(home, ".codex", "sessions"), floorMs, nowMs)) {
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
          if (statSync(path).mtimeMs < floorMs) continue;
        } catch {
          continue;
        }
        const meta = readMeta(path);
        if (!meta || !meta.root) continue;
        candidates.push({ id: meta.id, startedAtMs: meta.createdMs, workspace: meta.cwd });
      }
    }
    return { candidates, workspace: "recorded" };
  },
};

/** The root thread this seat started, or undefined while Codex has written none. */
export const discoverCodexSessionId = (input: CodexDiscoveryInput): string | undefined =>
  discoverSpawnedSession(CODEX_SPAWNED_SESSIONS, input);
