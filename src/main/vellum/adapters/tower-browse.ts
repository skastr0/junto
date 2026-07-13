import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  TowerBrowseResult,
  TowerDispatchesResult,
  TowerGlyphDetail,
  TowerGlyphReadResult,
  TowerGlyphRow,
  TowerSearchMatch,
  TowerSearchResult,
  TowerSignalDetail,
  TowerSignalReadResult,
  TowerSignalRow,
} from "@shared/ipc";

// Read-only tower-control browse/search adapter. Talks to the live REST
// gateway directly (not the `tower` CLI — this endpoint set is HTTP-only and
// requires a project + orbit fan-out the CLI doesn't expose in one shot).
// NEVER log config.token: it is read once, held in memory, and used only as
// the Authorization header value below.

interface TowerConfig {
  readonly url: string; // e.g. https://tower-control.example.ts.net/tower-api (no trailing slash)
  readonly token: string;
}

let cachedConfig: TowerConfig | undefined;

const loadConfig = (): TowerConfig | undefined => {
  if (cachedConfig) return cachedConfig;
  try {
    const raw = readFileSync(join(homedir(), ".tower-control", "config.json"), "utf8");
    const parsed = JSON.parse(raw) as Partial<TowerConfig>;
    if (typeof parsed.url !== "string" || typeof parsed.token !== "string") return undefined;
    cachedConfig = { url: parsed.url.replace(/\/+$/, ""), token: parsed.token };
    return cachedConfig;
  } catch {
    return undefined;
  }
};

const CONFIG_MISSING_ERROR = "tower-control config missing or unreadable (~/.tower-control/config.json)";
const REQUEST_TIMEOUT_MS = 8_000;
const SEARCH_LIMIT = 20;

// The gateway only serves these five orbits; browse fans out across all of
// them per projectKey.
const ORBITS = ["forge", "survey", "beacon", "scribe", "oracle"] as const;

const authHeaders = (token: string): HeadersInit => ({ Authorization: `Bearer ${token}` });

// Every request gets its own timeout + abort; a failing/slow request never
// blocks the others and never throws out of this helper.
const fetchJson = async <T>(url: string, init: RequestInit): Promise<T | undefined> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) return undefined;
    return (await response.json()) as T;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
};

interface RawGlyphItem {
  readonly glyphId: string;
  readonly orbit: string;
  readonly title: string;
  readonly state: string;
  readonly updatedAt: number;
}

interface GlyphsResponse {
  readonly items?: ReadonlyArray<RawGlyphItem>;
}

interface RawSignalItem {
  readonly signalId: string;
  readonly orbit: string;
  readonly status: string;
  readonly kind: string;
  readonly summary: string;
  readonly priority?: string;
  readonly updatedAt: number;
  // payload can run ~6KB and is never forwarded past this adapter.
}

interface SignalsResponse {
  readonly signals?: ReadonlyArray<RawSignalItem>;
}

export const mapGlyphItems = (items: ReadonlyArray<RawGlyphItem> | undefined): ReadonlyArray<TowerGlyphRow> => {
  if (!Array.isArray(items)) return [];
  return items.map((item) => ({
    glyphId: item.glyphId,
    orbit: item.orbit,
    title: item.title,
    state: item.state,
    updatedAt: item.updatedAt,
  }));
};

export const mapSignalItems = (
  items: ReadonlyArray<RawSignalItem> | undefined,
): ReadonlyArray<TowerSignalRow> => {
  if (!Array.isArray(items)) return [];
  return items.map((item) => ({
    signalId: item.signalId,
    orbit: item.orbit,
    status: item.status,
    kind: item.kind,
    summary: item.summary,
    priority: item.priority,
    updatedAt: item.updatedAt,
  }));
};

const fetchOrbit = async (
  config: TowerConfig,
  projectKey: string,
  orbit: string,
): Promise<{ glyphs: ReadonlyArray<TowerGlyphRow>; signals: ReadonlyArray<TowerSignalRow> }> => {
  const qs = `projectKey=${encodeURIComponent(projectKey)}&orbit=${orbit}`;
  const [glyphData, signalData] = await Promise.all([
    fetchJson<GlyphsResponse>(`${config.url}/api/glyphs?${qs}`, { headers: authHeaders(config.token) }),
    fetchJson<SignalsResponse>(`${config.url}/api/signals?${qs}`, { headers: authHeaders(config.token) }),
  ]);
  return { glyphs: mapGlyphItems(glyphData?.items), signals: mapSignalItems(signalData?.signals) };
};

