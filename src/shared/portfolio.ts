import type { CanvasDoc, CanvasNode } from "./canvas";
import type { Entity, EntitySource, SnapshotState } from "./entities";

// Live portfolio projection: spawn identity cards for real projects the doc
// doesn't hold yet. This is NOT a seed — it is a regenerable projection of
// the corpus. A generated node stores ONLY its identity (ether.entity: kind +
// immutable name); every source connection is derived live by
// shared/connections.ts. The generator never writes per-source keys.

const normalizeName = (value: string): string => value.trim().toLowerCase();

const normalize = (entity: Entity): string => normalizeName(entity.title ?? entity.key);

const slug = (name: string): string =>
  name.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "project";

interface MergedProject {
  readonly display: string;
  // The immutable identity stamped onto the node: the tower project key when
  // tower knows the project (keys are the canonical project names), else the
  // most-active entity's display title.
  readonly name: string;
  readonly sources: Set<EntitySource>;
  readonly activity: number;
}

// The user's own GitHub orgs — the signal for "my project" vs a third-party
// repo quasar happened to index from a browsing session.
const OWNED_ORGS = ["skastr0", "castrotechstudio"];

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

// Collapse all project entities across bundles into merged projects, one per
// normalized display name. Ordered busiest-first so the most important work
// lands top-left.
export const mergeProjects = (
  state: SnapshotState,
  options: MergeOptions = {},
): ReadonlyArray<MergedProject> => {
  interface Acc {
    display: string;
    displayActivity: number;
    towerKey?: string;
    sources: Set<EntitySource>;
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
        sources: new Set<EntitySource>(),
        activity: 0,
      };
      acc.sources.add(entity.source);
      if (entity.source === "tower" && acc.towerKey === undefined) acc.towerKey = entity.key;
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
    name: acc.towerKey ?? acc.display,
    sources: acc.sources,
    activity: acc.activity,
  }));

  return merged.sort((a, b) => b.activity - a.activity || a.display.localeCompare(b.display));
};

const NODE_W = 220;
const NODE_H = 84;
const GAP_X = 60;
const GAP_Y = 70;
const COLUMNS = 6;

// Identity names already present on a doc, so a merge can skip projects that
// already have a card (idempotent re-runs, preserved user authorship).
const presentIdentities = (doc: CanvasDoc): Set<string> => {
  const names = new Set<string>();
  for (const node of doc.nodes) {
    const name = node.ether?.entity?.name;
    if (name) names.add(normalizeName(name));
  }
  return names;
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
      entity: { kind: "project", name: project.name },
    },
  };
};

// Hermes fleet agents, one node per agent. The agent's identity IS its hermes
// "<host>:<profile>" key — the label stays free-form (host suffix and all)
// because identity never derives from the title.
const agentNodes = (state: SnapshotState, present: Set<string>, originY: number): CanvasNode[] => {
  const agents = state.bundles
    .filter((bundle) => bundle.ok && bundle.source === "hermes")
    .flatMap((bundle) => bundle.entities)
    .filter((entity) => entity.kind === "agent" && !present.has(normalizeName(entity.key)));

  return agents.map((agent, index) => {
    const col = index % COLUMNS;
    const row = Math.floor(index / COLUMNS);
    const statsHost = typeof agent.stats.host === "string" ? agent.stats.host : undefined;
    const keyHost = (() => {
      const colon = agent.key.indexOf(":");
      if (colon <= 0) return undefined;
      const candidate = agent.key.slice(0, colon);
      return /^(?!-)[A-Za-z0-9][A-Za-z0-9._-]*$/.test(candidate) && candidate.length <= 64
        ? candidate
        : undefined;
    })();
    const host = statsHost ?? keyHost ?? "local";
    const label = statsHost
      ? `${agent.title ?? agent.key} · ${statsHost}`
      : (agent.title ?? agent.key);
    return {
      id: `agent-${slug(agent.key)}`,
      type: "text",
      x: col * (NODE_W + GAP_X),
      y: originY + row * (NODE_H + GAP_Y),
      width: NODE_W,
      height: NODE_H,
      text: label,
      ether: {
        entity: { kind: "agent", name: agent.key },
        host,
      },
    } as CanvasNode;
  });
};

// Merge live projects onto an existing document: keep every existing node and
// edge, append an identity card for each project not already present. New
// nodes are laid below existing content so they never cover the user's
// arrangement.
export const mergePortfolioInto = (
  doc: CanvasDoc,
  state: SnapshotState,
  options: MergeOptions = {},
): CanvasDoc => {
  const present = presentIdentities(doc);
  const fresh = mergeProjects(state, options).filter(
    (project) => !present.has(normalizeName(project.name)) && !present.has(normalizeName(project.display)),
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

  // Fleet band: below the projects just added.
  const projectRows = Math.ceil(added.length / COLUMNS);
  const agentOriginY = originY + projectRows * (NODE_H + GAP_Y) + 120;
  for (const node of agentNodes(state, present, agentOriginY)) {
    if (existingIds.has(node.id)) continue;
    existingIds.add(node.id);
    added.push(node);
  }

  return { nodes: [...doc.nodes, ...added], edges: doc.edges };
};

// Build a fresh portfolio document from scratch (ignores any existing doc).
export const buildPortfolioDoc = (state: SnapshotState): CanvasDoc =>
  mergePortfolioInto({ nodes: [], edges: [] }, state);
