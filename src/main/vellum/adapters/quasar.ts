import type { Entity, SnapshotBundle } from "@shared/entities";
import type {
  QuasarSearchMatch,
  QuasarSearchResult,
  QuasarSessionRow,
  QuasarSessionsResult,
} from "@shared/ipc";
import { parseJson, runCli } from "./exec";

// Shape of `quasar projects --limit N`, trimmed to the fields we read.
interface QuasarProjectRow {
  readonly projectKey: string;
  readonly displayName: string;
}

interface QuasarProjectsResponse {
  readonly ok: boolean;
  readonly data?: { readonly rows: ReadonlyArray<QuasarProjectRow> };
}

// `updatedAt` is present on every row but frequently null (some providers,
// e.g. claude-code, never populate it); only fold it into stats when at
// least one row has a real value.
interface QuasarBundleSessionRow {
  readonly updatedAt?: string | null;
}

interface QuasarSessionsResponse {
  readonly ok: boolean;
  readonly data?: { readonly rows: ReadonlyArray<QuasarBundleSessionRow> };
}

const SESSIONS_LIMIT = 500;
const MAX_HINTS = 8;

// Per-key enrichment: fetches the session count for one hinted project key
// and folds it into the entity map. Any failure (bad exit, malformed JSON,
// missing rows) degrades to a no-op — the entity keeps whatever stats it
// already had.
const enrichSessions = async (
  key: string,
  entities: Map<string, Entity>,
  fetchedAt: string,
): Promise<void> => {
  const result = await runCli("quasar", [
    "sessions",
    "--project-key",
    key,
    "--limit",
    String(SESSIONS_LIMIT),
  ]);
  if (!result.ok) return;

  const parsed = parseJson<QuasarSessionsResponse>(result.stdout);
  const rows = parsed?.data?.rows;
  if (!Array.isArray(rows)) return;

  const sessions: string | number = rows.length === SESSIONS_LIMIT ? "500+" : rows.length;

  let lastSession: string | undefined;
  for (const row of rows) {
    if (!row.updatedAt) continue;
    if (!lastSession || row.updatedAt > lastSession) lastSession = row.updatedAt;
  }

  const existing = entities.get(key);
  entities.set(key, {
    source: "quasar",
    key,
    kind: "project",
    title: existing?.title ?? key,
    stats: {
      ...existing?.stats,
      sessions,
      ...(lastSession ? { last_session: lastSession } : {}),
    },
    updatedAt: existing?.updatedAt ?? fetchedAt,
  });
};

export const fetchQuasarBundle = async (hints: ReadonlyArray<string>): Promise<SnapshotBundle> => {
  const fetchedAt = new Date().toISOString();
  const result = await runCli("quasar", ["projects", "--limit", "500"]);
  if (!result.ok) {
    return {
      source: "quasar",
      fetchedAt,
      ok: false,
      error: result.error ?? "quasar CLI failed",
      entities: [],
    };
  }

  const parsed = parseJson<QuasarProjectsResponse>(result.stdout);
  if (!parsed?.ok || !parsed.data) {
    return {
      source: "quasar",
      fetchedAt,
      ok: false,
      error: "unexpected response shape from `quasar projects`",
      entities: [],
    };
  }

  const entities = new Map<string, Entity>();
  for (const row of parsed.data.rows) {
    entities.set(row.projectKey, {
      source: "quasar",
      key: row.projectKey,
      kind: "project",
      title: row.displayName,
      stats: {},
      updatedAt: fetchedAt,
    });
  }

  const hintedKeys = Array.from(new Set(hints)).slice(0, MAX_HINTS);
  await Promise.all(hintedKeys.map((key) => enrichSessions(key, entities, fetchedAt)));

  return { source: "quasar", fetchedAt, ok: true, entities: Array.from(entities.values()) };
};

// --- session browsing (read-only detail view) -------------------------------

// Shape of one row in `quasar sessions --project-key K --limit N`, trimmed to
// the fields the browse view reads. title/agentName/updatedAt are frequently
// null (title IS null for the claude/codex/antigravity providers) — pass
// through as undefined, the UI supplies its own fallback.
interface QuasarSessionListRow {
  readonly sessionId: string;
  readonly provider: string;
  readonly agentName?: string | null;
  readonly title?: string | null;
  readonly startedAt?: string | null;
  readonly updatedAt?: string | null;
  readonly messageCount?: number;
  readonly toolCallCount?: number;
}

