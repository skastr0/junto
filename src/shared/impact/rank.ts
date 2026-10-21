import type { BlockedReason, ExecutionGraph } from "../execution-graph";
import type { Canvas } from "../model/canvas";
import type { Node } from "../model/kinds";
import { titleOf } from "../model/title";
import type { OccupancySpectrumName } from "../occupancy";
import { holdingTaskNodeIds, impactCone, type ImpactCone } from "./cone";

// Rank stoppage seeds (task nodes whose waiting tasks hold seats) by
// blast-radius cone size. Pure: canvas + ExecutionGraph (+ optional occupancy
// for lead staffing). UI / digest format the
// RankedStoppage rows.

export type LeadStaffing = "staffed" | "unstaffed" | "unknown";

export type RankedStoppage = {
  readonly seedNodeId: string;
  /** Glance seed phrase: "1 task", "2 tasks", or node title. */
  readonly seedBrief: string;
  /** Cone size (nodeIds) — primary rank key. */
  readonly stops: number;
  /** Actor seats with capability/soft edges into the cone. */
  readonly attentionLeadIds: ReadonlyArray<string>;
  /** Short clear-action hint (waiting task sample, seed detail, …). */
  readonly clearAction: string;
  readonly cone: ImpactCone;
};

/** Seed candidates: task nodes holding seats, in canvas order. */
export const collectStoppageSeedIds = (
  canvas: Canvas,
  graph: ExecutionGraph,
): ReadonlyArray<string> => {
  const ids = holdingTaskNodeIds(graph);
  return [...canvas.nodes.keys()].filter((id) => ids.has(id));
};

const seedBriefOf = (node: Node | undefined, cone: ImpactCone): string => {
  if (!node) return "stoppage";
  if (node.kind === "task") {
    const n = cone.seedReasons.length;
    return n === 1 ? "1 task" : `${n} tasks`;
  }
  return titleOf(node);
};

const clearActionOf = (cone: ImpactCone): string => {
  const first: BlockedReason | undefined = cone.seedReasons[0];
  if (first?.detail) return `clear: ${first.detail}`;
  return "clear: stoppage";
};

/**
 * Rank every stoppage seed by cone size (desc), then seed id (asc).
 * Empty cones (no blast) are dropped.
 */
export const rankStoppageSeeds = (
  canvas: Canvas,
  graph: ExecutionGraph,
): ReadonlyArray<RankedStoppage> => {
  const ranked: RankedStoppage[] = [];

  for (const seedNodeId of collectStoppageSeedIds(canvas, graph)) {
    const cone = impactCone(canvas, graph, seedNodeId);
    if (cone.nodeIds.size === 0) continue;
    const node = canvas.nodes.get(seedNodeId as Node["id"]);
    ranked.push({
      seedNodeId,
      seedBrief: seedBriefOf(node, cone),
      stops: cone.nodeIds.size,
      attentionLeadIds: [...cone.attentionLeadIds].sort(),
      clearAction: clearActionOf(cone),
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
 *   "1 request - stops 4 - leads: hermes (unstaffed), agent-b"
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
      : ` - leads: ${ranked.attentionLeadIds
          .map((id) => {
            const label = options.titleOf(id);
            const staff = leadStaffing(id, options.occupancyByNodeId);
            return staff === "unstaffed" ? `${label} (unstaffed)` : label;
          })
          .join(", ")}`;
  return `${ranked.seedBrief} - stops ${ranked.stops}${leads}`;
};
