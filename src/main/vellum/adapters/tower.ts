import type { Entity, SnapshotBundle } from "@shared/entities";
import { parseJson, runCli } from "./exec";

// Shape of `tower projects --json`: `data` is a BARE ARRAY (not
// `{projects: [...]}`) of project rows. Trimmed to the fields we read.
interface TowerProjectRow {
  readonly key: string;
  readonly name: string;
  readonly updatedAt: number;
}

interface TowerProjectsResponse {
  readonly ok: boolean;
  readonly data?: ReadonlyArray<TowerProjectRow>;
}

const isProjectRow = (value: unknown): value is TowerProjectRow => {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return typeof row.key === "string" && typeof row.name === "string" && typeof row.updatedAt === "number";
};

const toBaseEntity = (row: TowerProjectRow): Entity => ({
  source: "tower",
  key: row.key,
  kind: "project",
  title: row.name,
  stats: {},
  updatedAt: new Date(row.updatedAt).toISOString(),
});

// Shape of `tower dashboard --json <key>`, trimmed to the fields we read.
// `orbits` is always the full fixed set (forge/survey/beacon/scribe/oracle)
// regardless of project — there is no per-orbit "present" flag any more, so
// "present" is redefined here as "has any glyph in any state". `signals` and
// `chatter` are full item-list arrays now (not `{present, fileCount}`
// counters) — only their length is read.
interface TowerDashboardOrbitState {
  readonly state: string;
  readonly count: number;
}

interface TowerDashboardOrbit {
  readonly orbit: string;
  readonly states: ReadonlyArray<TowerDashboardOrbitState>;
}

interface TowerDashboardResponse {
  readonly ok: boolean;
  readonly data?: {
    readonly project?: { readonly name?: string; readonly updatedAt?: number };
    readonly orbits: ReadonlyArray<TowerDashboardOrbit>;
    readonly signals?: ReadonlyArray<unknown>;
    readonly chatter?: ReadonlyArray<unknown>;
  };
}

const isOrbitState = (value: unknown): value is TowerDashboardOrbitState => {
  if (typeof value !== "object" || value === null) return false;
  const state = value as Record<string, unknown>;
  return typeof state.state === "string" && typeof state.count === "number";
};

const isOrbit = (value: unknown): value is TowerDashboardOrbit => {
  if (typeof value !== "object" || value === null) return false;
  const orbit = value as Record<string, unknown>;
  return typeof orbit.orbit === "string" && Array.isArray(orbit.states) && orbit.states.every(isOrbitState);
};

const MAX_HINTS = 8;

// Per-key enrichment: fetches `tower dashboard --json <key>` for one hinted
// project key and folds glyph/orbit/signal/chatter stats into the entity
// map. Any failure (bad exit, malformed JSON, drifted shape) degrades to a
// no-op — the base entity (from `tower projects`) survives unchanged.
const enrichDashboard = async (
  key: string,
  entities: Map<string, Entity>,
  fetchedAt: string,
): Promise<void> => {
  const result = await runCli("tower", ["dashboard", "--json", key]);
  if (!result.ok) return;

  const parsed = parseJson<TowerDashboardResponse>(result.stdout);
  const orbits = parsed?.data?.orbits;
  if (!parsed?.ok || !Array.isArray(orbits) || !orbits.every(isOrbit)) return;

  let active = 0;
  let done = 0;
  let orbitCount = 0;
  const perOrbit: Record<string, number> = {};
  for (const orbit of orbits) {
    let orbitActive = 0;
    let orbitTotal = 0;
    for (const { state, count } of orbit.states) {
      orbitTotal += count;
      if (state === "done") {
        done += count;
      } else if (state !== "abandoned") {
        orbitActive += count;
      }
    }
    active += orbitActive;
    if (orbitTotal > 0) orbitCount += 1;
    if (orbitActive > 0) perOrbit[`orbit_${orbit.orbit}`] = orbitActive;
  }

  const stats: Record<string, string | number> = {
    glyphs_active: active,
    glyphs_done: done,
    orbits: orbitCount,
    ...perOrbit,
  };
  const signals = parsed.data?.signals;
  if (Array.isArray(signals) && signals.length > 0) stats.signals = signals.length;
  const chatter = parsed.data?.chatter;
  if (Array.isArray(chatter) && chatter.length > 0) stats.chatter = chatter.length;

  const existing = entities.get(key);
  const dashboardProject = parsed.data?.project;
  const updatedAt =
    typeof dashboardProject?.updatedAt === "number"
      ? new Date(dashboardProject.updatedAt).toISOString()
      : (existing?.updatedAt ?? fetchedAt);

  entities.set(key, {
    source: "tower",
    key,
    kind: "project",
    title: existing?.title ?? dashboardProject?.name ?? key,
    stats: { ...existing?.stats, ...stats },
    updatedAt,
  });
};

// Base entity list from `tower projects --json` (one Entity per project,
// minimal stats), enriched for each hinted key via a `tower dashboard
// --json <key>` follow-up (glyph/orbit/signal/chatter stats). Mirrors the
// quasar.ts base-list + per-key-enrichment pattern.
export const fetchTowerBundle = async (
  hintKeys: ReadonlyArray<string> = [],
): Promise<SnapshotBundle> => {
  const fetchedAt = new Date().toISOString();
  const result = await runCli("tower", ["projects", "--json"]);
  if (!result.ok) {
    return {
      source: "tower",
      fetchedAt,
      ok: false,
      error: result.error ?? "`tower projects --json` failed",
      entities: [],
    };
  }

  const parsed = parseJson<TowerProjectsResponse>(result.stdout);
  if (!parsed?.ok || !Array.isArray(parsed.data)) {
    return {
      source: "tower",
      fetchedAt,
      ok: false,
      error: "unexpected response shape from `tower projects --json`",
      entities: [],
    };
  }

  const entities = new Map<string, Entity>();
  for (const row of parsed.data) {
    if (!isProjectRow(row)) continue;
    entities.set(row.key, toBaseEntity(row));
  }

  const hintedKeys = Array.from(new Set(hintKeys)).slice(0, MAX_HINTS);
  await Promise.all(hintedKeys.map((key) => enrichDashboard(key, entities, fetchedAt)));

  return { source: "tower", fetchedAt, ok: true, entities: Array.from(entities.values()) };
};
