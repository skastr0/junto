/**
 * Resolve + focus the stoppage apex for a blocked (or seed) node.
 *
 * Walks the same waiting-on path as the inspector: reverse cone hop to the
 * generator/seed (requests sink needing input, manual blocker flag, etc.).
 * Work-plane sinks also open their detail surface so the operator lands on
 * the request/task that is holding the seat — preferably the exact item.
 */

import type { Task } from "@shared/canvas";
import type { ExecutionGraph, WorkItemsOf } from "@shared/execution-graph";
import { formatWaitingOnLines, waitingOnPath } from "@shared/impact";
import type { NodeId } from "@shared/model/base";
import type { Canvas } from "@shared/model/canvas";
import type { Node } from "@shared/model/kinds";
import { titleOf } from "@shared/model/title";
import { claimedByOf, taskBrief } from "@shared/task";
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
  /** The items on a task or requests node; a canvas holds no work. */
  readonly itemsOf: WorkItemsOf;
};

const isWorkSink = (node: Node | undefined): boolean =>
  node !== undefined && WORK_SINK_KINDS.has(node.kind);

const isAttentionItem = (item: Task): boolean =>
  item.state === "input-required" || item.state === "auth-required";

/**
 * Prefer the attention item claimed by the blocked actor on the cause sink.
 * Falls back to work-reason requestId, then sole attention item on the sink.
 */
export const holdingWorkItemId = (
  causeItems: ReadonlyArray<Task>,
  blockedNodeId: string,
  graph: ExecutionGraph,
  blockedActorSeatId?: string,
): string | undefined => {
  const reasons = graph.reasonsByNodeId.get(blockedNodeId) ?? [];
  for (const reason of reasons) {
    if (reason.kind === "work" && reason.requestId) return reason.requestId;
  }

  const attention = causeItems.filter(isAttentionItem);
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
  causeNode: Node | undefined,
  causeItems: ReadonlyArray<Task>,
  workItemId: string | undefined,
  fallbackLine: string,
): string => {
  if (!workItemId || !causeNode) return fallbackLine;
  const item = causeItems.find((entry) => entry.id === workItemId);
  if (!item) return fallbackLine;
  const brief = taskBrief(item).trim();
  return brief ? `${titleOf(causeNode)} - ${brief}` : fallbackLine;
};

/**
 * Pure: which node is the root cause of stoppage for `nodeId`, if any.
 * Prefers the waiting-on terminal hop; falls back to a live work reason's
 * targetNodeId when the cone walk is empty.
 */
export const resolveBlockerCause = (
  canvas: Canvas,
  graph: ExecutionGraph,
  nodeId: string,
  options: ResolveBlockerCauseOptions,
): BlockerCause | null => {
  const byId = canvas.nodes;
  if (!byId.has(nodeId as NodeId)) return null;

  const seatId = options.blockedActorSeatId;
  const itemsOn = (node: Node | undefined): ReadonlyArray<Task> =>
    node !== undefined && (node.kind === "task" || node.kind === "requests")
      ? options.itemsOf(node.id)
      : [];
  const path = waitingOnPath(canvas, graph, nodeId);

  if (path.hops.length > 0) {
    const terminal = path.hops[path.hops.length - 1]!;
    const causeNode = byId.get(terminal.nodeId as NodeId);
    const lines = formatWaitingOnLines(path, canvas);
    const line = lines[lines.length - 1] ?? (causeNode ? titleOf(causeNode) : terminal.nodeId);
    const workItemId = isWorkSink(causeNode)
      ? holdingWorkItemId(itemsOn(causeNode), nodeId, graph, seatId)
      : undefined;
    return {
      causeNodeId: terminal.nodeId,
      isSelf: terminal.nodeId === nodeId,
      openWorkDetail: isWorkSink(causeNode),
      title: titleForItem(causeNode, itemsOn(causeNode), workItemId, line),
      role: terminal.role,
      ...(workItemId ? { workItemId } : {}),
    };
  }

  // Seat work block without a wire cone: jump to the request/task target.
  const reasons = graph.reasonsByNodeId.get(nodeId) ?? [];
  for (const reason of reasons) {
    if (reason.kind !== "work") continue;
    const targetId = reason.targetNodeId;
    const target = targetId ? byId.get(targetId as NodeId) : undefined;
    if (!targetId || target === undefined) continue;
    const workItemId =
      reason.requestId || holdingWorkItemId(itemsOn(target), nodeId, graph, seatId);
    return {
      causeNodeId: targetId,
      isSelf: targetId === nodeId,
      openWorkDetail: isWorkSink(target),
      title: titleForItem(target, itemsOn(target), workItemId, titleOf(target)),
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