// Fans the 5 orbits x (glyphs+signals) = 10 requests in parallel. A failing
// orbit contributes nothing (fetchJson already swallows its own errors) —
// this function itself never throws.
export const fetchTowerBrowse = async (projectKey: string): Promise<TowerBrowseResult> => {
  const config = loadConfig();
  if (!config) {
    return { ok: false, error: CONFIG_MISSING_ERROR, glyphs: [], signals: [] };
  }

  const perOrbit = await Promise.all(ORBITS.map((orbit) => fetchOrbit(config, projectKey, orbit)));

  return {
    ok: true,
    glyphs: perOrbit.flatMap((entry) => entry.glyphs),
    signals: perOrbit.flatMap((entry) => entry.signals),
  };
};

interface RawSearchMatch {
  readonly family: string;
  readonly title: string;
  readonly summary?: string;
  readonly projectKey: string;
  readonly orbit?: string;
  readonly glyphId?: string;
  readonly signalId?: string;
  readonly state?: string;
  readonly status?: string;
  readonly score: number;
}

interface SearchResponse {
  readonly matches?: ReadonlyArray<RawSearchMatch>;
}

export const mapSearchMatches = (
  matches: ReadonlyArray<RawSearchMatch> | undefined,
): ReadonlyArray<TowerSearchMatch> => {
  if (!Array.isArray(matches)) return [];
  return matches.map((match) => ({
    family: match.family,
    title: match.title,
    summary: match.summary,
    projectKey: match.projectKey,
    orbit: match.orbit,
    glyphId: match.glyphId,
    signalId: match.signalId,
    state: match.state,
    status: match.status,
    score: match.score,
  }));
};

