/**
 * Resolve + focus the stoppage cause for a blocked seat (or a task node
 * holding seats).
 *
 * Walks the same waiting-on path as the inspector: a blocked seat to the task
 * node whose waiting task it is the assignee of. The task node also opens its
 * detail surface, pre-selected on that task.
 */

import type { ExecutionGraph, WorkItemsOf } from "@shared/execution-graph";
import { formatWaitingOnLines, waitingOnPath } from "@shared/impact";
import type { NodeId } from "@shared/model/base";
import type { Canvas } from "@shared/model/canvas";
import { titleOf } from "@shared/model/title";
import { taskBrief } from "@shared/task";
import { openWorkDetail } from "./work-detail-open";
import { selectNode, state$ } from "./state";

export type BlockerCause = {
  readonly causeNodeId: string;
  /** Cause is the queried node (open detail / re-focus in place). */
  readonly isSelf: boolean;
  /** Cause is a task node — open its detail overlay after focus. */
  readonly openWorkDetail: boolean;
  /** Short human title for tooltips. */
  readonly title: string;
  /** Last hop role from the waiting-on path. */
  readonly role: "blocked" | "generator" | "apex";
  /** The waiting task holding the seat, when known. */
  readonly workItemId?: string;
};

/**
 * Pure: which node is the cause of stoppage for `nodeId`, if any, and which
 * task on it holds the seat.
 */
export const resolveBlockerCause = (
  canvas: Canvas,
  graph: ExecutionGraph,
  nodeId: string,
  itemsOf: WorkItemsOf,
): BlockerCause | null => {
  if (!canvas.nodes.has(nodeId as NodeId)) return null;
  const path = waitingOnPath(canvas, graph, nodeId);
  const terminal = path.hops[path.hops.length - 1];
  if (terminal === undefined) return null;

  const causeNode = canvas.nodes.get(terminal.nodeId as NodeId);
  const lines = formatWaitingOnLines(path, canvas);
  const line = lines[lines.length - 1] ?? (causeNode ? titleOf(causeNode) : terminal.nodeId);
  const reason = (graph.reasonsByNodeId.get(nodeId) ?? []).find(
    (candidate) => candidate.taskNodeId === terminal.nodeId,
  );
  const task = reason === undefined ? undefined : itemsOf(reason.taskNodeId).find((item) => item.id === reason.taskId);
  const brief = task === undefined ? "" : taskBrief(task).trim();
  return {
    causeNodeId: terminal.nodeId,
    isSelf: terminal.nodeId === nodeId,
    openWorkDetail: causeNode?.kind === "task",
    title: causeNode !== undefined && brief ? `${titleOf(causeNode)} - ${brief}` : line,
    role: terminal.role,
    ...(reason === undefined ? {} : { workItemId: reason.taskId }),
  };
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
