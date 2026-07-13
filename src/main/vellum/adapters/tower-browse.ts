import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  SourceWriteResult,
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
// Mirrors CONFIG_MISSING_ERROR: distinguishes "the gateway is unreachable /
// every request failed" from "this project legitimately has zero
// glyphs/signals" — see fetchTowerBrowse below.
const ALL_REQUESTS_FAILED_ERROR = "tower gateway unreachable — every glyph/signal request failed";
const REQUEST_TIMEOUT_MS = 8_000;
const SEARCH_LIMIT = 20;

// The gateway only serves these five orbits; browse fans out across all of
// them per projectKey.
const ORBITS = ["forge", "survey", "beacon", "scribe", "oracle"] as const;

const authHeaders = (token: string): HeadersInit => ({ Authorization: `Bearer ${token}` });

type FetchOutcome<T> =
  | { readonly ok: true; readonly status: number; readonly data: T }
  | { readonly ok: false; readonly status?: number };

// Every request gets its own timeout + abort; a failing/slow request never
// blocks the others and never throws out of this helper. Reports the raw
// HTTP status (when the fetch itself completed) so callers can tell a 401
// (stale/rotated bearer token) apart from a generic outage.
const fetchJson = async <T>(url: string, init: RequestInit): Promise<FetchOutcome<T>> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) return { ok: false, status: response.status };
    const data = (await response.json()) as T;
    return { ok: true, status: response.status, data };
  } catch {
    return { ok: false };
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

interface OrbitFetchResult {
  readonly glyphs: ReadonlyArray<TowerGlyphRow>;
  readonly signals: ReadonlyArray<TowerSignalRow>;
  // true when at least one of the orbit's two requests (glyphs or signals)
  // actually succeeded — false means both failed for this orbit.
  readonly succeeded: boolean;
  readonly unauthorized: boolean;
}

const fetchOrbit = async (config: TowerConfig, projectKey: string, orbit: string): Promise<OrbitFetchResult> => {
  const qs = `projectKey=${encodeURIComponent(projectKey)}&orbit=${orbit}`;
  const [glyphResult, signalResult] = await Promise.all([
    fetchJson<GlyphsResponse>(`${config.url}/api/glyphs?${qs}`, { headers: authHeaders(config.token) }),
    fetchJson<SignalsResponse>(`${config.url}/api/signals?${qs}`, { headers: authHeaders(config.token) }),
  ]);
  return {
    glyphs: mapGlyphItems(glyphResult.ok ? glyphResult.data.items : undefined),
    signals: mapSignalItems(signalResult.ok ? signalResult.data.signals : undefined),
    succeeded: glyphResult.ok || signalResult.ok,
    unauthorized: glyphResult.status === 401 || signalResult.status === 401,
  };
};

const runBrowseFanOut = (config: TowerConfig, projectKey: string): Promise<ReadonlyArray<OrbitFetchResult>> =>
  Promise.all(ORBITS.map((orbit) => fetchOrbit(config, projectKey, orbit)));

// Fans the 5 orbits x (glyphs+signals) = 10 requests in parallel. A failing
// orbit contributes nothing to glyphs/signals and this function itself never
// throws — but unlike a single failing orbit, every one of the 10 requests
// failing must NOT read as "this project has zero glyphs/signals": that
// defeats the CONFIG_MISSING_ERROR path's whole point (distinguishing a down
// source from an empty one). Partial failure still returns ok:true.
export const fetchTowerBrowse = async (projectKey: string): Promise<TowerBrowseResult> => {
  let config = loadConfig();
  if (!config) {
    return { ok: false, error: CONFIG_MISSING_ERROR, glyphs: [], signals: [] };
  }

  let perOrbit = await runBrowseFanOut(config, projectKey);
  let allFailed = perOrbit.every((entry) => !entry.succeeded);

  if (allFailed && perOrbit.some((entry) => entry.unauthorized)) {
    // Every request failed and at least one came back 401 — the cached
    // bearer token looks rotated/expired. Invalidate it, re-read
    // ~/.tower-control/config.json once, and retry the fan-out with
    // whatever token is on disk now before giving up.
    cachedConfig = undefined;
    const refreshed = loadConfig();
    if (refreshed) {
      config = refreshed;
      perOrbit = await runBrowseFanOut(config, projectKey);
      allFailed = perOrbit.every((entry) => !entry.succeeded);
    }
  }

  if (allFailed) {
    return { ok: false, error: ALL_REQUESTS_FAILED_ERROR, glyphs: [], signals: [] };
  }

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

  const result = await fetchJson<SearchResponse>(`${config.url}/api/search/text`, {
    method: "POST",
    headers: { ...authHeaders(config.token), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!result.ok) {
    return { ok: false, error: "tower search request failed", matches: [] };
  }

  return { ok: true, matches: mapSearchMatches(result.data.matches) };
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
  const result = await fetchJson<RawGlyphDetail>(`${config.url}/api/glyphs/read?${qs}`, {
    headers: authHeaders(config.token),
  });

  if (!result.ok) {
    return { ok: false, error: "tower glyph read request failed" };
  }

  return { ok: true, glyph: mapGlyphDetail(result.data) };
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
  const result = await fetchJson<RawSignalDetail>(`${config.url}/api/signals/read?${qs}`, {
    headers: authHeaders(config.token),
  });

  if (!result.ok) {
    return { ok: false, error: "tower signal read request failed" };
  }

  return { ok: true, signal: mapSignalDetail(result.data) };
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

// --- comments (deliberate write; POST /api/comments) ------------------------
//
// Verified live (2026-07-12): the JSON body's field names match the checked-in
// convex/domain.ts CreateCommentInput exactly — { projectKey, target: {
// family, orbit, id }, body, provenance: { source, actor } } — no divergence
// from the glyphs/read and signals/read query-param gotchas above. Probed
// against a real target with a deliberately nonexistent id: the gateway
// responded 404 "Signal 'NONEXISTENT_ID_TEST' does not exist." confirming
// the shape without writing anything. The single real write required by the
// smoke test uses this exact function against vellum/forge/VL-011.
//
// This is a deliberate, narrow, user-initiated write — never automatic, never
// retried, never batched.

export const isBlankCommentBody = (body: string): boolean => body.trim().length === 0;

const postComment = async (
  config: TowerConfig,
  projectKey: string,
  target: { readonly family: "glyphs" | "signals"; readonly orbit: string; readonly id: string },
  body: string,
): Promise<SourceWriteResult> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${config.url}/api/comments`, {
      method: "POST",
      headers: { ...authHeaders(config.token), "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        projectKey,
        target,
        body: body.trim(),
        provenance: { source: "agent", actor: "vellum" },
      }),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const detail = parseErrorMessage(text);
      return { ok: false, error: detail ? `tower comment failed: ${detail}` : `tower comment failed (${response.status})` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "tower comment request failed" };
  } finally {
    clearTimeout(timer);
  }
};

// The gateway's error responses are `{ error: "...", code: "..." }`; pull the
// human-readable message out defensively, falling back to undefined so the
// caller's generic message takes over instead of surfacing raw JSON/HTML.
const parseErrorMessage = (text: string): string | undefined => {
  try {
    const parsed = JSON.parse(text) as { readonly error?: unknown };
    return typeof parsed.error === "string" ? parsed.error : undefined;
  } catch {
    return undefined;
  }
};

export const fetchTowerCommentGlyph = async (
  projectKey: string,
  orbit: string,
  glyphId: string,
  body: string,
): Promise<SourceWriteResult> => {
  if (isBlankCommentBody(body)) {
    return { ok: false, error: "comment body is empty" };
  }
  const config = loadConfig();
  if (!config) {
    return { ok: false, error: CONFIG_MISSING_ERROR };
  }
  return postComment(config, projectKey, { family: "glyphs", orbit, id: glyphId }, body);
};

export const fetchTowerCommentSignal = async (
  projectKey: string,
  orbit: string,
  signalId: string,
  body: string,
): Promise<SourceWriteResult> => {
  if (isBlankCommentBody(body)) {
    return { ok: false, error: "comment body is empty" };
  }
  const config = loadConfig();
  if (!config) {
    return { ok: false, error: CONFIG_MISSING_ERROR };
  }
  return postComment(config, projectKey, { family: "signals", orbit, id: signalId }, body);
};