// POST-only endpoint (the GET variant 404s); limit is a hard ceiling of 50
// server-side, we ask for 20.
export const fetchTowerSearch = async (query: string, projectKey?: string): Promise<TowerSearchResult> => {
  const config = loadConfig();
  if (!config) {
    return { ok: false, error: CONFIG_MISSING_ERROR, matches: [] };
  }

  const body: Record<string, unknown> = { query, limit: SEARCH_LIMIT };
  if (projectKey) body.projectKey = projectKey;

  const data = await fetchJson<SearchResponse>(`${config.url}/api/search/text`, {
    method: "POST",
    headers: { ...authHeaders(config.token), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!data) {
    return { ok: false, error: "tower search request failed", matches: [] };
  }

  return { ok: true, matches: mapSearchMatches(data.matches) };
};

// --- glyph detail (reader modal; GET /api/glyphs/read) ----------------------
//
// Verified live against the gateway (2026-07-12): the query param is
// `glyphId`, NOT `id` — `id` gets rejected with a 400 "does not satisfy the
// Tower HTTP contract" even though the checked-in convex/http.ts route reads
// `id` off the query string. The deployed gateway diverges from the local
// route table; go with what the live server actually accepts.

interface RawGlyphComment {
  readonly body?: string;
}

interface RawGlyphCommentsBlock {
  readonly total?: number;
  readonly latest?: ReadonlyArray<RawGlyphComment>;
}

// Each dependency/dependent entry is a full glyphDependencies edge
// ({ from, to, kind, ... }); `dependencies` edges point `to` the glyph this
// one depends on, `dependents` edges point `from` the glyph that depends on
// this one — pull the far-end glyphId out of each.
interface RawGlyphDependencyEdge {
  readonly to?: { readonly glyphId?: string };
  readonly from?: { readonly glyphId?: string };
}

interface RawGlyphDetail {
  readonly glyphId: string;
  readonly orbit: string;
  readonly title: string;
  readonly state: string;
  readonly content?: string;
  readonly comments?: RawGlyphCommentsBlock;
  readonly dependencies?: ReadonlyArray<RawGlyphDependencyEdge>;
  readonly dependents?: ReadonlyArray<RawGlyphDependencyEdge>;
  readonly updatedAt: number;
}

export const mapGlyphDetail = (raw: RawGlyphDetail): TowerGlyphDetail => ({
  glyphId: raw.glyphId,
  orbit: raw.orbit,
  title: raw.title,
  state: raw.state,
  content: raw.content ?? "",
  commentsTotal: raw.comments?.total ?? 0,
  latestComment: raw.comments?.latest?.[0]?.body,
  dependencies: (raw.dependencies ?? [])
    .map((edge) => edge.to?.glyphId)
    .filter((id): id is string => Boolean(id)),
  dependents: (raw.dependents ?? [])
    .map((edge) => edge.from?.glyphId)
    .filter((id): id is string => Boolean(id)),
  updatedAt: raw.updatedAt,
});

export const fetchTowerGlyphRead = async (
  projectKey: string,
  orbit: string,
  glyphId: string,
): Promise<TowerGlyphReadResult> => {
  const config = loadConfig();
  if (!config) {
    return { ok: false, error: CONFIG_MISSING_ERROR };
  }

  const qs = `projectKey=${encodeURIComponent(projectKey)}&orbit=${encodeURIComponent(orbit)}&glyphId=${encodeURIComponent(glyphId)}`;
  const data = await fetchJson<RawGlyphDetail>(`${config.url}/api/glyphs/read?${qs}`, {
    headers: authHeaders(config.token),
  });

  if (!data) {
    return { ok: false, error: "tower glyph read request failed" };
  }

  return { ok: true, glyph: mapGlyphDetail(data) };
};

// --- signal detail (reader modal; GET /api/signals/read) --------------------
//
// Verified live (2026-07-12): the query param is `signalId`, same divergence
// from convex/http.ts's `id` as glyphs/read above.

interface RawSignalSource {
  readonly name?: string;
}

interface RawSignalAudit {
  readonly consumed_by?: string;
  readonly consumption_summary?: string;
}

interface RawSignalDetail {
  readonly signalId: string;
  readonly orbit: string;
  readonly status: string;
  readonly kind: string;
  readonly summary: string;
  readonly priority?: string;
  readonly payload?: unknown;
  readonly source?: RawSignalSource | null;
  readonly audit?: RawSignalAudit | null;
  readonly updatedAt: number;
}

const PAYLOAD_JSON_CAP = 20_000;

export const formatPayloadJson = (payload: unknown): string | undefined => {
  if (payload === undefined) return undefined;
  const full = JSON.stringify(payload, null, 2);
  return full.length > PAYLOAD_JSON_CAP ? `${full.slice(0, PAYLOAD_JSON_CAP)}… (truncated)` : full;
};

export const mapSignalDetail = (raw: RawSignalDetail): TowerSignalDetail => ({
  signalId: raw.signalId,
  orbit: raw.orbit,
  status: raw.status,
  kind: raw.kind,
  summary: raw.summary,
  priority: raw.priority,
  payloadJson: formatPayloadJson(raw.payload),
  sourceName: raw.source?.name,
  consumedBy: raw.audit?.consumed_by,
  consumptionSummary: raw.audit?.consumption_summary,
  updatedAt: raw.updatedAt,
});

export const fetchTowerSignalRead = async (
  projectKey: string,
  orbit: string,
  signalId: string,
): Promise<TowerSignalReadResult> => {
  const config = loadConfig();
  if (!config) {
    return { ok: false, error: CONFIG_MISSING_ERROR };
  }

  const qs = `projectKey=${encodeURIComponent(projectKey)}&orbit=${encodeURIComponent(orbit)}&signalId=${encodeURIComponent(signalId)}`;
  const data = await fetchJson<RawSignalDetail>(`${config.url}/api/signals/read?${qs}`, {
    headers: authHeaders(config.token),
  });

  if (!data) {
    return { ok: false, error: "tower signal read request failed" };
  }

  return { ok: true, signal: mapSignalDetail(data) };
};

// --- dispatches (probed; no confirmed live browse route) --------------------
//
// Probed live (2026-07-12) against every plausible GET shape:
//   GET /api/dispatches?projectKey=&orbit=       -> 404 "No retained Tower route matches this request."
//   GET /api/dispatches?projectKey=               -> 404, same
//   GET /api/global-dispatches?projectKey=        -> 404, same
//   GET /api/dispatches/read?projectKey=&orbit=   -> 404, same
//   GET /api/dispatches/list?projectKey=&orbit=   -> 404, same
// Cross-checked against tower-control/convex/http.ts's route table: both
// "/api/dispatches" and "/api/global-dispatches" are registered POST-only
// (persistDispatchInternal / persistGlobalDispatchInternal mutations) — no
// GET browse route is defined server-side at all, so this isn't a param
// mismatch like glyphs/signals, it's a genuinely absent route. Nothing to
// fan out across orbits; report unsupported so the UI hides the tab.
export const fetchTowerDispatches = (_projectKey: string): Promise<TowerDispatchesResult> =>
  Promise.resolve({ ok: false, error: "unsupported", dispatches: [] });
