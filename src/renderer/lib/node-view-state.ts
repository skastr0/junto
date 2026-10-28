import { useSyncExternalStore } from "react";
import type { AutomationsNodeView, NodeViewStore, TasksNodeView } from "./view-state";
import { makeMemoryNodeViewStore } from "./view-state-stand-in";

/**
 * Where the node surfaces read and write how the operator left them (0.11,
 * 04, V3): each node's filters and open item, a collapsed sidebar, a resized
 * modal and the comments rail. This window's store is main's once V1 lands;
 * until then the stand-in, which holds the same rows in memory.
 */
let store: NodeViewStore = makeMemoryNodeViewStore();

export const nodeViewStore = (): NodeViewStore => store;

/** V1's switch and tests set the store. */
export const setNodeViewStore = (next: NodeViewStore): void => {
  store = next;
};

/**
 * One value read from the store, read again on every change. `read` must
 * return the store's own object (or a primitive), so an unchanged row is the
 * same snapshot.
 */
export const useNodeView = <T>(read: (store: NodeViewStore) => T): T =>
  useSyncExternalStore(
    (listener) => store.onChange(listener),
    () => read(store),
  );

const TASKS_OPEN: TasksNodeView = { state: "all", open: null };

/** The Tasks node as the operator left it: its state filter and the task it had open. */
export const useTasksNodeView = (
  canvasName: string,
  nodeId: string,
): TasksNodeView & { readonly setState: (state: TasksNodeView["state"]) => void; readonly setOpen: (open: string | null) => void } => {
  const kept = useNodeView((store) => store.tasks(canvasName, nodeId)) ?? TASKS_OPEN;
  const update = (change: Partial<TasksNodeView>): void => {
    const last = store.tasks(canvasName, nodeId) ?? TASKS_OPEN;
    const next = { ...last, ...change };
    if (next.state !== last.state || next.open !== last.open) store.writeTasks(canvasName, nodeId, next);
  };
  return { ...kept, setState: (state) => update({ state }), setOpen: (open) => update({ open }) };
};

/** The automation the Automations node had open. */
export const useAutomationsNodeView = (
  canvasName: string,
  nodeId: string,
): AutomationsNodeView & { readonly setOpen: (open: string | null) => void } => {
  const kept = useNodeView((store) => store.automations(canvasName, nodeId));
  return {
    open: kept?.open ?? null,
    setOpen: (open) => {
      if ((store.automations(canvasName, nodeId)?.open ?? null) !== open) store.writeAutomations(canvasName, nodeId, { open });
    },
  };
};
