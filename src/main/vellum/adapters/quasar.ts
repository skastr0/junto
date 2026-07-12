import type { Entity, SnapshotBundle } from "@shared/entities";
import { parseSessionKey, sessionKey } from "@shared/refs";
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
interface QuasarSessionRow {
  readonly updatedAt?: string | null;
}

interface QuasarSessionsResponse {
  readonly ok: boolean;
  readonly data?: { readonly rows: ReadonlyArray<QuasarSessionRow> };
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

// --- Session-level drill-down ------------------------------------------------
//
// Sessions have no REST board the way tower glyphs/signals do (see
// tower.ts's resolveTowerGlyphHints/resolveTowerSignalHints) — the only
// source is the `quasar sessions`/`tool-calls`/`messages` CLI itself, keyed
// by the *quasar* project key (e.g. "git:github.com/skastr0/prism"), not the
// tower project name a canvas is exploded against. resolveQuasarKey bridges
// the two for the explode CLI; probeSessionProjectKey bridges the reverse
// direction (session id -> project key) for hydration below.

interface QuasarSessionRowDetail {
  readonly sessionId: string;
  readonly projectKey: string;
  readonly provider: string;
  readonly agentName?: string | null;
  readonly title?: string | null;
  readonly startedAt?: string | null;
  readonly updatedAt?: string | null;
  readonly messageCount: number;
  readonly toolCallCount: number;
}

interface QuasarSessionListResponse {
  readonly ok: boolean;
  readonly data?: { readonly rows: ReadonlyArray<QuasarSessionRowDetail> };
}

export interface QuasarSession {
  readonly sessionId: string;
  readonly provider: string;
  readonly agentName?: string;
  readonly title?: string;
  readonly updatedAt: string;
  readonly messageCount: number;
  readonly toolCallCount: number;
}

export interface FetchProjectSessionsResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly sessions: ReadonlyArray<QuasarSession>;
}

// Pool size for the underlying `quasar sessions` fetch: large projects
// (prism: 500+) need a wide pool to sort/cap locally, since the CLI makes no
// "most recent N across every provider" ordering guarantee on its own.
const SESSION_POOL_LIMIT = 500;

const sessionSortKey = (row: { updatedAt?: string | null; startedAt?: string | null }): string =>
  row.updatedAt ?? row.startedAt ?? "";

const toQuasarSession = (row: QuasarSessionRowDetail, fetchedAt: string): QuasarSession => ({
  sessionId: row.sessionId,
  provider: row.provider,
  ...(row.agentName ? { agentName: row.agentName } : {}),
  ...(row.title ? { title: row.title } : {}),
  updatedAt: row.updatedAt ?? row.startedAt ?? fetchedAt,
  messageCount: row.messageCount,
  toolCallCount: row.toolCallCount,
});

// Fetches one quasar project's sessions, most-recently-updated first, capped
// to `limit`. Never throws: a CLI failure or malformed response folds into
// ok:false. `quasarKey` is the quasar projectKey (e.g.
// "git:github.com/skastr0/prism"), not a tower project name — see
// resolveQuasarKey.
export const fetchProjectSessions = async (
  quasarKey: string,
  limit = 20,
): Promise<FetchProjectSessionsResult> => {
  const fetchedAt = new Date().toISOString();
  const result = await runCli("quasar", [
    "sessions",
    "--project-key",
    quasarKey,
    "--limit",
    String(SESSION_POOL_LIMIT),
  ]);
  if (!result.ok) {
    return { ok: false, error: result.error ?? "quasar CLI failed", sessions: [] };
  }

  const parsed = parseJson<QuasarSessionListResponse>(result.stdout);
  if (!parsed?.ok || !parsed.data) {
    return { ok: false, error: "unexpected response shape from `quasar sessions`", sessions: [] };
  }

  const sorted = [...parsed.data.rows].sort((a, b) =>
    sessionSortKey(b).localeCompare(sessionSortKey(a)),
  );
  return { ok: true, sessions: sorted.slice(0, limit).map((row) => toQuasarSession(row, fetchedAt)) };
};

