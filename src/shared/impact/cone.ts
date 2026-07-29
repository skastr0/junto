import type { CanvasDoc, CanvasNode } from "../canvas";
import type { BlockedReason, ExecutionGraph } from "../execution-graph";
import { seatMayBeBlocked } from "../physics/phase-membership";

// Pure stoppage impact cone: derived from (document + ExecutionGraph).
// Phase membership (who may be blocked) is physics: actors only today.

export type ImpactCone = {
  readonly rootId: string;
  /** Root-cause reasons (edge|seed) that generate this cone’s stoppage. */
  readonly seedReasons: ReadonlyArray<BlockedReason>;
  /** Nodes in the cone: apex seeds/generators + blocked closure they reach. */
  readonly nodeIds: ReadonlySet<string>;
  /** Edges that carry stoppage inside the cone (blockedEdgeIds subset). */
  readonly edgeIds: ReadonlySet<string>;
  /**
   * Soft attention leads: phase-member seats (actors under current law) with an
   * undirected edge into a cone node but not already in nodeIds.
   */
  readonly attentionLeadIds: ReadonlySet<string>;
  /**
   * Path from `nodeId` toward a stoppage apex (seed or generator), inclusive.
   * Empty when `nodeId` is outside the cone.
   */
  readonly pathToSeed: (nodeId: string) => ReadonlyArray<string>;
};

type Hop = { readonly edgeId: string; readonly nodeId: string };

const emptyCone = (rootId: string): ImpactCone => ({
  rootId,
  seedReasons: [],
  nodeIds: new Set(),
  edgeIds: new Set(),
  attentionLeadIds: new Set(),
  pathToSeed: () => [],
});

/** Physics seat that may enter the blocked set (actors under current law). */
const isPhaseMemberSeat = (node: CanvasNode | undefined): boolean => {
  if (!node) return false;
  return seatMayBeBlocked({
    isGroup: node.type === "group",
    kind: node.ether?.entity?.kind,
  });
};

const reasonRank = (reason: BlockedReason): number => {
  if (reason.kind === "work") return 0;
  if (reason.kind === "edge") return 1;
  return 2;
};

const sortReasons = (reasons: ReadonlyArray<BlockedReason>): BlockedReason[] =>
  [...reasons].sort((a, b) => {
    const rank = reasonRank(a) - reasonRank(b);
    if (rank !== 0) return rank;
    if (a.kind === "edge" && b.kind === "edge") {
      return a.edgeId < b.edgeId ? -1 : a.edgeId > b.edgeId ? 1 : 0;
    }
    if (a.kind === "seed" && b.kind === "seed") {
      return a.detail < b.detail ? -1 : a.detail > b.detail ? 1 : 0;
    }
    if (a.kind === "work" && b.kind === "work") {
      return a.requestId < b.requestId ? -1 : a.requestId > b.requestId ? 1 : 0;
    }
    return 0;
  });

const reasonKey = (reason: BlockedReason): string => {
  if (reason.kind === "work") return `work:${reason.requestId}`;
  if (reason.kind === "edge") return `edge:${reason.edgeId}`;
  return `seed:${reason.detail}`;
};

/**
 * Derive the stoppage impact cone for `rootNodeId`.
 *
 * - Root is a **seed** (manual blocker), a **generator** (outbound generating
 *   edge), or **blocked** → cone is the apex set that seeds root’s stoppage
 *   plus the forward blocked-edge closure from those apexes.
 * - Otherwise the cone is empty.
 * - Attention leads are optional soft overlays (actor seats on undirected edges).
 */
