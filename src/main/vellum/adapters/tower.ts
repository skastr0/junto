import type { Entity, SnapshotBundle } from "@shared/entities";
import { parseJson, runCli } from "./exec";

// Shape of `tower dashboards --json`: ONE bulk authority roundtrip returning
// every project pre-enriched (~0.75s for the whole fleet), replacing the old
// `tower projects` + per-hint `tower dashboard <key>` fan-out. `data` is a
// BARE ARRAY of summaries. `orbits` is always the full fixed set
// (forge/survey/beacon/scribe/oracle) with per-state counts — "present" is
// derived as "has any glyph in any state". `signals`/`chatter` are
// server-computed rollup counters.
interface TowerOrbitState {
  readonly state: string;
  readonly count: number;
}

interface TowerOrbitSummary {
  readonly orbit: string;
  readonly states: ReadonlyArray<TowerOrbitState>;
}

interface TowerDashboardSummary {
  readonly project: { readonly key: string; readonly name: string; readonly updatedAt: number };
  readonly orbits: ReadonlyArray<TowerOrbitSummary>;
  readonly signals?: { readonly total?: number };
  readonly chatter?: { readonly total?: number };
}

interface TowerDashboardsResponse {
  readonly ok: boolean;
  readonly data?: ReadonlyArray<unknown>;
}

const isOrbitState = (value: unknown): value is TowerOrbitState => {
  if (typeof value !== "object" || value === null) return false;
  const state = value as Record<string, unknown>;
  return typeof state.state === "string" && typeof state.count === "number";
};

const isOrbitSummary = (value: unknown): value is TowerOrbitSummary => {
  if (typeof value !== "object" || value === null) return false;
  const orbit = value as Record<string, unknown>;
  return typeof orbit.orbit === "string" && Array.isArray(orbit.states) && orbit.states.every(isOrbitState);
};

const isDashboardSummary = (value: unknown): value is TowerDashboardSummary => {
  if (typeof value !== "object" || value === null) return false;
  const summary = value as Record<string, unknown>;
  const project = summary.project as Record<string, unknown> | undefined;
  return (
    typeof project === "object" &&
    project !== null &&
    typeof project.key === "string" &&
    typeof project.name === "string" &&
    typeof project.updatedAt === "number" &&
    Array.isArray(summary.orbits) &&
    summary.orbits.every(isOrbitSummary)
  );
};

const toEntity = (summary: TowerDashboardSummary): Entity => {
  let active = 0;
  let done = 0;
  let orbitCount = 0;
  const perOrbit: Record<string, number> = {};
  for (const orbit of summary.orbits) {
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
  if (typeof summary.signals?.total === "number" && summary.signals.total > 0) {
    stats.signals = summary.signals.total;
  }
  if (typeof summary.chatter?.total === "number" && summary.chatter.total > 0) {
    stats.chatter = summary.chatter.total;
  }

  return {
    source: "tower",
    key: summary.project.key,
    kind: "project",
    title: summary.project.name,
    stats,
    updatedAt: new Date(summary.project.updatedAt).toISOString(),
  };
};

// Single bulk call: every project arrives fully enriched, so there is no
// hint mechanism any more. A malformed top-level response degrades to an
// explicit ok:false naming the command (never ok:true with silently-empty
// entities); a malformed individual row is skipped so one drifted project
// cannot take down the rest of the fleet.
export const fetchTowerBundle = async (): Promise<SnapshotBundle> => {
  const fetchedAt = new Date().toISOString();
  const result = await runCli("tower", ["dashboards", "--json"]);
  if (!result.ok) {
    return {
      source: "tower",
      fetchedAt,
      ok: false,
      error: result.error ?? "`tower dashboards --json` failed",
      entities: [],
    };
  }

  const parsed = parseJson<TowerDashboardsResponse>(result.stdout);
  if (!parsed?.ok || !Array.isArray(parsed.data)) {
    return {
      source: "tower",
      fetchedAt,
      ok: false,
      error: "unexpected response shape from `tower dashboards --json`",
      entities: [],
    };
  }

  const entities = parsed.data.filter(isDashboardSummary).map(toEntity);
  return { source: "tower", fetchedAt, ok: true, entities };
};