// Resolves a display/project name (as passed to `scripts/explode.ts`, e.g.
// "prism") to the quasar projectKey quasar's own commands need (e.g.
// "git:github.com/skastr0/prism"). Case-insensitive match against `quasar
// projects`; when several rows share a displayName (a git-tracked project
// alongside stale path-based dupes for the same repo), the "git:" key wins
// since it's the canonical, stable one. Returns undefined (not an error) when
// no quasar project matches — the caller degrades to "no sessions for this
// project" rather than failing.
export const resolveQuasarKey = async (name: string): Promise<string | undefined> => {
  const result = await runCli("quasar", ["projects", "--limit", "500"]);
  if (!result.ok) return undefined;

  const parsed = parseJson<QuasarProjectsResponse>(result.stdout);
  const rows = parsed?.data?.rows;
  if (!parsed?.ok || !Array.isArray(rows)) return undefined;

  const matches = rows.filter((row) => row.displayName.toLowerCase() === name.toLowerCase());
  if (matches.length === 0) return undefined;
  return (matches.find((row) => row.projectKey.startsWith("git:")) ?? matches[0]).projectKey;
};

// Same fan-out cap the sibling hint-driven resolvers use (MAX_HINTS above,
// MAX_HINT_PROJECTS in tower.ts).
const SESSION_HINT_LIMIT = 8;

interface QuasarProbeRow {
  readonly projectKey?: string;
}

interface QuasarProbeResponse {
  readonly ok: boolean;
  readonly data?: { readonly rows: ReadonlyArray<QuasarProbeRow> };
}

// A session key (session:<sessionId>) alone doesn't say which quasar project
// it belongs to — unlike glyph/signal keys, which embed the project in the
// key itself. Both `quasar tool-calls --session-id` and `quasar messages
// --session-id` echo the row's projectKey, so a single narrow probe
// (tool-calls first, since most agent sessions carry tool calls; messages as
// a fallback for tool-call-free sessions) discovers it. Returns undefined on
// any failure — the caller treats that session as unresolvable, never
// throws.
const probeSessionProjectKey = async (sessionId: string): Promise<string | undefined> => {
  const toolCalls = await runCli("quasar", ["tool-calls", "--session-id", sessionId, "--limit", "1"]);
  const fromToolCalls = parseJson<QuasarProbeResponse>(toolCalls.stdout)?.data?.rows[0]?.projectKey;
  if (fromToolCalls) return fromToolCalls;

  const messages = await runCli("quasar", ["messages", "--session-id", sessionId, "--limit", "1"]);
  return parseJson<QuasarProbeResponse>(messages.stdout)?.data?.rows[0]?.projectKey;
};

// Session-level drill-down: mirrors resolveTowerGlyphHints/
// resolveTowerSignalHints in shape (batch, degrade-per-key, never throw), but
// needs an extra hop first since a session key doesn't embed its project the
// way a glyph/signal key does. Hop 1 discovers each hinted session's quasar
// project (bounded, one probe per session, run concurrently). Hop 2 fetches
// each *distinct* project's session list once — not once per session — and
// matches rows back to their session id for full metadata (title, provider,
// counts). A session whose project can't be discovered, or whose id isn't
// found in its project's list (e.g. it aged out of the pool), contributes no
// entity — never throws.
export const resolveQuasarSessionHints = async (keys: ReadonlyArray<string>): Promise<Entity[]> => {
  const sessionIds = Array.from(
    new Set(keys.map((key) => parseSessionKey(key)).filter((id): id is string => id !== undefined)),
  ).slice(0, SESSION_HINT_LIMIT);
  if (sessionIds.length === 0) return [];

  const projectBySession = new Map<string, string>();
  await Promise.all(
    sessionIds.map(async (id) => {
      const project = await probeSessionProjectKey(id);
      if (project) projectBySession.set(id, project);
    }),
  );

  const projects = [...new Set(projectBySession.values())];
  const rowsByProject = new Map<string, ReadonlyArray<QuasarSessionRowDetail>>();
  await Promise.all(
    projects.map(async (project) => {
      const result = await runCli("quasar", [
        "sessions",
        "--project-key",
        project,
        "--limit",
        String(SESSION_POOL_LIMIT),
      ]);
      const rows = parseJson<QuasarSessionListResponse>(result.stdout)?.data?.rows;
      if (Array.isArray(rows)) rowsByProject.set(project, rows);
    }),
  );

  const fetchedAt = new Date().toISOString();
  const entities: Entity[] = [];
  for (const id of sessionIds) {
    const project = projectBySession.get(id);
    if (!project) continue;
    const row = rowsByProject.get(project)?.find((r) => r.sessionId === id);
    if (!row) continue;
    entities.push({
      source: "quasar",
      key: sessionKey(row.sessionId),
      kind: "session",
      title: row.title || `${row.provider} session`,
      stats: {
        provider: row.provider,
        messages: row.messageCount,
        tools: row.toolCallCount,
        ...(row.agentName ? { agent: row.agentName } : {}),
      },
      updatedAt: row.updatedAt ?? row.startedAt ?? fetchedAt,
    });
  }
  return entities;
};
