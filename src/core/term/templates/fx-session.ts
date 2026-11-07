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
import {
  discoverSpawnedSession,
  type SpawnedSessionCandidate,
  type SpawnedSessionInput,
  type SpawnedSessionStore,
} from "./spawned-session";

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

const readIndex = (root: string): readonly SpawnedSessionCandidate[] | undefined => {
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
  const out: SpawnedSessionCandidate[] = [];
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
      startedAtMs: createdAtMs,
      ...(typeof row.workspace_root === "string" ? { workspace: row.workspace_root } : {}),
    });
  }
  return out;
};

const readSessionDirs = (root: string): readonly SpawnedSessionCandidate[] => {
  let names: readonly string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const out: SpawnedSessionCandidate[] = [];
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
    out.push({ id: name, startedAtMs: createdAtMs });
  }
  return out;
};

export type FxDiscoveryInput = SpawnedSessionInput;

/**
 * fx's store. The index names each session's workspace; without a usable
 * index the id's own timestamp is all the evidence there is, and it says
 * nothing about which workspace. Either way fx claims only when exactly one
 * session can be this seat's: there is no newest-session fallback.
 */
export const FX_SPAWNED_SESSIONS: SpawnedSessionStore = {
  isSessionId: isFxSessionId,
  sameWorkspace: "exact",
  pick: "unique",
  scan: ({ home }) => {
    const root = fxSessionsRoot(home);
    const indexed = readIndex(root);
    return indexed !== undefined
      ? { candidates: indexed, workspace: "recorded" }
      : { candidates: readSessionDirs(root), workspace: "scoped" };
  },
};

/**
 * The session this seat started, or undefined while there is no unambiguous
 * answer: fx writes its store after startup, and two qualifying sessions are
 * the closed answer.
 */
export const discoverFxSessionId = (input: FxDiscoveryInput): string | undefined =>
  discoverSpawnedSession(FX_SPAWNED_SESSIONS, input);
