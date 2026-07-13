import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  TowerBrowseResult,
  TowerGlyphRow,
  TowerSearchMatch,
  TowerSearchResult,
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