export const impactCone = (
  doc: CanvasDoc,
  graph: ExecutionGraph,
  rootNodeId: string,
): ImpactCone => {
  const byId = new Map(doc.nodes.map((node) => [node.id, node] as const));
  if (!byId.has(rootNodeId)) return emptyCone(rootNodeId);

  const forward = new Map<string, Hop[]>();
  const reverse = new Map<string, Hop[]>();
  const generatesFrom = new Map<string, Hop[]>();

  for (const edge of doc.edges) {
    const evaluation = graph.edgeEvalById.get(edge.id);
    if (evaluation?.generates) {
      const list = generatesFrom.get(edge.fromNode) ?? [];
      list.push({ edgeId: edge.id, nodeId: edge.toNode });
      generatesFrom.set(edge.fromNode, list);
    }
    if (!graph.blockedEdgeIds.has(edge.id)) continue;
    const out = forward.get(edge.fromNode) ?? [];
    out.push({ edgeId: edge.id, nodeId: edge.toNode });
    forward.set(edge.fromNode, out);
    const inn = reverse.get(edge.toNode) ?? [];
    inn.push({ edgeId: edge.id, nodeId: edge.fromNode });
    reverse.set(edge.toNode, inn);
  }

  const rootIsSeed = graph.seedNodeIds.has(rootNodeId);
  const rootIsBlocked = graph.blocked.has(rootNodeId);
  const rootIsGenerator = (generatesFrom.get(rootNodeId)?.length ?? 0) > 0;

  if (!rootIsSeed && !rootIsBlocked && !rootIsGenerator) {
    return emptyCone(rootNodeId);
  }

  // Apex set: seeds / generators that causally root this cone.
  const apexes = new Set<string>();

  if (rootIsSeed || rootIsGenerator) {
    apexes.add(rootNodeId);
  }

  if (rootIsBlocked) {
    const seen = new Set<string>();
    const queue: string[] = [rootNodeId];
    while (queue.length > 0) {
      const current = queue.pop()!;
      if (seen.has(current)) continue;
      seen.add(current);

      if (graph.seedNodeIds.has(current)) {
        apexes.add(current);
      }

      const parents = reverse.get(current) ?? [];
      if (parents.length === 0) {
        // Direct generating edge(s) into current — generators are apexes.
        for (const reason of graph.reasonsByNodeId.get(current) ?? []) {
          if (reason.kind === "edge") apexes.add(reason.fromNodeId);
        }
        // Manual seed may not appear as reverse parent when seed is not blocked.
        for (const seedId of graph.seedNodeIds) {
          for (const hop of forward.get(seedId) ?? []) {
            if (hop.nodeId === current) apexes.add(seedId);
          }
        }
        // Fallback: treat the blocked node itself as apex if nothing else found.
        if (apexes.size === 0) apexes.add(current);
        continue;
      }

      for (const hop of parents) {
        if (!seen.has(hop.nodeId)) queue.push(hop.nodeId);
      }
    }
  }

  if (apexes.size === 0) return emptyCone(rootNodeId);

  // Forward blast radius along blocked edges from every apex.
  const nodeIds = new Set<string>(apexes);
  const edgeIds = new Set<string>();
  const forwardQueue = [...apexes];
  const seenForward = new Set<string>();

  while (forwardQueue.length > 0) {
    const current = forwardQueue.pop()!;
    if (seenForward.has(current)) continue;
    seenForward.add(current);

    for (const hop of forward.get(current) ?? []) {
      edgeIds.add(hop.edgeId);
      if (!nodeIds.has(hop.nodeId)) {
        nodeIds.add(hop.nodeId);
        forwardQueue.push(hop.nodeId);
      }
    }

    // Generators may emit generating edges that land in blockedEdgeIds already
    // covered above; also include direct generates targets that are blocked.
    for (const hop of generatesFrom.get(current) ?? []) {
      if (!graph.blocked.has(hop.nodeId) && !nodeIds.has(hop.nodeId)) continue;
      edgeIds.add(hop.edgeId);
      if (!nodeIds.has(hop.nodeId)) {
        nodeIds.add(hop.nodeId);
        forwardQueue.push(hop.nodeId);
      }
    }
  }

  // Seed reasons: direct edge|seed causes whose apex is in the apex set.
  const seedReasonMap = new Map<string, BlockedReason>();
  for (const nodeId of nodeIds) {
    if (!graph.blocked.has(nodeId)) continue;
    for (const reason of graph.reasonsByNodeId.get(nodeId) ?? []) {
      if (reason.kind === "edge" && apexes.has(reason.fromNodeId)) {
        seedReasonMap.set(reasonKey(reason), reason);
      } else if (reason.kind === "seed") {
        // Attribute seed reasons when an apex seed relays into this node.
        let fromApex = false;
        for (const apex of apexes) {
          if (!graph.seedNodeIds.has(apex)) continue;
          for (const hop of forward.get(apex) ?? []) {
            if (hop.nodeId === nodeId) {
              fromApex = true;
              break;
            }
          }
          if (fromApex) break;
        }
        if (fromApex) seedReasonMap.set(reasonKey(reason), reason);
      }
    }
  }
  const seedReasons = sortReasons([...seedReasonMap.values()]);

  // pathToSeed: reverse BFS toward nearest apex (stable edge-id order).
  // cameFrom[upstream] = downstream node from which upstream was discovered.
  const pathCache = new Map<string, ReadonlyArray<string>>();

  const upstreamCandidates = (current: string): string[] => {
    const fromEdges = [...(reverse.get(current) ?? [])]
      .sort((a, b) => (a.edgeId < b.edgeId ? -1 : a.edgeId > b.edgeId ? 1 : 0))
      .map((hop) => hop.nodeId);

    if (fromEdges.length > 0) return fromEdges;

    const jumps: string[] = [];
    for (const reason of sortReasons(graph.reasonsByNodeId.get(current) ?? [])) {
      if (reason.kind === "edge" && apexes.has(reason.fromNodeId)) {
        jumps.push(reason.fromNodeId);
      }
    }
    for (const apex of [...apexes].sort()) {
      if (!graph.seedNodeIds.has(apex)) continue;
      for (const hop of forward.get(apex) ?? []) {
        if (hop.nodeId === current) jumps.push(apex);
      }
    }
    return jumps;
  };

  const pathToSeed = (nodeId: string): ReadonlyArray<string> => {
    const cached = pathCache.get(nodeId);
    if (cached) return cached;
    if (!nodeIds.has(nodeId)) {
      pathCache.set(nodeId, []);
      return [];
    }
    if (apexes.has(nodeId)) {
      const path = [nodeId];
      pathCache.set(nodeId, path);
      return path;
    }

    const cameFrom = new Map<string, string>();
    const q: string[] = [nodeId];
    const visited = new Set<string>([nodeId]);
    let foundApex: string | undefined;

    while (q.length > 0 && foundApex === undefined) {
      const current = q.shift()!;
      if (apexes.has(current) && current !== nodeId) {
        foundApex = current;
        break;
      }
      for (const upstream of upstreamCandidates(current)) {
        if (visited.has(upstream)) continue;
        visited.add(upstream);
        cameFrom.set(upstream, current);
        if (apexes.has(upstream)) {
          foundApex = upstream;
          break;
        }
        q.push(upstream);
      }
    }

    if (foundApex === undefined) {
      const path = [nodeId];
      pathCache.set(nodeId, path);
      return path;
    }

    // Walk apex → … → nodeId via cameFrom, then reverse to nodeId → … → apex.
    const reversePath: string[] = [];
    let cur: string | undefined = foundApex;
    const guard = new Set<string>();
    while (cur !== undefined && !guard.has(cur)) {
      reversePath.push(cur);
      guard.add(cur);
      if (cur === nodeId) break;
      cur = cameFrom.get(cur);
    }
    const path = reversePath.reverse();
    if (path[0] !== nodeId) {
      // Defensive: ensure path starts at the query node.
      path.unshift(nodeId);
    }
    pathCache.set(nodeId, path);
    return path;
  };

  // Soft attention leads: undirected edge from actor seat into cone node.
  const attentionLeadIds = new Set<string>();
  for (const edge of doc.edges) {
    const aIn = nodeIds.has(edge.fromNode);
    const bIn = nodeIds.has(edge.toNode);
    if (aIn === bIn) continue;
    const outsiderId = aIn ? edge.toNode : edge.fromNode;
    if (nodeIds.has(outsiderId)) continue;
    if (isPhaseMemberSeat(byId.get(outsiderId))) {
      attentionLeadIds.add(outsiderId);
    }
  }

  return {
    rootId: rootNodeId,
    seedReasons,
    nodeIds,
    edgeIds,
    attentionLeadIds,
    pathToSeed,
  };
};
