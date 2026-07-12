import type { Entity, SnapshotBundle } from "@shared/entities";
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

interface QuasarSessionsResponse {
  readonly ok: boolean;
  readonly data?: { readonly rows: ReadonlyArray<unknown> };
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
  const existing = entities.get(key);
  entities.set(key, {
    source: "quasar",
    key,
    kind: "project",
    title: existing?.title ?? key,
    stats: { ...existing?.stats, sessions },
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
