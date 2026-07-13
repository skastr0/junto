import type {
  QuasarSearchResult,
  QuasarSessionRow,
  QuasarSessionsResult,
  TowerBrowseResult,
  TowerGlyphRow,
  TowerSearchResult,
} from "@shared/ipc";
import { DIM, HUE } from "./theme";
import { getVellumApi } from "./vellum-api";

// --- pure presentation helpers ----------------------------------------------
// Read-only detail views only — glyphs/signals/sessions never become canvas
// nodes, they hydrate the inspector's "browse" section for a project.

// Active states surface above the fold in this fixed priority order; done and
// abandoned collapse into a one-line count until the reader expands it.
export const GLYPH_ACTIVE_ORDER = ["building", "reviewing", "committed", "exploring", "backlog"] as const;
export const GLYPH_COLLAPSED_STATES = ["done", "abandoned"] as const;

export const glyphStateHue = (state: string): string => {
  if (state === "building" || state === "reviewing") return HUE.amber;
  if (state === "done") return "#5FB98E";
  return DIM; // committed, exploring, backlog, abandoned, and anything unknown
};

export interface GlyphGroups {
  readonly visible: ReadonlyArray<TowerGlyphRow>;
  readonly collapsedRows: ReadonlyArray<TowerGlyphRow>;
  readonly collapsedCounts: ReadonlyArray<{ readonly state: string; readonly count: number }>;
}

export const groupGlyphs = (glyphs: ReadonlyArray<TowerGlyphRow>): GlyphGroups => {
  const collapsedStates: ReadonlyArray<string> = GLYPH_COLLAPSED_STATES;
  const activeOrder: ReadonlyArray<string> = GLYPH_ACTIVE_ORDER;
  const visible = glyphs
    .filter((glyph) => !collapsedStates.includes(glyph.state))
    .slice()
    .sort((a, b) => {
      const ai = activeOrder.indexOf(a.state);
      const bi = activeOrder.indexOf(b.state);
      if (ai === -1 && bi === -1) return 0;
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });
  const collapsedRows = glyphs.filter((glyph) => collapsedStates.includes(glyph.state));
  const counts = new Map<string, number>();
  for (const row of collapsedRows) counts.set(row.state, (counts.get(row.state) ?? 0) + 1);
  const collapsedCounts = GLYPH_COLLAPSED_STATES
    .map((state) => ({ state, count: counts.get(state) ?? 0 }))
    .filter((entry) => entry.count > 0);
  return { visible, collapsedRows, collapsedCounts };
};

// "213 done · 1 abandoned"
export const formatCollapsedSummary = (
  counts: ReadonlyArray<{ readonly state: string; readonly count: number }>,
): string => counts.map(({ state, count }) => `${count} ${state}`).join(" · ");

export const signalStatusHue = (status: string): string => {
  if (status === "inbox") return HUE.amber;
  if (status === "claimed") return HUE.cyan;
  if (status === "dead") return HUE.crimson;
  return DIM; // consumed, and anything unrecognized
};

// The last segment after the final dot; callers keep the full kind in a title
// attribute.
export const shortKind = (kind: string): string => kind.split(".").pop() || kind;

export const sessionTitle = (session: QuasarSessionRow): string =>
  session.title ?? `${session.provider} session`;

export const sessionStats = (session: QuasarSessionRow): string =>
  `${session.messageCount}msg · ${session.toolCallCount}tools`;

export const shortDate = (value?: string): string | undefined => {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed.toLocaleDateString(undefined, { month: "short", day: "numeric" }).toLowerCase();
};

// --- cached, defensive fetchers ---------------------------------------------
// towerBrowse/quasarSessions results are cached per key with a short TTL —
// re-opening the same project's browse section within the window is free.
// Search results are never cached: every debounced keystroke is a fresh
// intent, and staleness there would read as a bug, not a feature.

export const BROWSE_CACHE_TTL_MS = 60_000;

interface CacheEntry<T> {
  readonly value: T;
  readonly at: number;
}

const towerBrowseCache = new Map<string, CacheEntry<TowerBrowseResult>>();
const quasarSessionsCache = new Map<string, CacheEntry<QuasarSessionsResult>>();

const cacheGet = <T,>(cache: Map<string, CacheEntry<T>>, key: string): T | undefined => {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > BROWSE_CACHE_TTL_MS) return undefined;
  return hit.value;
};

const TOWER_UNREACHABLE: TowerBrowseResult = { ok: false, error: "tower unreachable", glyphs: [], signals: [] };
const QUASAR_UNREACHABLE: QuasarSessionsResult = { ok: false, error: "quasar unreachable", sessions: [] };
const TOWER_SEARCH_UNREACHABLE: TowerSearchResult = { ok: false, error: "tower unreachable", matches: [] };
const QUASAR_SEARCH_UNREACHABLE: QuasarSearchResult = { ok: false, error: "quasar unreachable", matches: [] };

export const fetchTowerBrowse = async (key: string): Promise<TowerBrowseResult> => {
  const cached = cacheGet(towerBrowseCache, key);
  if (cached) return cached;
  const api = getVellumApi();
  if (!api || typeof api.towerBrowse !== "function") return TOWER_UNREACHABLE;
  try {
    const result = await api.towerBrowse(key);
    towerBrowseCache.set(key, { value: result, at: Date.now() });
    return result;
  } catch {
    return TOWER_UNREACHABLE;
  }
};

export const fetchQuasarSessions = async (key: string, limit: number): Promise<QuasarSessionsResult> => {
  const cacheKey = `${key}::${limit}`;
  const cached = cacheGet(quasarSessionsCache, cacheKey);
  if (cached) return cached;
  const api = getVellumApi();
  if (!api || typeof api.quasarSessions !== "function") return QUASAR_UNREACHABLE;
  try {
    const result = await api.quasarSessions(key, limit);
    quasarSessionsCache.set(cacheKey, { value: result, at: Date.now() });
    return result;
  } catch {
    return QUASAR_UNREACHABLE;
  }
};

export const fetchTowerSearch = async (query: string, key?: string): Promise<TowerSearchResult> => {
  const api = getVellumApi();
  if (!api || typeof api.towerSearch !== "function") return TOWER_SEARCH_UNREACHABLE;
  try {
    return await api.towerSearch(query, key);
  } catch {
    return TOWER_SEARCH_UNREACHABLE;
  }
};

export const fetchQuasarSearch = async (query: string, key?: string): Promise<QuasarSearchResult> => {
  const api = getVellumApi();
  if (!api || typeof api.quasarSearch !== "function") return QUASAR_SEARCH_UNREACHABLE;
  try {
    return await api.quasarSearch(query, key);
  } catch {
    return QUASAR_SEARCH_UNREACHABLE;
  }
};
