import type { Canvas } from "../model/canvas";
import type { Node } from "../model/kinds";
import type { BlockedReason, ExecutionGraph } from "../execution-graph";
import { seatMayBeBlocked } from "../physics/phase-membership";

// Pure stoppage impact cone: derived from (canvas + ExecutionGraph).
// A stop is a task waiting for input that holds its assignee. Its cone is
// the task node and every seat it holds; nothing travels along a wire.

export type ImpactCone = {
  readonly rootId: string;
  /** The waiting tasks that make this cone, one per held seat and task. */
  readonly seedReasons: ReadonlyArray<BlockedReason>;
  /** Nodes in the cone: the task nodes that hold seats, and those seats. */
  readonly nodeIds: ReadonlySet<string>;
  /** Wires lit with the cone. Stoppage lights none; a connection focus does. */
  readonly edgeIds: ReadonlySet<string>;
  /**
   * Soft attention leads: phase-member seats (actors under current law) with an
   * undirected edge into a cone node but not already in nodeIds.
   */
  readonly attentionLeadIds: ReadonlySet<string>;
  /**
   * Path from `nodeId` to the task node holding it, inclusive.
   * Empty when `nodeId` is outside the cone.
   */
  readonly pathToSeed: (nodeId: string) => ReadonlyArray<string>;
};

const emptyCone = (rootId: string): ImpactCone => ({
  rootId,
  seedReasons: [],
  nodeIds: new Set(),
  edgeIds: new Set(),
  attentionLeadIds: new Set(),
  pathToSeed: () => [],
});

/** Physics seat that may enter the blocked set (actors under current law). */
const isPhaseMemberSeat = (node: Node | undefined): boolean => {
  if (!node) return false;
  return seatMayBeBlocked({ isGroup: node.kind === "region", kind: node.kind });
};

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const sortReasons = (reasons: ReadonlyArray<BlockedReason>): BlockedReason[] =>
  [...reasons].sort((a, b) => byText(a.taskNodeId, b.taskNodeId) || byText(a.taskId, b.taskId));

/** Task nodes that hold at least one seat, as the graph says. */
export const holdingTaskNodeIds = (graph: ExecutionGraph): ReadonlySet<string> => {
  const ids = new Set<string>();
  for (const reasons of graph.reasonsByNodeId.values()) {
    for (const reason of reasons) ids.add(reason.taskNodeId);
  }
  return ids;
};

/**
 * Derive the stoppage impact cone for `rootNodeId`.
 *
 * - Root is a task node holding seats → the cone is that node and its seats.
 * - Root is a blocked seat → the cone is every task node holding it, and
 *   every seat those nodes hold.
 * - Otherwise the cone is empty.
 */
export const impactCone = (
  canvas: Canvas,
  graph: ExecutionGraph,
  rootNodeId: string,
): ImpactCone => {
  const byId = canvas.nodes;
  if (!byId.has(rootNodeId as Node["id"])) return emptyCone(rootNodeId);

  const apexes = new Set<string>();
  if (holdingTaskNodeIds(graph).has(rootNodeId)) apexes.add(rootNodeId);
  for (const reason of graph.reasonsByNodeId.get(rootNodeId) ?? []) apexes.add(reason.taskNodeId);
  if (apexes.size === 0) return emptyCone(rootNodeId);

  const nodeIds = new Set<string>(apexes);
  const seeds: BlockedReason[] = [];
  const heldBy = new Map<string, string>();
  for (const [seatId, reasons] of graph.reasonsByNodeId) {
    const inCone = sortReasons(reasons.filter((reason) => apexes.has(reason.taskNodeId)));
    if (inCone.length === 0) continue;
    nodeIds.add(seatId);
    heldBy.set(seatId, inCone[0]!.taskNodeId);
    seeds.push(...inCone);
  }

  const pathToSeed = (nodeId: string): ReadonlyArray<string> => {
    if (apexes.has(nodeId)) return [nodeId];
    const apex = heldBy.get(nodeId);
    return apex === undefined ? [] : [nodeId, apex];
  };

  // Soft attention leads: undirected edge from actor seat into cone node.
  const attentionLeadIds = new Set<string>();
  for (const edge of canvas.wires.values()) {
    const aIn = nodeIds.has(edge.from);
    const bIn = nodeIds.has(edge.to);
    if (aIn === bIn) continue;
    const outsiderId = aIn ? edge.to : edge.from;
    if (isPhaseMemberSeat(byId.get(outsiderId))) attentionLeadIds.add(outsiderId);
  }

  return {
    rootId: rootNodeId,
    seedReasons: sortReasons(seeds),
    nodeIds,
    edgeIds: new Set(),
    attentionLeadIds,
    pathToSeed,
  };
};
