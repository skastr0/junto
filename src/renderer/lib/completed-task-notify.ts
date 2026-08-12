/**
 * Rising-edge completed-task notifications for the RTS HUD.
 *
 * First observation baselines existing completed tasks (no spam on open).
 * Later transitions into `completed` push a stack entry; click dismisses.
 *
 * Stability laws (anti-spam + durable clear):
 * 1. Retain last-known state across absent snapshot ticks (projection gaps).
 * 2. Clear dismiss only when a non-completed state is **observed** — not when
 *    the row is merely missing for a tick.
 * 3. Click-dismiss is **persisted** (local install UI store) so remounts,
 *    renderer restarts, and RTS chrome remounts do not re-fire the same id.
 * 4. Completed-seen ids are also persisted so a cold open does not re-stack
 *    rows the operator already lived through this install.
 */

import { observable } from "@legendapp/state";
import type { CanvasNode } from "@shared/canvas";
import type { Task, TaskState } from "@shared/work-model";
import { taskBrief } from "@shared/task";
import { openWorkDetail } from "./work-detail-open";
import { selectNode, state$ } from "./state";

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

export type CompletedNotifyPersist = {
  readonly dismissed: ReadonlyArray<string>;
  /** Task ids that have already been observed as completed (anti re-rise). */
  readonly completedSeen: ReadonlyArray<string>;
};

export const emptyCompletedNotifyState = (): CompletedNotifyState => ({
  baselined: false,
  known: {},
  dismissed: {},
  stack: [],
});

export const emptyCompletedNotifyPersist = (): CompletedNotifyPersist => ({
  dismissed: [],
  completedSeen: [],
});

/** Cap persisted id lists so localStorage cannot grow without bound. */
export const COMPLETED_NOTIFY_PERSIST_CAP = 500;

export const COMPLETED_NOTIFY_STORAGE_KEY =
  "vellum-command:completed-task-notify:v1";

export type CompletedNotifyStorage = {
  readonly load: () => CompletedNotifyPersist;
  readonly save: (data: CompletedNotifyPersist) => void;
};

const memoryStorage = (): CompletedNotifyStorage => {
  let data = emptyCompletedNotifyPersist();
  return {
    load: () => data,
    save: (next) => {
      data = {
        dismissed: [...next.dismissed],
        completedSeen: [...next.completedSeen],
      };
    },
  };
};

const browserLocalStorage = (): CompletedNotifyStorage => ({
  load: () => {
    try {
      if (typeof localStorage === "undefined") return emptyCompletedNotifyPersist();
      const raw = localStorage.getItem(COMPLETED_NOTIFY_STORAGE_KEY);
      if (!raw) return emptyCompletedNotifyPersist();
      const parsed = JSON.parse(raw) as Partial<CompletedNotifyPersist>;
      const dismissed = Array.isArray(parsed.dismissed)
        ? parsed.dismissed.filter((id): id is string => typeof id === "string" && id.length > 0)
        : [];
      const completedSeen = Array.isArray(parsed.completedSeen)
        ? parsed.completedSeen.filter(
            (id): id is string => typeof id === "string" && id.length > 0,
          )
        : [];
      return { dismissed, completedSeen };
    } catch {
      return emptyCompletedNotifyPersist();
    }
  },
  save: (data) => {
    try {
      if (typeof localStorage === "undefined") return;
      localStorage.setItem(
        COMPLETED_NOTIFY_STORAGE_KEY,
        JSON.stringify({
          dismissed: data.dismissed.slice(-COMPLETED_NOTIFY_PERSIST_CAP),
          completedSeen: data.completedSeen.slice(-COMPLETED_NOTIFY_PERSIST_CAP),
        }),
      );
    } catch {
      // Quota / private mode — in-memory state still holds for the session.
    }
  },
});

let notifyStorage: CompletedNotifyStorage =
  typeof localStorage === "undefined" ? memoryStorage() : browserLocalStorage();

/** Test seam — inject memory storage; returns restore fn. */
export const setCompletedNotifyStorageForTests = (
  storage: CompletedNotifyStorage,
): (() => void) => {
  const prev = notifyStorage;
  notifyStorage = storage;
  return () => {
    notifyStorage = prev;
  };
};

