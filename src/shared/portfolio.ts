import type { CanvasDoc, CanvasNode, EtherBinding } from "./canvas";
import type { Entity, EntitySource, SnapshotState } from "./entities";

// Live portfolio projection: turn the adapter snapshots into bound, hydrated
// project nodes. This is NOT a seed — it is a regenerable projection of the
// real corpus. Running it reflects whatever tower/quasar/booth report now.
//
// Merge rule: one node per real project, identified by normalized display
// name, bound to every source that knows it (tower "prism" + quasar
// "git:github.com/skastr0/prism" collapse into one node with two bindings).

const normalize = (entity: Entity): string => (entity.title ?? entity.key).trim().toLowerCase();

const slug = (name: string): string =>
  name.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "project";

interface MergedProject {
  readonly display: string;
  readonly bindings: EtherBinding[];
  readonly sources: Set<EntitySource>;
  readonly activity: number;
}

// The user's own GitHub orgs — the signal for "my project" vs a third-party
// repo quasar happened to index from a browsing session.
const OWNED_ORGS = ["skastr0", "castrotechstudio"];

const bindingFor = (entity: Entity): EtherBinding => ({
  source: entity.source,
  ref: { type: "project", key: entity.key },
}) as EtherBinding;

const activityOf = (entity: Entity): number => {
  const active = entity.stats.glyphs_active;
  if (typeof active === "number") return active;
  const sessions = entity.stats.sessions;
  return typeof sessions === "number" ? sessions : 0;
};

const isOwned = (entity: Entity): boolean =>
  entity.source === "tower" || OWNED_ORGS.some((org) => entity.key.includes(`/${org}/`));

export interface MergeOptions {
  // When true, keep every indexed project (including third-party repos quasar
  // saw). Default keeps only tower-registered + owned-org projects.
  readonly all?: boolean;
}

// Collapse all project entities across bundles into merged projects. Within a
// single source, the highest-activity entity wins (so an empty duplicate board
// key like "PRISM" never shadows the real "prism"). Ordered busiest-first so
// the most important work lands top-left.
export const mergeProjects = (
  state: SnapshotState,
  options: MergeOptions = {},
): ReadonlyArray<MergedProject> => {
  interface Acc {
    display: string;
    displayActivity: number;
    bestPerSource: Map<EntitySource, { key: string; activity: number }>;
    activity: number;
  }
  const byName = new Map<string, Acc>();

  for (const bundle of state.bundles) {
    if (!bundle.ok) continue;
    for (const entity of bundle.entities) {
      if (entity.kind !== "project") continue;
      if (!options.all && !isOwned(entity)) continue;
      const name = normalize(entity);
      const activity = activityOf(entity);
      const acc = byName.get(name) ?? {
        display: entity.title ?? entity.key,
        displayActivity: -1,
        bestPerSource: new Map(),
        activity: 0,
      };
      // Best binding per source = highest activity within that source.
      const prev = acc.bestPerSource.get(entity.source);
      if (!prev || activity > prev.activity) {
        acc.bestPerSource.set(entity.source, { key: entity.key, activity });
      }
      // Display name from the single most-active entity across all sources.
      if (activity > acc.displayActivity) {
        acc.display = entity.title ?? entity.key;
        acc.displayActivity = activity;
      }
      acc.activity = Math.max(acc.activity, activity);
      byName.set(name, acc);
    }
  }

  const merged: MergedProject[] = [...byName.values()].map((acc) => ({
    display: acc.display,
    activity: acc.activity,
    sources: new Set(acc.bestPerSource.keys()),
    bindings: [...acc.bestPerSource.entries()].map(([source, { key }]) => ({
      source,
      ref: { type: "project" as const, key },
    })) as EtherBinding[],
  }));

  return merged.sort((a, b) => b.activity - a.activity || a.display.localeCompare(b.display));
};

const NODE_W = 220;
const NODE_H = 84;
const GAP_X = 60;
const GAP_Y = 70;
const COLUMNS = 6;

// Keys already bound anywhere on a doc, so a merge can skip projects that are
// already present (idempotent re-runs, preserved user authorship).
const boundKeys = (doc: CanvasDoc): Set<string> => {
  const keys = new Set<string>();
  for (const node of doc.nodes) {
    for (const binding of node.ether?.bindings ?? []) keys.add(`${binding.source}:${binding.ref.key}`);
  }
  return keys;
};

const projectNode = (project: MergedProject, index: number, originX: number, originY: number): CanvasNode => {
  const col = index % COLUMNS;
  const row = Math.floor(index / COLUMNS);
  return {
    id: `proj-${slug(project.display)}`,
    type: "text",
    x: originX + col * (NODE_W + GAP_X),
    y: originY + row * (NODE_H + GAP_Y),
    width: NODE_W,
    height: NODE_H,
    text: project.display,
    ether: {
      entity: { kind: "project" },
      bindings: project.bindings,
    },
  };
};

// Merge live projects onto an existing document: keep every existing node and
// edge, append a bound node for each project not already bound. New nodes are
// laid below existing content so they never cover the user's arrangement.
export const mergePortfolioInto = (
  doc: CanvasDoc,
  state: SnapshotState,
  options: MergeOptions = {},
): CanvasDoc => {
  const already = boundKeys(doc);
  const fresh = mergeProjects(state, options).filter(
    (project) => !project.bindings.some((b) => already.has(`${b.source}:${b.ref.key}`)),
  );
  const existingIds = new Set(doc.nodes.map((n) => n.id));
  const maxY = doc.nodes.reduce((m, n) => Math.max(m, n.y + n.height), 0);
  const originY = doc.nodes.length > 0 ? maxY + 120 : 0;

  const added: CanvasNode[] = [];
  fresh.forEach((project, index) => {
    const node = projectNode(project, index, 0, originY);
    // Guard against id collision with an existing node of the same slug.
    if (existingIds.has(node.id)) return;
    existingIds.add(node.id);
    added.push(node);
  });

  return { nodes: [...doc.nodes, ...added], edges: doc.edges };
};

// Build a fresh portfolio document from scratch (ignores any existing doc).
export const buildPortfolioDoc = (state: SnapshotState): CanvasDoc =>
  mergePortfolioInto({ nodes: [], edges: [] }, state);
