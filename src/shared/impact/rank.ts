import type { Task } from "../work-model";
import { claimedByOf, taskBrief } from "../task";
import { needsHuman } from "../attention";
import type { ExecutionGraph, WorkItemsOf } from "../execution-graph";
import type { Canvas } from "../model/canvas";
import type { Node } from "../model/kinds";
import { titleOf } from "../model/title";
import type { OccupancySpectrumName } from "../occupancy";
import { impactCone, stoppageEnds, type ImpactCone } from "./cone";

// Rank stoppage seeds (apex generators + manual blockers) by blast-radius
// cone size. Pure: canvas + ExecutionGraph + work items (+ optional occupancy for lead
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

/** Seed candidates: nodes that emit generating wires, in canvas order. */
export const collectStoppageSeedIds = (
  canvas: Canvas,
  graph: ExecutionGraph,
): ReadonlyArray<string> => {
  const ids = new Set<string>();
  for (const wire of canvas.wires.values()) {
    const evaluation = graph.edgeEvalById.get(wire.id);
    if (evaluation?.generates) ids.add(stoppageEnds(canvas.nodes, wire).causeId);
  }
  return [...canvas.nodes.keys()].filter((id) => ids.has(id));
};

/** Items on a task seed that actually generate stoppage: claimed attention. */
const stallingItems = (items: ReadonlyArray<Task>): ReadonlyArray<Task> =>
  items.filter((item) => needsHuman(item) && claimedByOf(item) !== undefined);

const pendingRequests = (items: ReadonlyArray<Task>): ReadonlyArray<Task> =>
  items.filter((item) => item.state === "input-required");

const seedBriefOf = (node: Node | undefined, items: ReadonlyArray<Task>): string => {
  if (!node) return "stoppage";
  if (node.kind === "requests") {
    const n = pendingRequests(items).length;
    return n === 1 ? "1 request" : `${n} requests`;
  }
  if (node.kind === "task") {
    const n = stallingItems(items).length;
    return n === 1 ? "1 task" : `${n} tasks`;
  }
  return titleOf(node);
};

const clearActionOf = (
  node: Node | undefined,
  items: ReadonlyArray<Task>,
  cone: ImpactCone,
): string => {
  if (node?.kind === "requests") {
    const pending = pendingRequests(items);
    if (pending[0]) return `resolve: ${taskBrief(pending[0])}`;
  }
  if (node?.kind === "task") {
    const stalling = stallingItems(items);
    if (stalling[0]) return `settle: ${taskBrief(stalling[0])}`;
  }
  const first = cone.seedReasons[0];
  if (first?.kind === "edge" && first.detail) return `clear: ${first.detail}`;
  return "clear: stoppage";
};

/**
 * Rank every stoppage seed by cone size (desc), then seed id (asc).
 * Empty cones (no blast) are dropped.
 */
export const rankStoppageSeeds = (
  canvas: Canvas,
  graph: ExecutionGraph,
  itemsOf: WorkItemsOf,
): ReadonlyArray<RankedStoppage> => {
  const ranked: RankedStoppage[] = [];

  for (const seedNodeId of collectStoppageSeedIds(canvas, graph)) {
    const cone = impactCone(canvas, graph, seedNodeId);
    if (cone.nodeIds.size === 0) continue;
    const node = canvas.nodes.get(seedNodeId as Node["id"]);
    const items = itemsOf(seedNodeId);
    ranked.push({
      seedNodeId,
      seedBrief: seedBriefOf(node, items),
      stops: cone.nodeIds.size,
      attentionLeadIds: [...cone.attentionLeadIds].sort(),
      clearAction: clearActionOf(node, items, cone),
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
