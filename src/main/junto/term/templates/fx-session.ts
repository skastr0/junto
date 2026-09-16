/**
 * fx session discovery.
 *
 * fx mints its session id and never prints it, so a seat has to find its own.
 * The store makes that easy and exact: `~/.fx/sessions/index.json` lists every
 * session with the `workspace_root` it was started in and a `created_at_ms`.
 * A seat claims the session started in ITS directory after IT spawned, and
 * only when that pairing is unique. Two same-workspace sessions inside the
 * discovery window leave the seat uncaptured rather than binding both seats
 * to the newest id (which would attribute another seat's ACK/idle evidence).
 *
 * The index is the authority when it is readable. When it is missing, older
 * than this schema, or unparsable, discovery falls back to the directory names
 * themselves. Legacy ids lead with the creation timestamp in milliseconds.
 * 0.0.8 short tokens do not; that fallback then uses the directory birthtime
 * (mtime if birthtime is missing) so the time floor still applies. The
 * fallback cannot check the workspace, so it only answers when exactly one
 * candidate qualifies. Indexed and directory paths share that uniqueness law.
 *
 * Read-only throughout: one file read and one readdir, no writes into ~/.fx.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Legacy `<created_ms>-<created_ns>-<hex>`, e.g.
 * `1787761861883-1787761861883720000-7afaf80c8f5acd35`.
 * Still minted on 0.0.7 and still valid on 0.0.8.
 */
const FX_LEGACY_SESSION_ID = /^(\d{13})-\d{15,20}-[0-9a-f]{8,32}$/i;

/**
 * 0.0.8 mints 12-character url-safe tokens: 9 random bytes encoded with
 * `std.base64.url_safe_no_pad` (A-Za-z0-9_-, no padding). Sourced from
 * vercel-labs/fx v0.0.8 `session_layout.zig`; live 0.0.7 homes still use
 * the legacy form only.
 */
const FX_SHORT_SESSION_ID = /^[A-Za-z0-9_-]{12}$/;

export const isFxSessionId = (value: string): boolean => {
  const id = value.trim();
  return FX_LEGACY_SESSION_ID.test(id) || FX_SHORT_SESSION_ID.test(id);
};

/** Creation time carried by a legacy id (ms). Short 0.0.8 tokens have none. */
export const fxSessionIdCreatedAtMs = (value: string): number | undefined => {
  const match = FX_LEGACY_SESSION_ID.exec(value.trim());
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
    if (!isFxSessionId(name)) continue;
    let createdAtMs = fxSessionIdCreatedAtMs(name);
    try {
      const st = statSync(join(root, name));
      if (!st.isDirectory()) continue;
      if (createdAtMs === undefined) {
        createdAtMs = st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs;
      }
    } catch {
      continue;
    }
    if (createdAtMs === undefined || !Number.isFinite(createdAtMs)) continue;
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

/** Claim only when exactly one candidate can be this seat's session. */
const claimIfUnambiguous = (
  candidates: readonly IndexEntry[],
): string | undefined =>
  candidates.length === 1 ? candidates[0]!.id : undefined;

/**
 * The session this seat started, or undefined while there is no unambiguous
 * answer. Undefined is the normal early result — fx writes its store after
 * startup — so callers retry on the seat's own boundaries. It is also the
 * closed answer when more than one session qualifies: there is no newest-
 * session fallback.
 */
export const discoverFxSessionId = (
  input: FxDiscoveryInput,
): string | undefined => {
  const root = fxSessionsRoot(input.home);
  const floor = input.spawnedAtMs - (input.graceMs ?? DEFAULT_GRACE_MS);
  const indexed = readIndex(root);
  if (indexed !== undefined) {
    return claimIfUnambiguous(
      indexed.filter(
        (entry) =>
          entry.workspaceRoot === input.cwd && entry.createdAtMs >= floor,
      ),
    );
  }
  // No usable index: the id's own timestamp is all the evidence there is, and
  // it says nothing about which workspace. Answer only when one session could
  // possibly be this seat's.
  return claimIfUnambiguous(
    readSessionDirs(root).filter((entry) => entry.createdAtMs >= floor),
  );
};
