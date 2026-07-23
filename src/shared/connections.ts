import type { CanvasDoc, EtherEntity } from "./canvas";
import type { Entity, EntitySource, SnapshotState } from "./entities";
import type { BindingHint } from "./ipc";

// The ONE place node identity joins the live corpus. A node stores only what
// it IS (ether.entity: kind + immutable name); which tower project, quasar
// repos, booth project, or hermes agent it connects to is DERIVED here, per
// snapshot, and never written back into the document (kernel law #1: derived
// state is never stored).
//
// Resolution tiers, per source — deterministic, never fuzzy:
//   1. declared linkage — the corpus states the join itself (booth's
//      towerProjectKey, forwarded as the tower_project stat)
//   2. exact key equality — keys are unique within a source
//   3. exact normalized-title equality — multiple hits are FACETS of the same
//      project (quasar's git: + path: repos), joined ALL, most-active first
//   4. nothing — the connection simply doesn't exist yet; quiet, no guessing
//
// Agents don't infer: kind "agent" nodes carry their hermes "<host>:<profile>"
// key AS their identity name, so the connection is declared, present or not
// in the current hermes bundle.

export interface Connection {
  readonly source: EntitySource;
  readonly key: string;
  // The live corpus entity backing this connection. Absent only for the
  // identity-declared hermes connection when the agent isn't in the current
  // bundle — the key must survive an offline fleet (chat/pulse routing).
  readonly entity?: Entity;
}

const normalize = (value: string): string => value.trim().toLowerCase();

// Built once per snapshot, O(corpus); every node resolution is O(1) lookups.
export interface ConnectionIndex {
  readonly byKey: ReadonlyMap<string, Entity>; // `${source}:${key}`
  readonly byName: ReadonlyMap<string, ReadonlyArray<Entity>>; // `${source}:${normalized title}`
  readonly boothByTowerLink: ReadonlyMap<string, Entity>; // tower_project stat -> booth entity
}

const sessionsOf = (entity: Entity): number => {
  const value = entity.stats.sessions;
  return typeof value === "number" ? value : 0;
};

export const buildConnectionIndex = (snapshots: SnapshotState): ConnectionIndex => {
  const byKey = new Map<string, Entity>();
  const byName = new Map<string, Entity[]>();
  const boothByTowerLink = new Map<string, Entity>();

  for (const bundle of snapshots.bundles) {
    for (const entity of bundle.entities) {
      // A failed bundle may still carry facts observed during this exact
      // partial attempt. Admit only those explicit current rows; unspecified
      // or retained stale facts must not become authoritative connections.
      if (!bundle.ok && entity.stale !== false) continue;
      byKey.set(`${entity.source}:${entity.key}`, entity);
      const nameKey = `${entity.source}:${normalize(entity.title ?? entity.key)}`;
      const bucket = byName.get(nameKey);
      if (bucket) bucket.push(entity);
      else byName.set(nameKey, [entity]);
      if (entity.source === "booth" && typeof entity.stats.tower_project === "string") {
        boothByTowerLink.set(entity.stats.tower_project, entity);
      }
    }
  }

  // Facets surface most-active first so "the primary facet" is index 0.
  for (const bucket of byName.values()) {
    if (bucket.length > 1) bucket.sort((a, b) => sessionsOf(b) - sessionsOf(a));
  }

  return { byKey, byName, boothByTowerLink };
};

const lookupOne = (index: ConnectionIndex, source: EntitySource, name: string): Entity | undefined =>
  index.byKey.get(`${source}:${name}`) ?? index.byName.get(`${source}:${normalize(name)}`)?.[0];

export const resolveConnections = (
  entity: EtherEntity | undefined,
  index: ConnectionIndex,
): ReadonlyArray<Connection> => {
  const name = entity?.name;
  if (!name) return [];

  if (entity.kind === "agent") {
    const live = index.byKey.get(`hermes:${name}`);
    return [{ source: "hermes", key: name, ...(live === undefined ? {} : { entity: live }) }];
  }

  const connections: Connection[] = [];

  const tower = lookupOne(index, "tower", name);
  if (tower) connections.push({ source: "tower", key: tower.key, entity: tower });

  // quasar: every facet of this project (git identity + local checkouts),
  // most-active first — never collapsed to one at resolution time.
  const facets = index.byName.get(`quasar:${normalize(name)}`) ?? [];
  for (const facet of facets) connections.push({ source: "quasar", key: facet.key, entity: facet });
  if (facets.length === 0) {
    const direct = index.byKey.get(`quasar:${name}`);
    if (direct) connections.push({ source: "quasar", key: direct.key, entity: direct });
  }

  const booth =
    index.boothByTowerLink.get(tower?.key ?? name) ?? lookupOne(index, "booth", name);
  if (booth) connections.push({ source: "booth", key: booth.key, entity: booth });

  return connections;
};

// Convenience for one-shot call sites; index-building callers (per-frame UI)
// should build the index once per snapshot and share it.
export const resolveNodeConnections = (
  entity: EtherEntity | undefined,
  snapshots: SnapshotState,
): ReadonlyArray<Connection> => resolveConnections(entity, buildConnectionIndex(snapshots));

export const connectionKey = (
  connections: ReadonlyArray<Connection>,
  source: EntitySource,
): string | undefined => connections.find((connection) => connection.source === source)?.key;

export const connectionKeys = (
  connections: ReadonlyArray<Connection>,
  source: EntitySource,
): ReadonlyArray<string> =>
  connections.filter((connection) => connection.source === source).map((connection) => connection.key);

// Adapter enrichment hints, derived from identity resolution over documents —
// the replacement for the stored-bindings hint unions. Resolution runs against
// the CURRENT snapshot: on a cold start the base project lists arrive
// unhinted, the next cycle resolves against them and enriches — convergence
// within two polls, by design.
export const identityHints = (
  docs: Iterable<CanvasDoc>,
  snapshots: SnapshotState,
): ReadonlyArray<BindingHint> => {
  const index = buildConnectionIndex(snapshots);
  const seen = new Set<string>();
  const hints: BindingHint[] = [];
  for (const doc of docs) {
    for (const node of doc.nodes) {
      for (const connection of resolveConnections(node.ether?.entity, index)) {
        const dedup = `${connection.source}:${connection.key}`;
        if (seen.has(dedup)) continue;
        seen.add(dedup);
        hints.push({ source: connection.source, key: connection.key });
      }
    }
  }
  return hints;
};
