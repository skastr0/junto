/**
 * Resolve + focus the stoppage apex for a blocked (or seed) node.
 *
 * Walks the same waiting-on path as the inspector: reverse cone hop to the
 * generator/seed (requests sink needing input, manual blocker flag, etc.).
 * Work-plane sinks also open their detail surface so the operator lands on
 * the request/task that is holding the seat.
 */

import type { CanvasDoc, CanvasNode } from "@shared/canvas";
import type { ExecutionGraph } from "@shared/execution-graph";
import { formatWaitingOnLines, waitingOnPath } from "@shared/impact";
import { nodeTitle } from "./presentation";
import { openWorkDetail } from "./work-detail-open";
import { state$ } from "./state";

const WORK_SINK_KINDS = new Set(["task", "requests", "artifacts"]);

export type BlockerCause = {
  readonly causeNodeId: string;
  /** Cause is the queried node (open detail / re-focus in place). */
  readonly isSelf: boolean;
  /** Cause is a work-plane sink — open its detail overlay after focus. */
  readonly openWorkDetail: boolean;
  /** Short human title for tooltips. */
  readonly title: string;
  /** Last hop role from waiting-on path, or work when seeded by seat block. */
  readonly role: "blocked" | "seed" | "generator" | "apex" | "work";
};

const isWorkSink = (node: CanvasNode | undefined): boolean => {
  const kind = node?.ether?.entity?.kind;
  return typeof kind === "string" && WORK_SINK_KINDS.has(kind);
};

/**
 * Pure: which node is the root cause of stoppage for `nodeId`, if any.
 * Prefers the waiting-on terminal hop; falls back to a live work reason's
 * targetNodeId when the cone walk is empty.
 */
export const resolveBlockerCause = (
  doc: CanvasDoc,
  graph: ExecutionGraph,
  nodeId: string,
): BlockerCause | null => {
  if (!doc.nodes.some((n) => n.id === nodeId)) return null;

  const byId = new Map(doc.nodes.map((n) => [n.id, n] as const));
  const path = waitingOnPath(doc, graph, nodeId);

  if (path.hops.length > 0) {
    const terminal = path.hops[path.hops.length - 1]!;
    const causeNode = byId.get(terminal.nodeId);
    const lines = formatWaitingOnLines(path, doc);
    const line = lines[lines.length - 1];
    return {
      causeNodeId: terminal.nodeId,
      isSelf: terminal.nodeId === nodeId,
      openWorkDetail: isWorkSink(causeNode),
      title: line ?? (causeNode ? nodeTitle(causeNode) : terminal.nodeId),
      role: terminal.role,
    };
  }

  // Seat work block without an edge cone: jump to the request/task target.
  const reasons = graph.reasonsByNodeId.get(nodeId) ?? [];
  for (const reason of reasons) {
    if (reason.kind !== "work") continue;
    const targetId = reason.targetNodeId;
    if (!targetId || !byId.has(targetId)) continue;
    const target = byId.get(targetId);
    return {
      causeNodeId: targetId,
      isSelf: targetId === nodeId,
      openWorkDetail: isWorkSink(target),
      title: target ? nodeTitle(target) : targetId,
      role: "work",
    };
  }

  // Manual seed on self with no outbound cone: still allow "open if sink".
  if (graph.seedNodeIds.has(nodeId)) {
    const self = byId.get(nodeId);
    if (!isWorkSink(self) && !graph.blocked.has(nodeId)) return null;
    return {
      causeNodeId: nodeId,
      isSelf: true,
      openWorkDetail: isWorkSink(self),
      title: self ? nodeTitle(self) : nodeId,
      role: "seed",
    };
  }

  return null;
};

/** Select, camera-focus, and optionally open the work-plane detail for a cause. */
export const focusBlockerCause = (cause: BlockerCause): void => {
  state$.selectedNodeId.set(cause.causeNodeId);
  state$.selectedNodeIds.set([cause.causeNodeId]);
  state$.selectedEdgeId.set("");
  state$.focusNodeId.set(cause.causeNodeId);
  if (cause.openWorkDetail) openWorkDetail(cause.causeNodeId);
};