export const persistFromNotifyState = (
  state: CompletedNotifyState,
): CompletedNotifyPersist => {
  const dismissed = Object.keys(state.dismissed);
  const completedSeen = Object.entries(state.known)
    .filter(([, st]) => st === "completed")
    .map(([id]) => id);
  // Keep dismissed ids that are not currently known completed (gap) so a
  // later reappearance still respects the click.
  const seen = new Set([...completedSeen, ...dismissed]);
  return {
    dismissed,
    completedSeen: [...seen],
  };
};

export const hydrateNotifyStateFromPersist = (
  persist: CompletedNotifyPersist,
): CompletedNotifyState => {
  const dismissed: Record<string, true> = {};
  for (const id of persist.dismissed) dismissed[id] = true;
  const known: Record<string, TaskState> = {};
  for (const id of persist.completedSeen) known[id] = "completed";
  // Also mark dismissed as known completed so re-open cannot re-rise them
  // until we observe a non-completed transition.
  for (const id of persist.dismissed) {
    if (known[id] === undefined) known[id] = "completed";
  }
  return {
    baselined: false,
    known,
    dismissed,
    stack: [],
  };
};

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
    // Preserve hydrated dismiss + completed-seen across first open.
    return {
      baselined: true,
      known: nextKnown,
      dismissed: { ...state.dismissed },
      stack: [],
    };
  }

  const nextDismissed: Record<string, true> = { ...state.dismissed };
  // Clear dismiss only on an explicit observed non-completed state.
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
  // Ensure known stays completed so a gap cannot re-rise this id.
  known: {
    ...state.known,
    [taskId]: state.known[taskId] ?? "completed",
  },
  dismissed: { ...state.dismissed, [taskId]: true },
  stack: state.stack.filter((item) => item.id !== taskId),
});

// --- process store (survives RTS remount; dismiss persisted to localStorage) -

const writePersist = (state: CompletedNotifyState): void => {
  notifyStorage.save(persistFromNotifyState(state));
};

let notifyState: CompletedNotifyState = hydrateNotifyStateFromPersist(
  notifyStorage.load(),
);

export const completedTaskNotify$ = observable({
  items: [] as ReadonlyArray<CompletedTaskNotifyItem>,
});

/**
 * Test / full process teardown only. Does **not** clear durable dismiss —
 * call clearCompletedNotifyPersistForTests for that. Product RTS unmount must
 * not wipe operator dismissals.
 */
export const resetCompletedTaskNotify = (): void => {
  notifyState = hydrateNotifyStateFromPersist(notifyStorage.load());
  completedTaskNotify$.items.set([]);
};

/** Test helper — empty durable + memory state. */
export const clearCompletedNotifyPersistForTests = (): void => {
  notifyStorage.save(emptyCompletedNotifyPersist());
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
  writePersist(notifyState);
  completedTaskNotify$.items.set(notifyState.stack);
};

/** Click handler: durable dismiss + focus canvas + open tasks board. */
export const activateCompletedTaskNotify = (item: CompletedTaskNotifyItem): void => {
  notifyState = dismissCompletedNotify(notifyState, item.id);
  writePersist(notifyState);
  completedTaskNotify$.items.set(notifyState.stack);

  selectNode(item.nodeId);
  state$.focusNodeId.set(item.nodeId);
  openWorkDetail(item.nodeId, { itemId: item.id });
};

/**
 * Design / e2e capture hook — plant a stack without work transitions.
 * No-op surface in production unless the runner calls it; install is cheap.
 */
export const installCompletedNotifyTestHook = (): void => {
  if (typeof window === "undefined") return;
  (
    window as unknown as {
      __vellumTestInjectCompletedNotify?: (
        items: ReadonlyArray<{
          readonly id: string;
          readonly nodeId: string;
          readonly brief: string;
        }>,
      ) => void;
    }
  ).__vellumTestInjectCompletedNotify = (items) => {
    const at = Date.now();
    const known: Record<string, TaskState> = {};
    const stack = items.map((item, index) => {
      known[item.id] = "completed";
      return {
        id: item.id,
        nodeId: item.nodeId,
        brief: item.brief,
        at: at - index,
      };
    });
    notifyState = {
      baselined: true,
      known,
      dismissed: {},
      stack,
    };
    completedTaskNotify$.items.set(stack);
  };
};
