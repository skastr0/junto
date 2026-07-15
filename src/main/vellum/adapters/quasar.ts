import { Context, Effect, Either } from "effect";
import { QuasarClient, QuasarClientTag } from "@skastr0/quasar-sdk";
import type { Entity, SnapshotBundle } from "@shared/entities";
import type {
  QuasarSearchMatch,
  QuasarSearchResult,
  QuasarSessionDetail,
  QuasarSessionDetailResult,
  QuasarSessionRow,
  QuasarSessionsResult,
} from "@shared/ipc";
import { runSdkGuarded, SdkRuntime } from "./sdk-runtime";
import { describeSdkError } from "./sdk-errors";

// Read-only quasar adapter, talking to the remote Quasar HTTP server through
// @skastr0/quasar-sdk's QuasarClient — no `quasar` CLI shell-out. Effect
// Schema decode at the SDK boundary already validated every shape below
// (including normalizing SQL NULL -> undefined for nullable string columns),
// so this file only projects typed rows onto the frozen IPC contract the
// renderer consumes (kept byte-identical).

type QuasarClientService = Context.Tag.Service<typeof QuasarClient>;

// The mapper-facing row types below are explicit interfaces narrowed to
// exactly what each mapper reads, not Pick<> chains off the SDK's real
// nested return types (a Pick<Effect.Effect.Success<ReturnType<
// QuasarClientService["x"]>>, ...> chain is a lot of type indirection for a
// handful of flat fields). The session/message/tool-call rows also stay
// permissive (`?: T | null`) rather than matching the SDK's decoded types
// exactly: the SDK normalizes SQL NULL -> undefined during decode, so every
// real call site already satisfies these, but keeping the mapper itself
// tolerant of a stray `null` is a free belt (matches the server's actual
// bun:sqlite column shape one layer up) and keeps these pure functions
// testable with plain fixtures that don't have to round-trip through Schema
// decode first.

interface SdkProjectRow {
  readonly projectKey: string;
  readonly displayName: string;
}

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

interface QuasarDetailMessageRow {
  readonly role: string;
  readonly text?: string | null;
  readonly ts?: string | null;
}

interface QuasarDetailToolCallRow {
  readonly toolName?: string | null;
}

// Search results live under match.row, structurally narrower than the SDK's
// full SearchHit (key/seq/projectKey/contentHash are decoded but unused
// here) — same permissive-mapper reasoning as the row types above.
interface QuasarSearchRawMatch {
  readonly score: number;
  readonly row: {
    readonly sessionId: string;
    readonly role: string;
    readonly provider: string;
    readonly text: string;
  };
}

const SESSIONS_LIMIT = 500;
const MAX_HINTS = 8;

// Per-key enrichment: fetches the session count for one hinted project key
// and folds it into the entity map. Any failure (SDK error, empty result)
// degrades to a no-op — the entity keeps whatever stats it already had.
const enrichSessions = (
  quasar: QuasarClientService,
  key: string,
  entities: Map<string, Entity>,
  fetchedAt: string,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const result = yield* Effect.either(quasar.listSessions({ projectKey: key, limit: SESSIONS_LIMIT }));
    if (Either.isLeft(result)) return;
    const rows = result.right;

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
  });

// The testable unit: requires only QuasarClient, never touches SdkRuntime.
export const quasarBundleEntities = (
  hints: ReadonlyArray<string>,
  fetchedAt: string,
): Effect.Effect<ReadonlyArray<Entity>, unknown, QuasarClientTag> =>
  Effect.gen(function* () {
    const quasar = yield* QuasarClient;
    const rows: ReadonlyArray<SdkProjectRow> = yield* quasar.listProjects({ limit: 500 });

    const entities = new Map<string, Entity>();
    for (const row of rows) {
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
    yield* Effect.all(
      hintedKeys.map((key) => enrichSessions(quasar, key, entities, fetchedAt)),
      { concurrency: "unbounded" },
    );

    return Array.from(entities.values());
  });

export const fetchQuasarBundle = async (hints: ReadonlyArray<string>): Promise<SnapshotBundle> => {
  const fetchedAt = new Date().toISOString();
  const result = await SdkRuntime.runPromise(Effect.either(quasarBundleEntities(hints, fetchedAt)));
  if (Either.isLeft(result)) {
    return { source: "quasar", fetchedAt, ok: false, error: describeSdkError(result.left), entities: [] };
  }
  return { source: "quasar", fetchedAt, ok: true, entities: result.right };
};

// --- session browsing (read-only detail view) -------------------------------

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

export const fetchQuasarSessionList = (
  quasarKey: string,
  limit: number = DEFAULT_SESSION_LIMIT,
): Promise<QuasarSessionsResult> =>
  runSdkGuarded(
    async () => {
      const result = await SdkRuntime.runPromise(
        Effect.either(Effect.flatMap(QuasarClient, (quasar) => quasar.listSessions({ projectKey: quasarKey, limit: SESSION_FETCH_LIMIT }))),
      );
      if (Either.isLeft(result)) {
        return { ok: false, error: describeSdkError(result.left), sessions: [] };
      }
      return { ok: true, sessions: sortAndMapSessions(result.right, limit) };
    },
    (error) => ({ ok: false, error, sessions: [] }),
  );

// --- search (read-only detail view) -----------------------------------------

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

export const fetchQuasarSearch = (
  query: string,
  quasarKey?: string,
): Promise<QuasarSearchResult> =>
  runSdkGuarded(
    async () => {
      const result = await SdkRuntime.runPromise(
        Effect.either(
          Effect.flatMap(QuasarClient, (quasar) =>
            quasar.search("fusion", { query, projectKey: quasarKey, limit: SEARCH_LIMIT }),
          ),
        ),
      );
      if (Either.isLeft(result)) {
        return { ok: false, error: describeSdkError(result.left), matches: [] };
      }
      return { ok: true, matches: mapSearchMatches(result.right) };
    },
    (error) => ({ ok: false, error, matches: [] }),
  );

// --- session detail (reader modal) ------------------------------------------
//
// Built from two SDK calls: readMessages (per-message ts is reliable even
// when the session-level updatedAt/startedAt is null for a provider) and
// listToolCalls (tool usage stats). Never throws — a failing/malformed call
// degrades to ok:false (messages) or empty tool stats (tool-calls, best-effort).

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

export const fetchQuasarSessionDetail = (sessionId: string): Promise<QuasarSessionDetailResult> =>
  runSdkGuarded(
    async () => {
      const program = Effect.gen(function* () {
        const quasar = yield* QuasarClient;
        const messageRows = yield* quasar.readMessages(sessionId, { limit: SESSION_DETAIL_FETCH_LIMIT });

        // Tool-call stats are best-effort: a failing/malformed call degrades to
        // empty tool stats rather than failing the whole detail — the
        // transcript bookends are still useful without it.
        const toolRowsResult = yield* Effect.either(
          quasar.listToolCalls({ sessionId, limit: SESSION_DETAIL_FETCH_LIMIT }),
        );
        const toolRows = Either.isRight(toolRowsResult) ? toolRowsResult.right : [];

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

        return detail;
      });

      const result = await SdkRuntime.runPromise(Effect.either(program));
      if (Either.isLeft(result)) {
        return { ok: false, error: describeSdkError(result.left) };
      }
      return { ok: true, detail: result.right };
    },
    (error) => ({ ok: false, error }),
  );
