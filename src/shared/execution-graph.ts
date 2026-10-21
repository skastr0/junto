import type { Task } from "./work-model";
import { claimedByOf, taskBrief } from "./task";
import {
  resolveActorRefAt,
  type ActorRefResolver,
} from "./attention";
import type { Canvas } from "./model/canvas";
import type { Node } from "./model/kinds";
import { seatMayBeBlocked } from "./physics/phase-membership";
import {
  type ApprovalView,
  type StampView,
} from "./proof-stamps";

// Live execution graph: pure function of (canvas + live views).
// Derived state is never stored on the canvas.
//
// Stoppage model (derived, never authored): a seat is blocked when it is the
// assignee of a task in `input-required`, on any task node of the canvas.
// The mark lives on the seat's ring. Wires carry no stoppage: a wire states a
// relationship, never a gate, and nothing cascades along one. A task in
// review does not block its assignee.

/** Optional live trust views (legacy stamp/approval surfaces; not product gates). */
export type LiveTrustViews = {
  readonly stamps?: StampView;
  readonly approvals?: ApprovalView;
};

/** Complete pure inputs required to attribute canvas-local actor references. */
export type ExecutionGraphContext = LiveTrustViews & {
  readonly canvasName: string;
  readonly resolveActorRef: ActorRefResolver;
  /**
   * The tasks on a task node. A canvas holds no work, so the caller supplies
   * it. It must return at least every task that needs input, with its
   * assignee and the time it began waiting.
   */
  readonly itemsOf: WorkItemsOf;
};

export type WorkItemsOf = (nodeId: string) => ReadonlyArray<Task>;

/** Why a seat is blocked: one task it holds is waiting for input. */
export type BlockedReason = {
  readonly kind: "task";
  /** The task node the task sits on. */
  readonly taskNodeId: string;
  readonly taskId: string;
  readonly detail: string;
  /**
   * Epoch ms the task began waiting (`Task.stateSince`). Absent only when the
   * task carries no readable time (an authored fixture).
   */
  readonly since?: number;
};

/** The earliest `stateSince` among items, as epoch ms. */
export const earliestStateSince = (items: ReadonlyArray<Pick<Task, "stateSince">>): number | undefined => {
  let earliest: number | undefined;
  for (const item of items) {
    const at = item.stateSince === undefined ? Number.NaN : Date.parse(item.stateSince);
    if (!Number.isNaN(at) && (earliest === undefined || at < earliest)) earliest = at;
  }
  return earliest;
};

export type ExecutionGraph = {
  readonly blocked: ReadonlySet<string>;
  readonly reasonsByNodeId: ReadonlyMap<string, ReadonlyArray<BlockedReason>>;
};

const mayBeBlocked = (node: Node): boolean =>
  seatMayBeBlocked({ isGroup: node.kind === "region", kind: node.kind });

/** The one task state that blocks its assignee. */
export const blocksAssignee = (task: Pick<Task, "state">): boolean =>
  task.state === "input-required";

export const deriveExecutionGraph = (
  canvas: Canvas,
  context: ExecutionGraphContext,
): ExecutionGraph => {
  // Seat node by compiled seat id: a task names its assignee by seat id, and
  // an unresolved seat never stands in for its canvas node id.
  const nodeIdBySeat = new Map<string, string>();
  for (const node of canvas.nodes.values()) {
    if (!mayBeBlocked(node)) continue;
    const seatId = resolveActorRefAt(context.resolveActorRef, context.canvasName, node.id)?.seatId;
    if (seatId !== undefined) nodeIdBySeat.set(seatId, node.id);
  }

  const blocked = new Set<string>();
  const reasonsByNodeId = new Map<string, BlockedReason[]>();
  for (const node of canvas.nodes.values()) {
    if (node.kind !== "task") continue;
    for (const task of context.itemsOf(node.id)) {
      if (!blocksAssignee(task)) continue;
      const assignee = claimedByOf(task);
      const seatNodeId = assignee === undefined ? undefined : nodeIdBySeat.get(assignee);
      if (seatNodeId === undefined) continue;
      const since = earliestStateSince([task]);
      blocked.add(seatNodeId);
      const list = reasonsByNodeId.get(seatNodeId) ?? [];
      list.push({
        kind: "task",
        taskNodeId: node.id,
        taskId: task.id,
        detail: `needs input - ${taskBrief(task)}`,
        ...(since === undefined ? {} : { since }),
      });
      reasonsByNodeId.set(seatNodeId, list);
    }
  }
  return { blocked, reasonsByNodeId };
};

/** The kernel's live projection of a canvas's execution graph, as it travels. */
export type ExecutionGraphSnapshot = {
  readonly blocked: ReadonlyArray<string>;
  readonly reasonsByNodeId: Readonly<Record<string, ReadonlyArray<BlockedReason>>>;
};

/**
 * The execution graph the kernel already derived, rebuilt from its snapshot
 * without a second derivation, so stoppage cones and canvas needs can read it
 * in the renderer and in main.
 */
export const executionGraphFromSnapshot = (
  execution: ExecutionGraphSnapshot,
): ExecutionGraph => ({
  blocked: new Set(execution.blocked),
  reasonsByNodeId: new Map(Object.entries(execution.reasonsByNodeId ?? {})),
});
