import type { CanvasDoc, CanvasNode } from "../canvas";
import type { BlockedReason, ExecutionGraph } from "../execution-graph";
import { impactCone, stoppageEnds } from "./cone";

// Reverse path from a blocked node to its stoppage seed/apex, listing each
// relay hop. Walks cone.pathToSeed and attaches reasonsByNodeId at every hop.

export type WaitingOnHop = {
  readonly nodeId: string;
  /** Title-ready fallback is the node id; callers map via titleOf. */
  readonly reasons: ReadonlyArray<BlockedReason>;
  /**
   * Position in the reverse walk:
   * - `blocked` — intermediate / query node in the blocked closure
   * - `generator` — criteria-generating apex (requests/task/proof/approval)
   * - `apex` — apex that is not a known generator (fallback)
   */
  readonly role: "blocked" | "generator" | "apex";
};

export type WaitingOnPath = {
  readonly nodeId: string;
  readonly hops: ReadonlyArray<WaitingOnHop>;
  /** Terminal apex id, when the walk found one. */
  readonly seedNodeId: string | undefined;
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

const hopRole = (
  nodeId: string,
  isTerminal: boolean,
  graph: ExecutionGraph,
  generatesFrom: ReadonlySet<string>,
): WaitingOnHop["role"] => {
  if (!isTerminal) return "blocked";
  if (generatesFrom.has(nodeId)) return "generator";
  return "apex";
};

/**
 * Reverse-walk from `nodeId` toward a stoppage apex via the impact cone.
 * Empty when the node is outside any stoppage cone.
 */
export const waitingOnPath = (
  doc: CanvasDoc,
  graph: ExecutionGraph,
  nodeId: string,
): WaitingOnPath => {
  if (!doc.nodes.some((n) => n.id === nodeId)) {
    return { nodeId, hops: [], seedNodeId: undefined };
  }

  const byId = new Map(doc.nodes.map((n) => [n.id, n] as const));
  const generatesFrom = new Set<string>();
  for (const edge of doc.edges) {
    if (!graph.edgeEvalById.get(edge.id)?.generates) continue;
    generatesFrom.add(stoppageEnds(byId, edge).causeId);
  }

  const cone = impactCone(doc, graph, nodeId);
  const path = cone.pathToSeed(nodeId);
  if (path.length === 0) {
    return { nodeId, hops: [], seedNodeId: undefined };
  }

  const hops: WaitingOnHop[] = path.map((hopId, index) => {
    const isTerminal = index === path.length - 1;
    return {
      nodeId: hopId,
      reasons: graph.reasonsByNodeId.get(hopId) ?? [],
      role: hopRole(hopId, isTerminal, graph, generatesFrom),
    };
  });

  return {
    nodeId,
    hops,
    seedNodeId: hops[hops.length - 1]?.nodeId,
  };
};

const reasonPhrase = (reason: BlockedReason): string => {
  if (reason.kind === "edge") return reason.detail || "waiting on connected work";
  return reason.detail || "waiting for operator";
};

/**
 * Human lines for inspector / digest: one line per hop, seed last.
 * Example:
 *   Waiting on…
 *     Ship - 1 need input - ship
 *     Requests - generator
 */
export const formatWaitingOnLines = (
  path: WaitingOnPath,
  doc: CanvasDoc,
): ReadonlyArray<string> => {
  if (path.hops.length === 0) return [];
  const byId = new Map(doc.nodes.map((n) => [n.id, n] as const));
  return path.hops.map((hop) => {
    const title = titleOf(byId.get(hop.nodeId), hop.nodeId);
    if (hop.role === "generator") {
      const detail = hop.reasons[0] ? reasonPhrase(hop.reasons[0]) : undefined;
      return detail ? `${title} — ${detail}` : title;
    }
    if (hop.role === "apex") return title;
    const first = hop.reasons[0];
    return first ? `${title} — ${reasonPhrase(first)}` : title;
  });
};
