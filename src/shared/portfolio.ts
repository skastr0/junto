import type { CanvasDoc, CanvasNode } from "./canvas";
import type { Entity, SnapshotState } from "./entities";
import { DEFAULT_STATION_HOST_ID, isValidStationHostId } from "./station";

// Live portfolio projection: spawn identity cards for hermes agents the doc
// doesn't hold yet. Project cards were excised with the private-source plane;
// existing project nodes on operator canvases still decode and render as notes.

const normalizeName = (value: string): string => value.trim().toLowerCase();

const slug = (name: string): string =>
  name.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "agent";

export interface MergeOptions {
  // Retained for API stability (populate / generatePortfolio callers).
  // Project filtering is gone; agents are always merged.
  readonly all?: boolean;
  /**
   * Entity ids that must not be re-minted (archived or soft_deleted registry
   * rows). Deterministic portfolio agent ids (`agent-${slug}`) that match are
   * skipped so generatePortfolio cannot silently revive deleted cards.
   */
  readonly suppressEntityIds?: ReadonlySet<string>;
}

const NODE_W = 220;
const NODE_H = 84;
const GAP_X = 60;
const GAP_Y = 70;
const COLUMNS = 6;

/**
 * Physical execution host for a Hermes snapshot entity.
 *
 * `stats.host` is presentation only. Canonical identity is the RemoteHost.id
 * published in `stats.hostId`.
 */
export const snapshotAgentHostId = (
  agent: Pick<Entity, "key" | "stats">,
  stationHostId = DEFAULT_STATION_HOST_ID,
): string => {
  const canonical =
    typeof agent.stats.hostId === "string" ? agent.stats.hostId : undefined;
  return canonical !== undefined && isValidStationHostId(canonical)
    ? canonical
    : stationHostId;
};

/**
 * Hermes entities remain useful on an unhealthy partial bundle. Snapshot
 * retention marks each entity stale/current individually; bundle.ok is source
 * health, not permission to erase the successfully observed rows.
 */
export const hermesAgentsFromSnapshots = (
  state: SnapshotState,
): ReadonlyArray<Entity> =>
  state.bundles
    .filter((bundle) => bundle.source === "hermes")
    .flatMap((bundle) => bundle.entities)
    .filter((entity) => entity.kind === "agent");

// Identity names already present on a doc, so a merge can skip agents that
// already have a card (idempotent re-runs, preserved user authorship).
const presentIdentities = (doc: CanvasDoc): Set<string> => {
  const names = new Set<string>();
  for (const node of doc.nodes) {
    const name = node.ether?.entity?.name;
    if (name) names.add(normalizeName(name));
  }
  return names;
};

// Hermes fleet agents, one node per agent. The agent's identity IS its hermes
// "<host>:<profile>" key — the label stays free-form (host suffix and all)
// because identity never derives from the title.
const agentNodes = (
  state: SnapshotState,
  present: Set<string>,
  originY: number,
  suppressEntityIds: ReadonlySet<string>,
): CanvasNode[] => {
  const agents = hermesAgentsFromSnapshots(state)
    .filter((entity) => !present.has(normalizeName(entity.key)));

  return agents.flatMap((agent, index) => {
    const id = `agent-${slug(agent.key)}`;
    if (suppressEntityIds.has(id)) return [];
    const col = index % COLUMNS;
    const row = Math.floor(index / COLUMNS);
    const statsHost = typeof agent.stats.host === "string" ? agent.stats.host : undefined;
    const host = snapshotAgentHostId(agent);
    const label = statsHost
      ? `${agent.title ?? agent.key} - ${statsHost}`
      : (agent.title ?? agent.key);
    return [
      {
        id,
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
      } as CanvasNode,
    ];
  });
};

// Merge live hermes agents onto an existing document: keep every existing
// node and edge, append an identity card for each agent not already present.
export const mergePortfolioInto = (
  doc: CanvasDoc,
  state: SnapshotState,
  options: MergeOptions = {},
): CanvasDoc => {
  const present = presentIdentities(doc);
  const existingIds = new Set(doc.nodes.map((n) => n.id));
  const maxY = doc.nodes.reduce((m, n) => Math.max(m, n.y + n.height), 0);
  const originY = doc.nodes.length > 0 ? maxY + 120 : 0;
  const suppressEntityIds = options.suppressEntityIds ?? new Set<string>();

  const added: CanvasNode[] = [];
  for (const node of agentNodes(state, present, originY, suppressEntityIds)) {
    if (existingIds.has(node.id)) continue;
    if (suppressEntityIds.has(node.id)) continue;
    existingIds.add(node.id);
    added.push(node);
  }

  return { nodes: [...doc.nodes, ...added], edges: doc.edges };
};

// Build a fresh portfolio document from scratch (ignores any existing doc).
export const buildPortfolioDoc = (state: SnapshotState): CanvasDoc =>
  mergePortfolioInto({ nodes: [], edges: [] }, state);
