import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Tower's full glyph lists are not in the tower CLI — they live in the REST
// API that tower-control fronts. Config (url + token) is written by
// tower-control at ~/.tower-control/config.json. This adapter is read-only
// and never throws: every failure mode (missing config, unreachable host,
// bad response) folds into an ok:false result.

export interface TowerRestConfig {
  readonly url: string;
  readonly token: string;
}

const CONFIG_PATH = join(homedir(), ".tower-control", "config.json");

const loadConfig = async (): Promise<TowerRestConfig | undefined> => {
  try {
    const raw = await readFile(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<TowerRestConfig>;
    if (typeof parsed.url !== "string" || typeof parsed.token !== "string") return undefined;
    return { url: parsed.url, token: parsed.token };
  } catch {
    return undefined;
  }
};

export interface TowerGlyph {
  readonly project: string;
  readonly orbit: string;
  readonly glyphId: string;
  readonly title: string;
  readonly state: string;
}

export interface FetchProjectGlyphsResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly glyphs: ReadonlyArray<TowerGlyph>;
}

export interface FetchProjectGlyphsOptions {
  // Drop glyphs in a terminal state ("done" | "abandoned"). Default true.
  readonly activeOnly?: boolean;
  readonly orbits?: ReadonlyArray<string>;
}

// GET /api/glyphs?projectKey=<key>&orbit=<orbit> -> { orbit, items: [...] }.
// Sampled directly against the live prism/vellum boards before wiring this
// in; fields beyond these four are present on `items` but unused here.
interface GlyphsApiItem {
  readonly glyphId?: string;
  readonly orbit?: string;
  readonly title?: string;
  readonly state?: string;
}

interface GlyphsApiResponse {
  readonly orbit?: string;
  readonly items?: ReadonlyArray<GlyphsApiItem>;
}

export const DEFAULT_ORBITS = ["forge", "beacon", "scribe", "survey", "oracle"] as const;

const TERMINAL_STATES = new Set(["done", "abandoned"]);
const TIMEOUT_MS = 12_000;

// Fetch one orbit's glyphs. Returns undefined on any failure (network, HTTP
// error, malformed body) — the caller treats that as "this orbit is silent",
// not a total failure of the project fetch.
const fetchOrbit = async (
  config: TowerRestConfig,
  project: string,
  orbit: string,
): Promise<ReadonlyArray<TowerGlyph> | undefined> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const url = `${config.url}/api/glyphs?projectKey=${encodeURIComponent(project)}&orbit=${encodeURIComponent(orbit)}`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${config.token}` },
      signal: controller.signal,
    });
    if (!response.ok) return undefined;

    const parsed = (await response.json()) as GlyphsApiResponse;
    if (!Array.isArray(parsed.items)) return undefined;

    const glyphs: TowerGlyph[] = [];
    for (const item of parsed.items) {
      if (typeof item.glyphId !== "string" || typeof item.title !== "string" || typeof item.state !== "string") {
        continue;
      }
      glyphs.push({
        project,
        orbit: typeof item.orbit === "string" ? item.orbit : orbit,
        glyphId: item.glyphId,
        title: item.title,
        state: item.state,
      });
    }
    return glyphs;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
};

// Fetches one project's glyph board across orbits, concurrently, tolerant of
// per-orbit failure (a silent orbit just contributes nothing). Only fails
// (ok:false) when every orbit request failed or the config itself is
// missing/malformed.
export const fetchProjectGlyphs = async (
  project: string,
  opts: FetchProjectGlyphsOptions = {},
): Promise<FetchProjectGlyphsResult> => {
  const config = await loadConfig();
  if (!config) {
    return { ok: false, error: `missing or invalid tower-control config at ${CONFIG_PATH}`, glyphs: [] };
  }

  const orbits = opts.orbits ?? DEFAULT_ORBITS;
  const activeOnly = opts.activeOnly ?? true;

  const perOrbit = await Promise.all(orbits.map((orbit) => fetchOrbit(config, project, orbit)));

  const failedOrbits: string[] = [];
  const glyphs: TowerGlyph[] = [];
  orbits.forEach((orbit, index) => {
    const result = perOrbit[index];
    if (result === undefined) {
      failedOrbits.push(orbit);
      return;
    }
    for (const glyph of result) {
      if (activeOnly && TERMINAL_STATES.has(glyph.state)) continue;
      glyphs.push(glyph);
    }
  });

  if (failedOrbits.length === orbits.length) {
    return {
      ok: false,
      error: `all orbit requests failed for project "${project}" (${failedOrbits.join(", ")})`,
      glyphs: [],
    };
  }

  return { ok: true, glyphs };
};
