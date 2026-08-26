/**
 * fx session discovery.
 *
 * fx mints its session id and never prints it, so a seat has to find its own.
 * The store makes that easy and exact: `~/.fx/sessions/index.json` lists every
 * session with the `workspace_root` it was started in and a `created_at_ms`,
 * which is the same workspace-and-time pairing Muse capture uses — a seat
 * claims the session started in ITS directory after IT spawned, never merely
 * the newest one on the machine.
 *
 * The index is the authority when it is readable. When it is missing, older
 * than this schema, or unparsable, discovery falls back to the directory names
 * themselves: they lead with the creation timestamp in milliseconds, which is
 * enough to apply the time floor. That fallback cannot check the workspace, so
 * it only answers when exactly one candidate qualifies — an ambiguous machine
 * leaves the seat honestly uncaptured rather than guessing.
 *
 * Read-only throughout: one file read and one readdir, no writes into ~/.fx.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * `<created_ms>-<created_ns>-<hex>`, e.g.
 * `1787761861883-1787761861883720000-7afaf80c8f5acd35`.
 */
const FX_SESSION_ID = /^(\d{13})-\d{15,20}-[0-9a-f]{8,32}$/i;

export const isFxSessionId = (value: string): boolean =>
  FX_SESSION_ID.test(value.trim());

/** Creation time carried by the id itself (ms), or undefined if not an id. */
export const fxSessionIdCreatedAtMs = (value: string): number | undefined => {
  const match = FX_SESSION_ID.exec(value.trim());
  if (!match) return undefined;
  const ms = Number(match[1]);
  return Number.isFinite(ms) ? ms : undefined;
};

export const fxSessionsRoot = (home: string): string =>
  join(home, ".fx", "sessions");

/** The index's schema this reader was written against. */
export const FX_INDEX_SCHEMA_VERSION = 3;

type IndexEntry = {
  readonly id: string;
  readonly createdAtMs: number;
  readonly workspaceRoot: string | undefined;
};

const readIndex = (root: string): readonly IndexEntry[] | undefined => {
  let raw: string;
  try {
    raw = readFileSync(join(root, "index.json"), "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  const doc = parsed as {
    readonly schema_version?: unknown;
    readonly sessions?: unknown;
  };
  // A newer schema may mean these fields moved. Fall back rather than read a
  // shape this code was never checked against.
  if (doc.schema_version !== FX_INDEX_SCHEMA_VERSION) return undefined;
  if (!Array.isArray(doc.sessions)) return undefined;
  const out: IndexEntry[] = [];
  for (const entry of doc.sessions) {
    if (entry === null || typeof entry !== "object") continue;
    const row = entry as {
      readonly id?: unknown;
      readonly created_at_ms?: unknown;
      readonly workspace_root?: unknown;
    };
    if (typeof row.id !== "string" || !isFxSessionId(row.id)) continue;
    const createdAtMs =
      typeof row.created_at_ms === "number" && Number.isFinite(row.created_at_ms)
        ? row.created_at_ms
        : fxSessionIdCreatedAtMs(row.id);
    if (createdAtMs === undefined) continue;
    out.push({
      id: row.id,
      createdAtMs,
      workspaceRoot:
        typeof row.workspace_root === "string" ? row.workspace_root : undefined,
    });
  }
  return out;
};

const readSessionDirs = (root: string): readonly IndexEntry[] => {
  let names: readonly string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const out: IndexEntry[] = [];
  for (const name of names) {
    const createdAtMs = fxSessionIdCreatedAtMs(name);
    if (createdAtMs === undefined) continue;
    try {
      if (!statSync(join(root, name)).isDirectory()) continue;
    } catch {
      continue;
    }
    out.push({ id: name, createdAtMs, workspaceRoot: undefined });
  }
  return out;
};

export type FxDiscoveryInput = {
  /** The seat's working directory — matched against `workspace_root`. */
  readonly cwd: string;
  /** Epoch ms the seat's PTY started. */
  readonly spawnedAtMs: number;
  readonly home: string;
  /** Tolerance between recording the spawn and fx writing its store. */
  readonly graceMs?: number;
};

const DEFAULT_GRACE_MS = 2_000;

/**
 * The session this seat started, or undefined while there is no unambiguous
 * answer. Undefined is the normal early result — fx writes its store after
 * startup — so callers retry on the seat's own boundaries.
 */
export const discoverFxSessionId = (
  input: FxDiscoveryInput,
): string | undefined => {
  const root = fxSessionsRoot(input.home);
  const floor = input.spawnedAtMs - (input.graceMs ?? DEFAULT_GRACE_MS);
  const indexed = readIndex(root);
  if (indexed !== undefined) {
    const mine = indexed
      .filter(
        (entry) =>
          entry.workspaceRoot === input.cwd && entry.createdAtMs >= floor,
      )
      .sort((a, b) => b.createdAtMs - a.createdAtMs);
    return mine[0]?.id;
  }
  // No usable index: the id's own timestamp is all the evidence there is, and
  // it says nothing about which workspace. Answer only when one session could
  // possibly be this seat's.
  const candidates = readSessionDirs(root).filter(
    (entry) => entry.createdAtMs >= floor,
  );
  return candidates.length === 1 ? candidates[0]!.id : undefined;
};
