import type { BlockedReason, ExecutionGraph } from "../execution-graph";
import type { Canvas } from "../model/canvas";
import type { Node } from "../model/kinds";
import { titleOf } from "../model/title";
import { holdingTaskNodeIds, impactCone } from "./cone";

// Path from a blocked seat to the task node holding it. Walks
// cone.pathToSeed and attaches reasonsByNodeId at every hop.

export type WaitingOnHop = {
  readonly nodeId: string;
  /** Title-ready fallback is the node id; callers map via titleOf. */
  readonly reasons: ReadonlyArray<BlockedReason>;
  /**
   * Position in the walk:
   * - `blocked` — the held seat
   * - `generator` — the task node whose waiting task holds it
   * - `apex` — a terminal hop that holds no seat (fallback)
   */
  readonly role: "blocked" | "generator" | "apex";
};

export type WaitingOnPath = {
  readonly nodeId: string;
  readonly hops: ReadonlyArray<WaitingOnHop>;
  /** Terminal apex id, when the walk found one. */
  readonly seedNodeId: string | undefined;
};

/**
 * Walk from `nodeId` to the task node holding it via the impact cone.
 * Empty when the node is outside any stoppage cone.
 */
export const waitingOnPath = (
  canvas: Canvas,
  graph: ExecutionGraph,
  nodeId: string,
): WaitingOnPath => {
  if (!canvas.nodes.has(nodeId as Node["id"])) {
    return { nodeId, hops: [], seedNodeId: undefined };
  }
  const holding = holdingTaskNodeIds(graph);
  const path = impactCone(canvas, graph, nodeId).pathToSeed(nodeId);
  if (path.length === 0) {
    return { nodeId, hops: [], seedNodeId: undefined };
  }

  const hops: WaitingOnHop[] = path.map((hopId, index) => ({
    nodeId: hopId,
    reasons: graph.reasonsByNodeId.get(hopId) ?? [],
    role: index < path.length - 1 ? "blocked" : holding.has(hopId) ? "generator" : "apex",
  }));

  return {
    nodeId,
    hops,
    seedNodeId: hops[hops.length - 1]?.nodeId,
  };
};

const reasonPhrase = (reason: BlockedReason): string =>
  reason.detail || "waiting on a task";

/**
 * Human lines for inspector / digest: one line per hop, seed last.
 * Example:
 *   Waiting on…
 *     Ship - needs input - ship
 *     Tasks
 */
export const formatWaitingOnLines = (
  path: WaitingOnPath,
  canvas: Canvas,
): ReadonlyArray<string> => {
  if (path.hops.length === 0) return [];
  return path.hops.map((hop) => {
    const node = canvas.nodes.get(hop.nodeId as Node["id"]);
    const title = node === undefined ? hop.nodeId : titleOf(node);
    if (hop.role !== "blocked") return title;
    const first = hop.reasons[0];
    return first ? `${title} — ${reasonPhrase(first)}` : title;
  });
};
