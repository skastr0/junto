import type { Task } from "./work-model";
import type { TaskId, TaskNodeId } from "./task-model";
import type { SeatTask } from "./seat-task-index";
import type { ActorRefResolver } from "./attention";
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
// assignee of a task in `input-required` (`SeatTask.blocked`, from the shared
// seat task index the seat cards read too), on any task node of the canvas.
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
   * The open task each seat holds, by seat node id (`buildSeatTaskIndex`). A
   * canvas holds no work, so the caller supplies it: the kernel from the task
   * store, the renderer from `seatTasks$`.
   */
  readonly heldBy: SeatTaskIndex;
};

/** The open task each seat holds, by seat node id. */
export type SeatTaskIndex = Readonly<Record<string, SeatTask | undefined>>;

export type WorkItemsOf = (nodeId: string) => ReadonlyArray<Task>;

/** Why a seat is blocked: one task it holds is waiting for input. */
export type BlockedReason = {
  readonly kind: "task";
  /** The task node the task sits on. */
  readonly taskNodeId: TaskNodeId;
  readonly taskId: TaskId;
  readonly detail: string;
  /** Epoch ms the task began waiting (`SeatTask.since`), when the task domain carries it. */
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

export const deriveExecutionGraph = (
  canvas: Canvas,
  context: ExecutionGraphContext,
): ExecutionGraph => {
  const blocked = new Set<string>();
  const reasonsByNodeId = new Map<string, BlockedReason[]>();
  for (const node of canvas.nodes.values()) {
    if (!mayBeBlocked(node)) continue;
    const held = context.heldBy[node.id];
    if (held === undefined || !held.blocked) continue;
    blocked.add(node.id);
    reasonsByNodeId.set(node.id, [{
      kind: "task",
      taskNodeId: held.node,
      taskId: held.taskId,
      detail: `needs input - ${held.label} ${held.title}`,
      ...(held.since === undefined ? {} : { since: held.since }),
    }]);
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
