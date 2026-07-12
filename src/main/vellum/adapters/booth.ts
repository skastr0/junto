import type { Entity, SnapshotBundle } from "@shared/entities";
import { parseJson, runCli } from "./exec";

// The booth server is currently 502ing (Convex-backed HTTP action, down as
// of this writing), so this adapter parses defensively: it accepts the
// `{ok, data: {...}}` envelope the sibling CLIs use, but also tolerates a
// bare array or an unwrapped `{items: [...]}` shape in case the live
// response differs once the server is back.
interface BoothProjectRow {
  readonly key?: string;
  readonly id?: string;
  readonly slug?: string;
  readonly name?: string;
  readonly title?: string;
  readonly updatedAt?: string | number;
}

const asArray = (value: unknown): ReadonlyArray<unknown> | undefined => {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    for (const field of ["projects", "rows", "items", "data"]) {
      const candidate = (value as Record<string, unknown>)[field];
      if (Array.isArray(candidate)) return candidate;
      if (field === "data" && candidate && typeof candidate === "object") {
        const nested = asArray(candidate);
        if (nested) return nested;
      }
    }
  }
  return undefined;
};

const toIso = (value: string | number | undefined, fallback: string): string => {
  if (value === undefined) return fallback;
  const date = typeof value === "number" ? new Date(value) : new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
};

const toProjectEntity = (row: unknown, fetchedAt: string): Entity | undefined => {
  if (!row || typeof row !== "object") return undefined;
  const project = row as BoothProjectRow;
  const key = project.key ?? project.id ?? project.slug;
  if (!key) return undefined;
  return {
    source: "booth",
    key,
    kind: "project",
    title: project.name ?? project.title ?? key,
    stats: {},
    updatedAt: toIso(project.updatedAt, fetchedAt),
  };
};

const MAX_HINTS = 8;

// Per-key enrichment: fetches the draft count for one hinted project key.
// Any failure (down server, bad exit, unparseable body) is a no-op — the
// entity keeps whatever stats it already had.
const enrichDrafts = async (
  key: string,
  entities: Map<string, Entity>,
  fetchedAt: string,
): Promise<void> => {
  const result = await runCli("booth", ["drafts", "list", "--project", key, "--json"]);
  if (!result.ok) return;

  const parsed = parseJson<unknown>(result.stdout);
  const drafts = parsed ? asArray(parsed) : undefined;
  if (!drafts) return;

  const existing = entities.get(key);
  entities.set(key, {
    source: "booth",
    key,
    kind: "project",
    title: existing?.title ?? key,
    stats: { ...existing?.stats, drafts: drafts.length },
    updatedAt: existing?.updatedAt ?? fetchedAt,
  });
};

export const fetchBoothBundle = async (hints: ReadonlyArray<string>): Promise<SnapshotBundle> => {
  const fetchedAt = new Date().toISOString();
  const result = await runCli("booth", ["projects", "list", "--json"]);
  if (!result.ok) {
    return {
      source: "booth",
      fetchedAt,
      ok: false,
      error: result.error ?? "booth CLI failed",
      entities: [],
    };
  }

  const parsed = parseJson<unknown>(result.stdout);
  const rows = parsed ? asArray(parsed) : undefined;
  if (!rows) {
    return {
      source: "booth",
      fetchedAt,
      ok: false,
      error: "unexpected response shape from `booth projects list --json`",
      entities: [],
    };
  }

  const entities = new Map<string, Entity>();
  for (const row of rows) {
    const entity = toProjectEntity(row, fetchedAt);
    if (entity) entities.set(entity.key, entity);
  }

  const hintedKeys = Array.from(new Set(hints)).slice(0, MAX_HINTS);
  await Promise.all(hintedKeys.map((key) => enrichDrafts(key, entities, fetchedAt)));

  return { source: "booth", fetchedAt, ok: true, entities: Array.from(entities.values()) };
};
