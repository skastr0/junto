/**
 * The stand-in for V1's store, until main's tables and their IPC land
 * (`04-view-state.md`, V1: product-feed). It behaves as main will: one record
 * per canvas, a write per changed row, and a push to every listener as a
 * change lands, so command groups read and write the same seam they will read
 * and write against `junto.db`.
 *
 * What it does not do is survive a quit. That is the whole of what V1 adds, so
 * the proof for V2 (arrange, quit, relaunch, it is there) runs after the
 * switch, not against this file. When V1 lands this file goes, and the default
 * `makeCanvasCommandGroups` takes is main's store instead.
 */
import { storedSlotsOf } from "./view-state";
import type {
  ArtifactsNodeView,
  AutomationsNodeView,
  FilesNodeView,
  NodeViewStore,
  SurfaceSize,
  TasksNodeView,
  ViewCommandSlot,
  ViewStateStore,
} from "./view-state";

export const makeMemoryViewStateStore = (): ViewStateStore => {
  const byCanvas = new Map<string, { slots: ViewCommandSlot[]; extras: ReadonlyArray<ReadonlyArray<string>> }>();
  const listeners = new Set<(canvas: string) => void>();

  const announce = (canvas: string): void => {
    for (const listener of listeners) listener(canvas);
  };

  /** A canvas's rows, or a fresh nine-slot board: main keeps one row per slot. */
  const held = (canvas: string) =>
    byCanvas.get(canvas) ?? {
      slots: storedSlotsOf([]),
      extras: [] as ReadonlyArray<ReadonlyArray<string>>,
    };

  const keep = (canvas: string, next: { slots: ViewCommandSlot[]; extras: ReadonlyArray<ReadonlyArray<string>> }) => {
    byCanvas.set(canvas, next);
    announce(canvas);
  };

  return {
    read: (canvas) => {
      if (!canvas) return undefined;
      const record = byCanvas.get(canvas);
      return record
        ? {
            slots: record.slots.map((slot) => ({ ...slot })),
            extras: record.extras.map((group) => [...group]),
          }
        : undefined;
    },
    writeSlot: (canvas, index, slot) => {
      if (!canvas) return;
      const current = held(canvas);
      const slots = current.slots.slice();
      slots[index] = { ...slot };
      keep(canvas, { slots, extras: current.extras });
    },
    writeExtras: (canvas, extras) => {
      if (!canvas) return;
      const current = held(canvas);
      keep(canvas, { slots: current.slots, extras: extras.map((group) => [...group]) });
    },
    onChange: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};

/**
 * The node surfaces' stand-in (V3), until V1's tables and IPC land: the same
 * rows in memory, a push on every change, nothing across a quit.
 */
export const makeMemoryNodeViewStore = (): NodeViewStore => {
  const rows = <V>() => new Map<string, V>();
  const artifacts = rows<ArtifactsNodeView>();
  const tasks = rows<TasksNodeView>();
  const automations = rows<AutomationsNodeView>();
  const files = rows<FilesNodeView>();
  const collapsed = new Set<string>();
  const sizes = rows<SurfaceSize>();
  let railOpen = false;
  const listeners = new Set<() => void>();
  const announce = (): void => {
    for (const listener of listeners) listener();
  };
  const keyOf = (canvas: string, node: string): string => `${canvas}\n${node}`;
  const reader = <V>(held: Map<string, V>) => (canvas: string, node: string): V | undefined =>
    canvas === "" ? undefined : held.get(keyOf(canvas, node));
  const writer = <V>(held: Map<string, V>) => (canvas: string, node: string, view: V): void => {
    if (canvas === "") return;
    held.set(keyOf(canvas, node), view);
    announce();
  };
  return {
    artifacts: reader(artifacts),
    writeArtifacts: writer(artifacts),
    tasks: reader(tasks),
    writeTasks: writer(tasks),
    automations: reader(automations),
    writeAutomations: writer(automations),
    files: reader(files),
    writeFiles: writer(files),
    sidebarCollapsed: (canvas, node) => canvas !== "" && collapsed.has(keyOf(canvas, node)),
    writeSidebarCollapsed: (canvas, node, next) => {
      if (canvas === "" || next === collapsed.has(keyOf(canvas, node))) return;
      if (next) collapsed.add(keyOf(canvas, node));
      else collapsed.delete(keyOf(canvas, node));
      announce();
    },
    surfaceSize: (surface) => sizes.get(surface),
    writeSurfaceSize: (surface, size) => {
      if (size === null) sizes.delete(surface);
      else sizes.set(surface, size);
      announce();
    },
    commentsRailOpen: () => railOpen,
    writeCommentsRailOpen: (open) => {
      if (open === railOpen) return;
      railOpen = open;
      announce();
    },
    onChange: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};
