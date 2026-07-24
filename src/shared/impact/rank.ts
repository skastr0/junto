import type { CanvasDoc, CanvasNode } from "../canvas";
import { isTerminalTaskState, taskBrief } from "../task";
import type { ExecutionGraph } from "../execution-graph";
import type { OccupancySpectrumName } from "../occupancy";
import { impactCone, type ImpactCone } from "./cone";

// Rank stoppage seeds (apex generators + manual blockers) by blast-radius
// cone size. Pure: document + ExecutionGraph (+ optional occupancy for lead
// staffing). UI / digest format the RankedStoppage rows.

export type LeadStaffing = "staffed" | "unstaffed" | "unknown";

export type RankedStoppage = {
  readonly seedNodeId: string;
  /** Glance seed phrase: "1 request", "2 tasks", "blocker", or node title. */
  readonly seedBrief: string;
  /** Cone size (nodeIds) — primary rank key. */
  readonly stops: number;
  /** Actor seats with capability/soft edges into the cone. */
  readonly attentionLeadIds: ReadonlyArray<string>;
  /** Short clear-action hint (open request/task sample, seed detail, …). */
  readonly clearAction: string;
  readonly cone: ImpactCone;
};

const titleOf = (node: CanvasNode | undefined, fallback: string): string => {
  if (!node) return fallback;
  switch (node.type) {
    case "text":
      return (node.text.split("\n")[0] ?? "").trim() || fallback;
    case "file":
      return node.file.split(/[\\/]/).pop() ?? node.file;
    case "link":
      return node.url;
    case "group":
      return node.label ?? node.id;
  }
};

/** Seed candidates: manual blockers + nodes that emit generating edges. */
export const collectStoppageSeedIds = (
  doc: CanvasDoc,
  graph: ExecutionGraph,
): ReadonlyArray<string> => {
  const ids = new Set<string>();
  for (const id of graph.seedNodeIds) ids.add(id);
  for (const edge of doc.edges) {
    const evaluation = graph.edgeEvalById.get(edge.id);
    if (evaluation?.generates) ids.add(edge.fromNode);
  }
  // Deterministic document order.
  return doc.nodes.map((n) => n.id).filter((id) => ids.has(id));
};

const seedBriefOf = (node: CanvasNode | undefined, isManualSeed: boolean): string => {
  if (!node) return isManualSeed ? "blocker" : "stoppage";
  const kind = node.ether?.entity?.kind;
  if (kind === "requests") {
    const items = node.ether?.requests?.items ?? [];
    const pending = items.filter((item) => item.state === "input-required");
    const n = pending.length;
    return n === 1 ? "1 request" : `${n} requests`;
  }
  if (kind === "task") {
    const items = node.ether?.tasks?.items ?? [];
    const open = items.filter((item) => !isTerminalTaskState(item.state));
    const n = open.length;
    return n === 1 ? "1 task" : `${n} tasks`;
  }
  if (isManualSeed || node.ether?.flags?.includes("blocker")) return "blocker";
  return titleOf(node, node.id);
};

const clearActionOf = (
  node: CanvasNode | undefined,
  cone: ImpactCone,
): string => {
  const kind = node?.ether?.entity?.kind;
  if (kind === "requests") {
    const pending = (node?.ether?.requests?.items ?? []).filter(
      (item) => item.state === "input-required",
    );
    if (pending[0]) return `resolve: ${taskBrief(pending[0])}`;
  }
  if (kind === "task") {
    const open = (node?.ether?.tasks?.items ?? []).filter(
      (item) => !isTerminalTaskState(item.state),
    );
    if (open[0]) return `settle: ${taskBrief(open[0])}`;
  }
  const first = cone.seedReasons[0];
  if (first?.kind === "edge" && first.detail) return `clear: ${first.detail}`;
  if (first?.kind === "seed" && first.detail) return `clear: ${first.detail}`;
  if (node?.ether?.flags?.includes("blocker")) return "clear: blocker flag";
  return "clear: stoppage";
};

/**
 * Rank every stoppage seed by cone size (desc), then seed id (asc).
 * Empty cones (no blast) are dropped.
 */
export const rankStoppageSeeds = (
  doc: CanvasDoc,
  graph: ExecutionGraph,
): ReadonlyArray<RankedStoppage> => {
  const byId = new Map(doc.nodes.map((n) => [n.id, n] as const));
  const ranked: RankedStoppage[] = [];

  for (const seedNodeId of collectStoppageSeedIds(doc, graph)) {
    const cone = impactCone(doc, graph, seedNodeId);
    if (cone.nodeIds.size === 0) continue;
    // Prefer apex-rooted cones: if this seed is not in its own cone apex set
    // (nodeIds always includes apexes; generators/seeds are always present).
    const node = byId.get(seedNodeId);
    ranked.push({
      seedNodeId,
      seedBrief: seedBriefOf(node, graph.seedNodeIds.has(seedNodeId)),
      stops: cone.nodeIds.size,
      attentionLeadIds: [...cone.attentionLeadIds].sort(),
      clearAction: clearActionOf(node, cone),
      cone,
    });
  }

  ranked.sort((a, b) => {
    if (b.stops !== a.stops) return b.stops - a.stops;
    return a.seedNodeId < b.seedNodeId ? -1 : a.seedNodeId > b.seedNodeId ? 1 : 0;
  });
  return ranked;
};

/** Staffing of an attention lead given optional live occupancy. */
export const leadStaffing = (
  leadId: string,
  occupancyByNodeId?: ReadonlyMap<string, OccupancySpectrumName>,
): LeadStaffing => {
  if (!occupancyByNodeId) return "unknown";
  const state = occupancyByNodeId.get(leadId);
  if (state === undefined) return "unknown";
  if (state === "empty" || state === "gone") return "unstaffed";
  return "staffed";
};

/**
 * Format one RTS/digest line:
 *   "1 request · stops 4 · leads: hermes (unstaffed), agent-b"
 */
export const formatRankedStoppageLine = (
  ranked: RankedStoppage,
  options: {
    readonly titleOf: (nodeId: string) => string;
    readonly occupancyByNodeId?: ReadonlyMap<string, OccupancySpectrumName>;
  },
): string => {
  const leads =
    ranked.attentionLeadIds.length === 0
      ? ""
      : ` · leads: ${ranked.attentionLeadIds
          .map((id) => {
            const label = options.titleOf(id);
            const staff = leadStaffing(id, options.occupancyByNodeId);
            return staff === "unstaffed" ? `${label} (unstaffed)` : label;
          })
          .join(", ")}`;
  return `${ranked.seedBrief} · stops ${ranked.stops}${leads}`;
};
