/**
 * Rising-edge completed-task notifications for the RTS HUD.
 *
 * Pure observe model + process-local store. First observation baselines
 * existing completed tasks (no spam on open). Later transitions into
 * `completed` push a stack entry; dismiss only on click.
 *
 * Stability laws (anti-spam):
 * 1. Retain last-known state for tasks that drop out of a snapshot tick
 *    (projection flicker / canvas switch). Do not treat reappearance of an
 *    already-completed id as a rising edge.
 * 2. Clear dismiss only when we **observe** an explicit non-completed state —
 *    never when the task is merely absent from this tick.
 * 3. Stack UI lists only currently projected completed ids; retained known
 *    still prevents re-rise if the row returns after a gap.
 */

import { observable } from "@legendapp/state";
import type { CanvasNode } from "@shared/canvas";
import type { Task, TaskState } from "@shared/work-model";
import { taskBrief } from "@shared/task";
import { openWorkDetail } from "./work-detail-open";
import { state$ } from "./state";

export type CompletedTaskNotifyItem = {
  /** Stable id for the stack entry (task id — unique). */
  readonly id: string;
  readonly nodeId: string;
  readonly brief: string;
  readonly at: number;
};

export type CompletedTaskSnapshot = {
  readonly taskId: string;
  readonly nodeId: string;
  readonly brief: string;
  readonly state: TaskState;
};

export type CompletedNotifyState = {
  readonly baselined: boolean;
  /** Last observed state per taskId (retained across absent ticks). */
  readonly known: Readonly<Record<string, TaskState>>;
  /** Task ids dismissed while still completed (no re-show until leave completed). */
  readonly dismissed: Readonly<Record<string, true>>;
  readonly stack: ReadonlyArray<CompletedTaskNotifyItem>;
};

export const emptyCompletedNotifyState = (): CompletedNotifyState => ({
  baselined: false,
  known: {},
  dismissed: {},
  stack: [],
});

/** Collect completed-capable task rows from all task sinks on the canvas. */
export const collectTaskSnapshots = (
  nodes: ReadonlyArray<CanvasNode>,
): ReadonlyArray<CompletedTaskSnapshot> => {
  const out: CompletedTaskSnapshot[] = [];
  for (const node of nodes) {
    if (node.ether?.entity?.kind !== "task") continue;
    const items = node.ether.tasks?.items ?? [];
    for (const item of items as ReadonlyArray<Task>) {
      out.push({
        taskId: item.id,
        nodeId: node.id,
        brief: taskBrief(item),
        state: item.state,
      });
    }
  }
  return out;
};

/**
 * Observe snapshots. Rising edge: non-completed → completed after baseline.
 * Dismissed completed ids stay hidden until they leave completed.
 */
export const observeCompletedTasks = (
  state: CompletedNotifyState,
  snapshots: ReadonlyArray<CompletedTaskSnapshot>,
  now: number = Date.now(),
): CompletedNotifyState => {
  const presentIds = new Set(snapshots.map((snap) => snap.taskId));

  // Retain prior known for ids missing this tick so a flicker cannot re-rise.
  const nextKnown: Record<string, TaskState> = { ...state.known };
  for (const snap of snapshots) {
    nextKnown[snap.taskId] = snap.state;
  }

  if (!state.baselined) {
    return {
      baselined: true,
      known: nextKnown,
      dismissed: {},
      stack: [],
    };
  }

  const nextDismissed: Record<string, true> = { ...state.dismissed };
  // Clear dismiss only on an explicit observed non-completed state.
  // Absence alone must not forget a click-dismiss (projection gaps spam otherwise).
  for (const snap of snapshots) {
    if (nextDismissed[snap.taskId] && snap.state !== "completed") {
      delete nextDismissed[snap.taskId];
    }
  }

  // Stack: still completed, not dismissed, and currently projected.
  const kept = state.stack.filter(
    (item) =>
      presentIds.has(item.id) &&
      nextKnown[item.id] === "completed" &&
      !nextDismissed[item.id],
  );
  const keptIds = new Set(kept.map((item) => item.id));

  const risen: CompletedTaskNotifyItem[] = [];
  for (const snap of snapshots) {
    if (snap.state !== "completed") continue;
    // Rising edge only when prior known was not already completed.
    if (state.known[snap.taskId] === "completed") continue;
    if (nextDismissed[snap.taskId]) continue;
    if (keptIds.has(snap.taskId)) continue;
    risen.push({
      id: snap.taskId,
      nodeId: snap.nodeId,
      brief: snap.brief,
      at: now,
    });
  }

  // Newest first: risen (this tick) then prior stack by at.
  const nextStack = [...risen, ...kept].sort((a, b) => b.at - a.at);

  return {
    baselined: true,
    known: nextKnown,
    dismissed: nextDismissed,
    stack: nextStack,
  };
};

export const dismissCompletedNotify = (
  state: CompletedNotifyState,
  taskId: string,
): CompletedNotifyState => ({
  ...state,
  dismissed: { ...state.dismissed, [taskId]: true },
  stack: state.stack.filter((item) => item.id !== taskId),
});

// --- process-local store ----------------------------------------------------

let notifyState: CompletedNotifyState = emptyCompletedNotifyState();

export const completedTaskNotify$ = observable({
  items: [] as ReadonlyArray<CompletedTaskNotifyItem>,
});

export const resetCompletedTaskNotify = (): void => {
  notifyState = emptyCompletedNotifyState();
  completedTaskNotify$.items.set([]);
};

export const syncCompletedTaskNotifyFromDoc = (
  nodes: ReadonlyArray<CanvasNode>,
  now: number = Date.now(),
): void => {
  notifyState = observeCompletedTasks(
    notifyState,
    collectTaskSnapshots(nodes),
    now,
  );
  completedTaskNotify$.items.set(notifyState.stack);
};

/** Click handler: dismiss + focus canvas + open tasks board on this item. */
export const activateCompletedTaskNotify = (item: CompletedTaskNotifyItem): void => {
  notifyState = dismissCompletedNotify(notifyState, item.id);
  completedTaskNotify$.items.set(notifyState.stack);

  state$.selectedNodeId.set(item.nodeId);
  state$.selectedNodeIds.set([item.nodeId]);
  state$.selectedEdgeId.set("");
  state$.focusNodeId.set(item.nodeId);
  openWorkDetail(item.nodeId, { itemId: item.id });
};