interface QuasarSessionListResponse {
  readonly ok: boolean;
  readonly data?: { readonly rows: ReadonlyArray<QuasarSessionListRow> };
}

const sessionSortKey = (row: QuasarSessionListRow): string => row.updatedAt ?? row.startedAt ?? "";

// Sort desc by (updatedAt ?? startedAt ?? ""), then take the requested page.
// ISO timestamps sort correctly as plain strings, so no Date parsing needed.
export const sortAndMapSessions = (
  rows: ReadonlyArray<QuasarSessionListRow>,
  limit: number,
): ReadonlyArray<QuasarSessionRow> =>
  [...rows]
    .sort((a, b) => {
      const ka = sessionSortKey(a);
      const kb = sessionSortKey(b);
      return ka === kb ? 0 : ka < kb ? 1 : -1;
    })
    .slice(0, limit)
    .map((row) => ({
      sessionId: row.sessionId,
      title: row.title ?? undefined,
      provider: row.provider,
      agentName: row.agentName ?? undefined,
      messageCount: row.messageCount ?? 0,
      toolCallCount: row.toolCallCount ?? 0,
      updatedAt: row.updatedAt ?? undefined,
    }));

const SESSION_FETCH_LIMIT = 500;
const DEFAULT_SESSION_LIMIT = 30;

export const fetchQuasarSessionList = async (
  quasarKey: string,
  limit: number = DEFAULT_SESSION_LIMIT,
): Promise<QuasarSessionsResult> => {
  const result = await runCli("quasar", [
    "sessions",
    "--project-key",
    quasarKey,
    "--limit",
    String(SESSION_FETCH_LIMIT),
  ]);
  if (!result.ok) {
    return { ok: false, error: result.error ?? "quasar CLI failed", sessions: [] };
  }

  const parsed = parseJson<QuasarSessionListResponse>(result.stdout);
  const rows = parsed?.data?.rows;
  if (!parsed?.ok || !Array.isArray(rows)) {
    return { ok: false, error: "unexpected response shape from `quasar sessions`", sessions: [] };
  }

  return { ok: true, sessions: sortAndMapSessions(rows, limit) };
};

// --- search (read-only detail view) -----------------------------------------

// Search results live under data.matches, NOT data.rows (unlike `sessions`).
interface QuasarSearchRawMatch {
  readonly score: number;
  readonly row: {
    readonly sessionId: string;
    readonly role: string;
    readonly provider: string;
    readonly text: string;
  };
}

interface QuasarSearchResponse {
  readonly ok: boolean;
  readonly data?: { readonly matches: ReadonlyArray<QuasarSearchRawMatch> };
}

const MAX_EXCERPT_LENGTH = 220;

// Collapse to a single line and cap length; anything trimmed gets an
// ellipsis so the UI can tell a full match from a truncated one.
export const trimExcerpt = (text: string): string => {
  const singleLine = text.replace(/\s+/g, " ").trim();
  return singleLine.length > MAX_EXCERPT_LENGTH
    ? `${singleLine.slice(0, MAX_EXCERPT_LENGTH - 1)}…`
    : singleLine;
};

export const mapSearchMatches = (
  matches: ReadonlyArray<QuasarSearchRawMatch>,
): ReadonlyArray<QuasarSearchMatch> =>
  matches.map((match) => ({
    sessionId: match.row.sessionId,
    role: match.row.role,
    provider: match.row.provider,
    text: trimExcerpt(match.row.text),
    score: match.score,
  }));

const SEARCH_LIMIT = 20;

export const fetchQuasarSearch = async (
  query: string,
  quasarKey?: string,
): Promise<QuasarSearchResult> => {
  const args = ["search", "--query", query, "--mode", "fusion", "--limit", String(SEARCH_LIMIT)];
  if (quasarKey) args.push("--project-key", quasarKey);

  const result = await runCli("quasar", args);
  if (!result.ok) {
    return { ok: false, error: result.error ?? "quasar CLI failed", matches: [] };
  }

  const parsed = parseJson<QuasarSearchResponse>(result.stdout);
  const matches = parsed?.data?.matches;
  if (!parsed?.ok || !Array.isArray(matches)) {
    return { ok: false, error: "unexpected response shape from `quasar search`", matches: [] };
  }

  return { ok: true, matches: mapSearchMatches(matches) };
};
