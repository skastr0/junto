/**
 * Muse session capture.
 *
 * Muse mints its own session id and never prints it: a live PTY capture of the
 * 0.2.1 TUI carries no UUID anywhere in its output, and its OSC title is the
 * bare workspace name. The id exists only as the name of a directory Muse
 * writes for the session:
 *
 *   ~/.local/share/muse/sessions/<yyyy>/<mm>/<dd>/<uuid>/session.jsonl
 *
 * whose first `runtime.session.metadata` record carries the `workspace_root`
 * the session was started in. 1.1.1 parent logs often prepend a
 * `retained_frame` / `session_permission_transaction` wrapper, so capture
 * scans until that metadata record (stream.id must equal the directory name,
 * `recorded_at` is microseconds). That pairing — a workspace and a start
 * time — is what makes capture safe: a seat claims the session that belongs
 * to ITS workspace and started after IT spawned, not merely the newest one
 * on the machine, which on a busy factory could belong to another seat.
 *
 * Read-only. Nothing here writes to Muse's store, and no other file under it
 * is opened: one jsonl per candidate directory, scanned only until metadata.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Muse session ids are plain UUIDs; the directory name IS the id. */
const SESSION_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isMuseSessionId = (value: string): boolean =>
  SESSION_UUID.test(value.trim());

export const museSessionsRoot = (home: string): string =>
  join(home, ".local", "share", "muse", "sessions");

type Candidate = {
  readonly sessionId: string;
  readonly recordedAtMs: number;
  readonly workspaceRoot: string | undefined;
};

const readDirNames = (dir: string): readonly string[] => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/**
 * First `runtime.session.metadata` record in a session log, as the two fields
 * capture needs. 1.1.1 parent logs prepend `retained_frame` wrappers, so this
 * scans past non-metadata lines instead of trusting line 1.
 *
 * `recorded_at` is microseconds since the epoch — verified against live 0.2.1
 * and 1.1.1 session files. It is normalized to milliseconds here so callers
 * compare it with ordinary clock values and cannot accidentally compare
 * across units.
 */
const parseMetadataCandidate = (
  sessionId: string,
  line: string,
): Candidate | undefined => {
  if (!line.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  const record = parsed as {
    readonly payload_type?: unknown;
    readonly stream?: { readonly id?: unknown };
    readonly recorded_at?: unknown;
    readonly payload?: { readonly record?: { readonly workspace_root?: unknown } };
  };
  if (record.payload_type !== "runtime.session.metadata") return undefined;
  const streamId =
    typeof record.stream?.id === "string" ? record.stream.id : undefined;
  // The directory name is the id; the stream id must agree or this is not a
  // session log we understand.
  if (streamId !== sessionId) return undefined;
  const micros =
    typeof record.recorded_at === "number" && Number.isFinite(record.recorded_at)
      ? record.recorded_at
      : undefined;
  if (micros === undefined) return undefined;
  const workspaceRoot = record.payload?.record?.workspace_root;
  return {
    sessionId,
    recordedAtMs: Math.floor(micros / 1000),
    workspaceRoot: typeof workspaceRoot === "string" ? workspaceRoot : undefined,
  };
};

const readCandidate = (
  sessionsDir: string,
  sessionId: string,
): Candidate | undefined => {
  let raw: string;
  try {
    raw = readFileSync(join(sessionsDir, sessionId, "session.jsonl"), "utf8");
  } catch {
    return undefined;
  }
  for (const line of raw.split("\n")) {
    const candidate = parseMetadataCandidate(sessionId, line);
    if (candidate) return candidate;
  }
  return undefined;
};

/** Every session directory in the date-nested store, unordered. */
const walkSessions = (root: string): readonly Candidate[] => {
  const out: Candidate[] = [];
  for (const year of readDirNames(root)) {
    const yearDir = join(root, year);
    if (!isDirectory(yearDir)) continue;
    for (const month of readDirNames(yearDir)) {
      const monthDir = join(yearDir, month);
      if (!isDirectory(monthDir)) continue;
      for (const day of readDirNames(monthDir)) {
        const dayDir = join(monthDir, day);
        if (!isDirectory(dayDir)) continue;
        for (const sessionId of readDirNames(dayDir)) {
          if (!isMuseSessionId(sessionId)) continue;
          const candidate = readCandidate(dayDir, sessionId);
          if (candidate) out.push(candidate);
        }
      }
    }
  }
  return out;
};

export type MuseCaptureInput = {
  /** The seat's working directory — must equal the session's workspace_root. */
  readonly cwd: string;
  /** Epoch ms the seat's PTY started. Older sessions are not this seat's. */
  readonly spawnedAtMs: number;
  readonly home: string;
  /**
   * Tolerance for the gap between "we recorded the spawn" and "Muse wrote its
   * first record". Small on purpose: a wide window is how a seat steals the
   * session of the seat that started just before it.
   */
  readonly graceMs?: number;
};

const DEFAULT_GRACE_MS = 2_000;

/**
 * The session this seat started, or undefined while Muse has not written one.
 *
 * Undefined is the normal early answer, not a failure: the store is written
 * asynchronously, so a caller polls the seat's own boundaries (a state change,
 * a finished turn) rather than blocking a spawn on it.
 */
export const captureMuseSessionId = (
  input: MuseCaptureInput,
): string | undefined => {
  const floor = input.spawnedAtMs - (input.graceMs ?? DEFAULT_GRACE_MS);
  const mine = walkSessions(museSessionsRoot(input.home))
    .filter(
      (candidate) =>
        candidate.workspaceRoot === input.cwd && candidate.recordedAtMs >= floor,
    )
    // Newest wins only among sessions that already passed both filters, so a
    // re-spawn in the same workspace claims its own generation.
    .sort((a, b) => b.recordedAtMs - a.recordedAtMs);
  return mine[0]?.sessionId;
};
