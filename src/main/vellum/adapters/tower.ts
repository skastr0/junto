import type { Entity, SnapshotBundle } from "@shared/entities";
import { glyphKey, parseGlyphKey } from "@shared/refs";
import { parseJson, runCli } from "./exec";
import { fetchProjectGlyphs } from "./tower-rest";

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

// `signals` and `chatter` are sibling counters alongside `orbits`, each
// shaped { name, present, fileCount, latest? }. Only fileCount is read here.
interface TowerFileCounter {
  readonly present: boolean;
  readonly fileCount: number;
}

interface TowerProjectEntry {
  readonly ok: boolean;
  readonly status?: {
    readonly project: { readonly key: string; readonly name: string; readonly updatedAt: number };
    readonly orbits: Record<string, TowerOrbit>;
    readonly signals?: TowerFileCounter;
    readonly chatter?: TowerFileCounter;
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
  const perOrbit: Record<string, number> = {};
  for (const [name, orbit] of Object.entries(status.orbits)) {
    if (!orbit.present) continue;
    orbits += 1;
    const counts = orbit.stageCounts;
    done += counts.done;
    const orbitActive =
      counts.backlog + counts.exploring + counts.committed + counts.building + counts.reviewing;
    active += orbitActive;
    if (orbitActive > 0) perOrbit[`orbit_${name}`] = orbitActive;
  }

  const stats: Record<string, string | number> = {
    glyphs_active: active,
    glyphs_done: done,
    orbits,
    ...perOrbit,
  };
  if (status.signals && status.signals.fileCount > 0) stats.signals = status.signals.fileCount;
  if (status.chatter && status.chatter.fileCount > 0) stats.chatter = status.chatter.fileCount;

  return {
    source: "tower",
    key: status.project.key,
    kind: "project",
    title: status.project.name,
    stats,
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

// Same fanout cap the sibling hint-driven adapters use (booth.ts, quasar.ts
// MAX_HINTS): bounds the REST fanout to a small constant regardless of how
// many distinct projects the open canvas happens to bind glyphs against.
const MAX_HINT_PROJECTS = 8;

// Glyph-level drill-down: `tower status --all` only carries per-orbit
// stageCounts, not individual glyphs, so a canvas node bound to a specific
// glyph key needs a separate resolve pass over the REST API. Batches by
// project (one REST round-trip per project, not per glyph) and fetches every
// state (not just active) so a hint stays resolvable even after the glyph
// ships. Keys that don't parse as a glyph key are skipped; a project whose
// REST fetch fails contributes no entities for its keys, never throws.
export const resolveTowerGlyphHints = async (keys: ReadonlyArray<string>): Promise<Entity[]> => {
  const refByKey = new Map<string, { project: string; orbit: string; glyphId: string }>();
  for (const key of keys) {
    const ref = parseGlyphKey(key);
    if (ref) refByKey.set(key, ref);
  }
  if (refByKey.size === 0) return [];

  const projects = [...new Set([...refByKey.values()].map((ref) => ref.project))].slice(
    0,
    MAX_HINT_PROJECTS,
  );
  const glyphsByProject = new Map<string, Awaited<ReturnType<typeof fetchProjectGlyphs>>>();
  await Promise.all(
    projects.map(async (project) => {
      glyphsByProject.set(project, await fetchProjectGlyphs(project, { activeOnly: false }));
    }),
  );

  const fetchedAt = new Date().toISOString();
  const entities: Entity[] = [];
  for (const ref of refByKey.values()) {
    const bundle = glyphsByProject.get(ref.project);
    if (!bundle?.ok) continue;
    const glyph = bundle.glyphs.find((g) => g.orbit === ref.orbit && g.glyphId === ref.glyphId);
    if (!glyph) continue;
    entities.push({
      source: "tower",
      key: glyphKey(ref.project, ref.orbit, ref.glyphId),
      kind: "glyph",
      title: glyph.title,
      stats: { state: glyph.state, orbit: glyph.orbit, project: glyph.project },
      updatedAt: fetchedAt,
    });
  }
  return entities;
};
