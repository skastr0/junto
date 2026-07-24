import type { CanvasDoc, CanvasNode } from "../canvas";
import type { BlockedReason, ExecutionGraph } from "../execution-graph";
import { impactCone } from "./cone";

// Reverse path from a blocked node to its stoppage seed/apex, listing each
// relay hop. Walks cone.pathToSeed and attaches reasonsByNodeId at every hop.

export type WaitingOnHop = {
  readonly nodeId: string;
  /** Title-ready fallback is the node id; callers map via titleOf. */
  readonly reasons: ReadonlyArray<BlockedReason>;
  /**
   * Position in the reverse walk:
   * - `blocked` — intermediate / query node in the blocked closure
   * - `seed` — manual blocker apex
   * - `generator` — criteria-generating apex (requests/task/glyphs…)
   * - `apex` — apex that is neither seed nor known generator (fallback)
   */
  readonly role: "blocked" | "seed" | "generator" | "apex";
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
  if (graph.seedNodeIds.has(nodeId)) return "seed";
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

  const generatesFrom = new Set<string>();
  for (const edge of doc.edges) {
    if (graph.edgeEvalById.get(edge.id)?.generates) generatesFrom.add(edge.fromNode);
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
  if (reason.kind === "edge") return reason.detail || "generating edge";
  if (reason.kind === "seed") return reason.detail || "manual seed";
  return `relay via ${reason.viaNodeId}`;
};

/**
 * Human lines for inspector / digest: one line per hop, seed last.
 * Example:
 *   Waiting on…
 *     Release · relay via Ship
 *     Ship · input-required
 *     Requests · generator
 */
export const formatWaitingOnLines = (
  path: WaitingOnPath,
  doc: CanvasDoc,
): ReadonlyArray<string> => {
  if (path.hops.length === 0) return [];
  const byId = new Map(doc.nodes.map((n) => [n.id, n] as const));
  return path.hops.map((hop) => {
    const title = titleOf(byId.get(hop.nodeId), hop.nodeId);
    if (hop.role === "seed") return `${title} · seed`;
    if (hop.role === "generator") {
      const detail = hop.reasons[0] ? reasonPhrase(hop.reasons[0]) : "generator";
      // Generator apex often has no reasons on itself; use role label.
      return hop.reasons.length > 0 ? `${title} · ${detail}` : `${title} · generator`;
    }
    if (hop.role === "apex") return `${title} · apex`;
    const first = hop.reasons[0];
    return first ? `${title} · ${reasonPhrase(first)}` : title;
  });
};
