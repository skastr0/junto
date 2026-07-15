import type { EtherView } from "@shared/canvas";
import type {
  QuasarSearchResult,
  QuasarSessionDetail,
  QuasarSessionDetailResult,
  QuasarSessionRow,
  QuasarSessionsResult,
  SourceWriteResult,
  TowerBrowseResult,
  TowerDispatchesResult,
  TowerEmitSignalInput,
  TowerEmitSignalResult,
  TowerGlyphReadResult,
  TowerGlyphRow,
  TowerSearchResult,
  TowerSignalReadResult,
  TowerSignalRow,
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

// --- project view slices ----------------------------------------------------
// A node's ether.view is a per-node lens over one bound project: it narrows
// what the browse section shows, never what exists. Pure filter functions
// here compose two layers: the node's stored view (auto pre-applied, not
// interactive) and, for glyphs, an interactive orbit-chip that further
// narrows within whatever the view already permits.

// The gateway's five well-known orbits (see main/vellum/adapters/tower-browse
// ORBITS) plus, in the editor, whatever additional orbit_<name> stat keys a
// project's own live tower snapshot happens to carry.
export const CANONICAL_ORBITS = ["forge", "survey", "beacon", "scribe", "oracle"] as const;

// The full glyph state vocabulary in natural workflow order (distinct from
// GLYPH_ACTIVE_ORDER/GLYPH_COLLAPSED_STATES, which order for above/below the
// fold, not for a states picker).
export const TOWER_STATES = ["backlog", "exploring", "committed", "building", "reviewing", "done", "abandoned"] as const;

// Orbit options for the view-slice editor: canonical five first, then any
// orbit_<name> stat keys discovered on the project's live tower entity,
// deduped. `stats` is intentionally loose (Entity.stats' value union) since
// only the key names are read here.
export const orbitOptions = (stats: Record<string, unknown> | undefined): ReadonlyArray<string> => {
  const discovered = Object.keys(stats ?? {})
    .filter((key) => key.startsWith("orbit_"))
    .map((key) => key.slice("orbit_".length));
  return Array.from(new Set<string>([...CANONICAL_ORBITS, ...discovered]));
};

// A view/chip query is a /regex/ when wrapped in slashes and it actually
// compiles; anything else — including a wrapped pattern that fails to
// compile — degrades to a plain case-insensitive substring test. A broken
// regex must never blank the list, only fall back to something coarser.
export const compileGlyphQuery = (query: string): ((text: string) => boolean) => {
  const trimmed = query.trim();
  if (!trimmed) return () => true;
  const wrapped = trimmed.match(/^\/(.+)\/([a-z]*)$/i);
  if (wrapped) {
    try {
      const re = new RegExp(wrapped[1], wrapped[2]);
      return (text: string) => re.test(text);
    } catch {
      // invalid pattern — fall through to substring below
    }
  }
  const needle = trimmed.toLowerCase();
  return (text: string) => text.toLowerCase().includes(needle);
};

// Layer 1: the node's stored view, auto pre-applied to the glyphs tab.
export const filterGlyphsByView = (
  glyphs: ReadonlyArray<TowerGlyphRow>,
  view: EtherView | undefined,
): ReadonlyArray<TowerGlyphRow> => {
  if (!view) return glyphs;
  let out = glyphs;
  if (view.orbit) out = out.filter((glyph) => glyph.orbit === view.orbit);
  if (view.states && view.states.length > 0) {
    const states = new Set(view.states);
    out = out.filter((glyph) => states.has(glyph.state));
  }
  if (view.glyphQuery) {
    const test = compileGlyphQuery(view.glyphQuery);
    out = out.filter((glyph) => test(glyph.glyphId) || test(glyph.title));
  }
  return out;
};

// Layer 1 for signals: orbit only, per the contract (states/glyphQuery are
// glyph-shaped concepts a signal row doesn't carry).
export const filterSignalsByView = (
  signals: ReadonlyArray<TowerSignalRow>,
  view: EtherView | undefined,
): ReadonlyArray<TowerSignalRow> => (view?.orbit ? signals.filter((signal) => signal.orbit === view.orbit) : signals);

// Layer 2: the standalone orbit-chip row, narrowing further within whatever
// layer 1 already produced. `undefined`/empty orbit is "all".
export const filterGlyphsByOrbit = (
  glyphs: ReadonlyArray<TowerGlyphRow>,
  orbit: string | undefined,
): ReadonlyArray<TowerGlyphRow> => (orbit ? glyphs.filter((glyph) => glyph.orbit === orbit) : glyphs);

// Orbit chip options: every orbit actually present in a glyph list, deduped
// and sorted — never the canonical five, since a chip for an orbit with zero
// rows in the current slice would be a dead control.
export const orbitsPresent = (glyphs: ReadonlyArray<TowerGlyphRow>): ReadonlyArray<string> =>
  Array.from(new Set(glyphs.map((glyph) => glyph.orbit))).sort();

export const signalStatusHue = (status: string): string => {
  if (status === "inbox") return HUE.amber;
  if (status === "claimed") return HUE.cyan;
  if (status === "dead") return HUE.crimson;
  return DIM; // consumed, and anything unrecognized
};

// The last segment after the final dot; callers keep the full kind in a title
// attribute.
export const shortKind = (kind: string): string => kind.split(".").pop() || kind;

// Structurally typed so both the row (list) and detail (modal) session shapes
// satisfy it without a cast at the call site.
export const sessionTitle = (session: { readonly title?: string; readonly provider: string }): string =>
  session.title ?? `${session.provider} session`;

export const sessionStats = (session: QuasarSessionRow): string =>
  `${session.messageCount}msg · ${session.toolCallCount}tools`;

export const shortDate = (value?: string): string | undefined => {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed.toLocaleDateString(undefined, { month: "short", day: "numeric" }).toLowerCase();
};

// Wall-clock span between two ISO timestamps, rounded to a single unit
// ("42m", "3h 5m", "2d"). undefined when either bookend is missing/garbage
// or the span is negative (clock skew across providers).
export const formatDuration = (startedAt?: string, endedAt?: string): string | undefined => {
  if (!startedAt || !endedAt) return undefined;
  const start = new Date(startedAt).getTime();
  const end = new Date(endedAt).getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return undefined;
  const minutes = Math.round((end - start) / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const remainder = minutes % 60;
    return remainder > 0 ? `${hours}h ${remainder}m` : `${hours}h`;
  }
  return `${Math.floor(hours / 24)}d`;
};

// The modal's third counts segment: a computed duration when both bookends
// are present, else the date(s) we do have, else nothing (never a fake cue).
export const sessionDurationOrDates = (detail: QuasarSessionDetail): string | undefined => {
  const duration = formatDuration(detail.startedAt, detail.endedAt);
  if (duration) return duration;
  const start = shortDate(detail.startedAt);
  const end = shortDate(detail.endedAt);
  if (start && end && start !== end) return `${start} – ${end}`;
  return start ?? end;
};

// "N messages · K tool calls · <duration or dates>" for the session modal.
export const sessionDetailStats = (detail: QuasarSessionDetail): string => {
  const base = `${detail.messageCount} messages · ${detail.toolCallCount} tool calls`;
  const extra = sessionDurationOrDates(detail);
  return extra ? `${base} · ${extra}` : base;
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
const towerDispatchesCache = new Map<string, CacheEntry<TowerDispatchesResult>>();
const towerGlyphReadCache = new Map<string, CacheEntry<TowerGlyphReadResult>>();
const towerSignalReadCache = new Map<string, CacheEntry<TowerSignalReadResult>>();
const quasarSessionDetailCache = new Map<string, CacheEntry<QuasarSessionDetailResult>>();

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
const TOWER_DISPATCHES_UNREACHABLE: TowerDispatchesResult = { ok: false, error: "tower unreachable", dispatches: [] };
const TOWER_GLYPH_READ_UNREACHABLE: TowerGlyphReadResult = { ok: false, error: "tower unreachable" };
const TOWER_SIGNAL_READ_UNREACHABLE: TowerSignalReadResult = { ok: false, error: "tower unreachable" };
const QUASAR_SESSION_DETAIL_UNREACHABLE: QuasarSessionDetailResult = { ok: false, error: "quasar unreachable" };

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

// Dispatches probe/list, cached per project — the same call both answers
// "does DISPATCHES belong in the tab picker" and supplies the tab's rows, so
// there is exactly one fetch per project per TTL window either way.
export const fetchTowerDispatches = async (key: string): Promise<TowerDispatchesResult> => {
  const cached = cacheGet(towerDispatchesCache, key);
  if (cached) return cached;
  const api = getVellumApi();
  if (!api || typeof api.towerDispatches !== "function") return TOWER_DISPATCHES_UNREACHABLE;
  try {
    const result = await api.towerDispatches(key);
    towerDispatchesCache.set(key, { value: result, at: Date.now() });
    return result;
  } catch {
    return TOWER_DISPATCHES_UNREACHABLE;
  }
};

export const fetchTowerGlyphRead = async (projectKey: string, orbit: string, glyphId: string): Promise<TowerGlyphReadResult> => {
  const cacheKey = `${projectKey}::${orbit}::${glyphId}`;
  const cached = cacheGet(towerGlyphReadCache, cacheKey);
  if (cached) return cached;
  const api = getVellumApi();
  if (!api || typeof api.towerGlyphRead !== "function") return TOWER_GLYPH_READ_UNREACHABLE;
  try {
    const result = await api.towerGlyphRead(projectKey, orbit, glyphId);
    towerGlyphReadCache.set(cacheKey, { value: result, at: Date.now() });
    return result;
  } catch {
    return TOWER_GLYPH_READ_UNREACHABLE;
  }
};

export const fetchTowerSignalRead = async (projectKey: string, orbit: string, signalId: string): Promise<TowerSignalReadResult> => {
  const cacheKey = `${projectKey}::${orbit}::${signalId}`;
  const cached = cacheGet(towerSignalReadCache, cacheKey);
  if (cached) return cached;
  const api = getVellumApi();
  if (!api || typeof api.towerSignalRead !== "function") return TOWER_SIGNAL_READ_UNREACHABLE;
  try {
    const result = await api.towerSignalRead(projectKey, orbit, signalId);
    towerSignalReadCache.set(cacheKey, { value: result, at: Date.now() });
    return result;
  } catch {
    return TOWER_SIGNAL_READ_UNREACHABLE;
  }
};

export const fetchQuasarSessionDetail = async (sessionId: string): Promise<QuasarSessionDetailResult> => {
  const cached = cacheGet(quasarSessionDetailCache, sessionId);
  if (cached) return cached;
  const api = getVellumApi();
  if (!api || typeof api.quasarSessionDetail !== "function") return QUASAR_SESSION_DETAIL_UNREACHABLE;
  try {
    const result = await api.quasarSessionDetail(sessionId);
    quasarSessionDetailCache.set(sessionId, { value: result, at: Date.now() });
    return result;
  } catch {
    return QUASAR_SESSION_DETAIL_UNREACHABLE;
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

// --- deliberate writes (never cached) ---------------------------------------
// Comment posts from the glyph/signal detail modals. Same source-down floor
// as the readers above; never thrown out of the composer.

const TOWER_WRITE_UNREACHABLE: SourceWriteResult = { ok: false, error: "tower unreachable" };

export const postTowerCommentGlyph = async (
  projectKey: string,
  orbit: string,
  glyphId: string,
  body: string,
): Promise<SourceWriteResult> => {
  const api = getVellumApi();
  if (!api || typeof api.towerCommentGlyph !== "function") return TOWER_WRITE_UNREACHABLE;
  try {
    return await api.towerCommentGlyph(projectKey, orbit, glyphId, body);
  } catch {
    return TOWER_WRITE_UNREACHABLE;
  }
};

export const postTowerCommentSignal = async (
  projectKey: string,
  orbit: string,
  signalId: string,
  body: string,
): Promise<SourceWriteResult> => {
  const api = getVellumApi();
  if (!api || typeof api.towerCommentSignal !== "function") return TOWER_WRITE_UNREACHABLE;
  try {
    return await api.towerCommentSignal(projectKey, orbit, signalId, body);
  } catch {
    return TOWER_WRITE_UNREACHABLE;
  }
};

const TOWER_EMIT_UNREACHABLE: TowerEmitSignalResult = { ok: false, error: "tower unreachable" };

export const postTowerEmitSignal = async (input: TowerEmitSignalInput): Promise<TowerEmitSignalResult> => {
  const api = getVellumApi();
  if (!api || typeof api.towerEmitSignal !== "function") return TOWER_EMIT_UNREACHABLE;
  try {
    return await api.towerEmitSignal(input);
  } catch {
    return TOWER_EMIT_UNREACHABLE;
  }
};
