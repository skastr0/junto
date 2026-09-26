/**
 * Resolve + focus the stoppage apex for a blocked (or seed) node.
 *
 * Walks the same waiting-on path as the inspector: reverse cone hop to the
 * generator/seed (requests sink needing input, manual blocker flag, etc.).
 * Work-plane sinks also open their detail surface so the operator lands on
 * the request/task that is holding the seat — preferably the exact item.
 */

import type { CanvasDoc, CanvasNode, Task } from "@shared/canvas";
import type { ExecutionGraph } from "@shared/execution-graph";
import { formatWaitingOnLines, waitingOnPath } from "@shared/impact";
import { claimedByOf, taskBrief } from "@shared/task";
import { nodeTitle } from "./presentation";
import { openWorkDetail } from "./work-detail-open";
import { selectNode, state$ } from "./state";

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
  readonly role: "blocked" | "generator" | "apex" | "work";
  /**
   * Specific request/task id holding the seat, when known.
   * Opens the sink surface pre-selected on this item.
   */
  readonly workItemId?: string;
};

export type ResolveBlockerCauseOptions = {
  /** Compiled seat id for the blocked actor (matches Task.claimedBy). */
  readonly blockedActorSeatId?: string;
};

const isWorkSink = (node: CanvasNode | undefined): boolean => {
  const kind = node?.ether?.entity?.kind;
  return typeof kind === "string" && WORK_SINK_KINDS.has(kind);
};

const isAttentionItem = (item: Task): boolean =>
  item.state === "input-required" || item.state === "auth-required";

const workItemsOn = (node: CanvasNode | undefined): ReadonlyArray<Task> => {
  const kind = node?.ether?.entity?.kind;
  if (kind === "requests") return node?.ether?.requests?.items ?? [];
  if (kind === "task") return node?.ether?.tasks?.items ?? [];
  return [];
};

/**
 * Prefer the attention item claimed by the blocked actor on the cause sink.
 * Falls back to work-reason requestId, then sole attention item on the sink.
 */
export const holdingWorkItemId = (
  causeNode: CanvasNode | undefined,
  blockedNodeId: string,
  graph: ExecutionGraph,
  blockedActorSeatId?: string,
): string | undefined => {
  const reasons = graph.reasonsByNodeId.get(blockedNodeId) ?? [];
  for (const reason of reasons) {
    if (reason.kind === "work" && reason.requestId) return reason.requestId;
  }

  const attention = workItemsOn(causeNode).filter(isAttentionItem);
  if (attention.length === 0) return undefined;

  if (blockedActorSeatId) {
    const held = attention.filter(
      (item) => claimedByOf(item) === blockedActorSeatId,
    );
    if (held[0]) return held[0]!.id;
  }

  if (attention.length === 1) return attention[0]!.id;
  return undefined;
};

const titleForItem = (
  causeNode: CanvasNode | undefined,
  workItemId: string | undefined,
  fallbackLine: string,
): string => {
  if (!workItemId || !causeNode) return fallbackLine;
  const item = workItemsOn(causeNode).find((entry) => entry.id === workItemId);
  if (!item) return fallbackLine;
  const brief = taskBrief(item).trim();
  const sink = nodeTitle(causeNode);
  return brief ? `${sink} - ${brief}` : fallbackLine;
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
  options?: ResolveBlockerCauseOptions,
): BlockerCause | null => {
  if (!doc.nodes.some((n) => n.id === nodeId)) return null;

  const byId = new Map(doc.nodes.map((n) => [n.id, n] as const));
  const seatId = options?.blockedActorSeatId;
  const path = waitingOnPath(doc, graph, nodeId);

  if (path.hops.length > 0) {
    const terminal = path.hops[path.hops.length - 1]!;
    const causeNode = byId.get(terminal.nodeId);
    const lines = formatWaitingOnLines(path, doc);
    const line = lines[lines.length - 1] ?? (causeNode ? nodeTitle(causeNode) : terminal.nodeId);
    const workItemId = isWorkSink(causeNode)
      ? holdingWorkItemId(causeNode, nodeId, graph, seatId)
      : undefined;
    return {
      causeNodeId: terminal.nodeId,
      isSelf: terminal.nodeId === nodeId,
      openWorkDetail: isWorkSink(causeNode),
      title: titleForItem(causeNode, workItemId, line),
      role: terminal.role,
      ...(workItemId ? { workItemId } : {}),
    };
  }

  // Seat work block without an edge cone: jump to the request/task target.
  const reasons = graph.reasonsByNodeId.get(nodeId) ?? [];
  for (const reason of reasons) {
    if (reason.kind !== "work") continue;
    const targetId = reason.targetNodeId;
    if (!targetId || !byId.has(targetId)) continue;
    const target = byId.get(targetId);
    const workItemId = reason.requestId || holdingWorkItemId(target, nodeId, graph, seatId);
    return {
      causeNodeId: targetId,
      isSelf: targetId === nodeId,
      openWorkDetail: isWorkSink(target),
      title: titleForItem(
        target,
        workItemId,
        target ? nodeTitle(target) : targetId,
      ),
      role: "work",
      ...(workItemId ? { workItemId } : {}),
    };
  }

  return null;
};

/** Select, camera-focus, and optionally open the work-plane detail for a cause. */
export const focusBlockerCause = (cause: BlockerCause): void => {
  selectNode(cause.causeNodeId);
  state$.focusNodeId.set(cause.causeNodeId);
  if (cause.openWorkDetail) {
    openWorkDetail(cause.causeNodeId, {
      itemId: cause.workItemId,
    });
  }
};
