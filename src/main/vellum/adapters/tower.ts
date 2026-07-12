import type { Entity, SnapshotBundle } from "@shared/entities";
import { parseJson, runCli } from "./exec";

// Shape of `tower status --all --json`, trimmed to the fields we read.
interface TowerStageCounts {
  readonly backlog: number;
  readonly exploring: number;
  readonly committed: number;
  readonly building: number;
  readonly reviewing: number;
  readonly done: number;
  readonly abandoned: number;
}

interface TowerOrbit {
  readonly present: boolean;
  readonly stageCounts: TowerStageCounts;
}

interface TowerProjectEntry {
  readonly ok: boolean;
  readonly status?: {
    readonly project: { readonly key: string; readonly name: string; readonly updatedAt: number };
    readonly orbits: Record<string, TowerOrbit>;
  };
}

interface TowerStatusResponse {
  readonly ok: boolean;
  readonly data?: { readonly projects: ReadonlyArray<TowerProjectEntry> };
}

const toEntity = (entry: TowerProjectEntry): Entity | undefined => {
  const status = entry.status;
  if (!entry.ok || !status) return undefined;

  let active = 0;
  let done = 0;
  let orbits = 0;
  for (const orbit of Object.values(status.orbits)) {
    if (!orbit.present) continue;
    orbits += 1;
    const counts = orbit.stageCounts;
    done += counts.done;
    active +=
      counts.backlog + counts.exploring + counts.committed + counts.building + counts.reviewing;
  }

  return {
    source: "tower",
    key: status.project.key,
    kind: "project",
    title: status.project.name,
    stats: { glyphs_active: active, glyphs_done: done, orbits },
    updatedAt: new Date(status.project.updatedAt).toISOString(),
  };
};

// Single bulk call: `status --all` already carries project identity plus
// per-orbit stageCounts, so no per-project follow-up is needed for tower.
export const fetchTowerBundle = async (): Promise<SnapshotBundle> => {
  const fetchedAt = new Date().toISOString();
  const result = await runCli("tower", ["status", "--all", "--json"]);
  if (!result.ok) {
    return {
      source: "tower",
      fetchedAt,
      ok: false,
      error: result.error ?? "tower CLI failed",
      entities: [],
    };
  }

  const parsed = parseJson<TowerStatusResponse>(result.stdout);
  if (!parsed?.ok || !parsed.data) {
    return {
      source: "tower",
      fetchedAt,
      ok: false,
      error: "unexpected response shape from `tower status --all --json`",
      entities: [],
    };
  }

  const entities = parsed.data.projects
    .map(toEntity)
    .filter((entity): entity is Entity => entity !== undefined);

  return { source: "tower", fetchedAt, ok: true, entities };
};
