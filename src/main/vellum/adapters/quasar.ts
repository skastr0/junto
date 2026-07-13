import type { Entity, SnapshotBundle } from "@shared/entities";
import type {
  QuasarSearchMatch,
  QuasarSearchResult,
  QuasarSessionDetail,
  QuasarSessionDetailResult,
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

// The quasar server already returns rows in most-recent-first order. Most
// providers (claude/codex/antigravity) leave updatedAt/startedAt null, so a
// re-sort keyed on those fields floats the one provider that populates them
// (kimi) to the top and sinks everyone else — the UI looked like "all
// sessions are kimi". Preserve server order; just take the first N.
export const sortAndMapSessions = (
  rows: ReadonlyArray<QuasarSessionListRow>,
  limit: number,
): ReadonlyArray<QuasarSessionRow> =>
  rows.slice(0, limit).map((row) => ({
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

// --- session detail (reader modal) ------------------------------------------
//
// Built from two CLI calls: `quasar messages` (per-message ts is reliable
// even when the session-level updatedAt/startedAt is null for a provider)
// and `quasar tool-calls` (tool usage stats). Never throws — a failing/
// malformed CLI call degrades to ok:false.

interface QuasarDetailMessageRow {
  readonly role: string;
  readonly text?: string | null;
  readonly ts?: string | null;
}

interface QuasarMessagesResponse {
  readonly ok: boolean;
  readonly data?: { readonly rows: ReadonlyArray<QuasarDetailMessageRow> };
}

interface QuasarDetailToolCallRow {
  readonly toolName?: string | null;
}

interface QuasarToolCallsResponse {
  readonly ok: boolean;
  readonly data?: { readonly rows: ReadonlyArray<QuasarDetailToolCallRow> };
}

const FIRST_USER_MAX_LENGTH = 600;
const LAST_ASSISTANT_MAX_LENGTH = 900;
const TOP_TOOLS_COUNT = 3;
const SESSION_DETAIL_FETCH_LIMIT = 500;

const trimTo = (text: string, maxLength: number): string => {
  const trimmed = text.trim();
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength - 1)}…` : trimmed;
};

// firstUser = first user-role message; lastAssistant = last assistant-role
// message (keeps overwriting as it walks forward); startedAt/endedAt = min/
// max ts across every row, so they still resolve even when firstUser or
// lastAssistant is undefined (e.g. a tool-only session).
export const buildSessionBookends = (
  rows: ReadonlyArray<QuasarDetailMessageRow>,
): { firstUser?: string; lastAssistant?: string; startedAt?: string; endedAt?: string } => {
  let firstUser: string | undefined;
  let lastAssistant: string | undefined;
  let startedAt: string | undefined;
  let endedAt: string | undefined;

  for (const row of rows) {
    if (row.ts) {
      if (!startedAt || row.ts < startedAt) startedAt = row.ts;
      if (!endedAt || row.ts > endedAt) endedAt = row.ts;
    }
    if (!firstUser && row.role === "user" && row.text) {
      firstUser = trimTo(row.text, FIRST_USER_MAX_LENGTH);
    }
    if (row.role === "assistant" && row.text) {
      lastAssistant = trimTo(row.text, LAST_ASSISTANT_MAX_LENGTH);
    }
  }

  return { firstUser, lastAssistant, startedAt, endedAt };
};

export const topToolNames = (
  rows: ReadonlyArray<QuasarDetailToolCallRow>,
  count: number = TOP_TOOLS_COUNT,
): ReadonlyArray<string> => {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (!row.toolName) continue;
    counts.set(row.toolName, (counts.get(row.toolName) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, count)
    .map(([name]) => name);
};

// sessionId is "<provider>:<hash>" (e.g. "codex:725dff0e..."); the prefix
// before the first colon is the provider.
export const parseProviderFromSessionId = (sessionId: string): string => {
  const separatorIndex = sessionId.indexOf(":");
  return separatorIndex === -1 ? sessionId : sessionId.slice(0, separatorIndex);
};

export const fetchQuasarSessionDetail = async (sessionId: string): Promise<QuasarSessionDetailResult> => {
  const [messagesResult, toolCallsResult] = await Promise.all([
    runCli("quasar", ["messages", "--session-id", sessionId, "--limit", String(SESSION_DETAIL_FETCH_LIMIT)]),
    runCli("quasar", ["tool-calls", "--session-id", sessionId, "--limit", String(SESSION_DETAIL_FETCH_LIMIT)]),
  ]);

  if (!messagesResult.ok) {
    return { ok: false, error: messagesResult.error ?? "quasar messages CLI failed" };
  }

  const messagesParsed = parseJson<QuasarMessagesResponse>(messagesResult.stdout);
  const messageRows = messagesParsed?.data?.rows;
  if (!messagesParsed?.ok || !Array.isArray(messageRows)) {
    return { ok: false, error: "unexpected response shape from `quasar messages`" };
  }

  // Tool-call stats are best-effort: a failing/malformed `tool-calls` call
  // degrades to empty tool stats rather than failing the whole detail — the
  // transcript bookends are still useful without it.
  const toolCallsParsed = toolCallsResult.ok
    ? parseJson<QuasarToolCallsResponse>(toolCallsResult.stdout)
    : undefined;
  const toolRows = toolCallsParsed?.data?.rows ?? [];

  const bookends = buildSessionBookends(messageRows);

  const detail: QuasarSessionDetail = {
    sessionId,
    provider: parseProviderFromSessionId(sessionId),
    title: undefined,
    messageCount: messageRows.length,
    toolCallCount: toolRows.length,
    firstUser: bookends.firstUser,
    lastAssistant: bookends.lastAssistant,
    startedAt: bookends.startedAt,
    endedAt: bookends.endedAt,
    topTools: topToolNames(toolRows),
  };

  return { ok: true, detail };
};
