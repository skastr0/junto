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
import type { ViewCommandSlot, ViewStateStore } from "./view-state";

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
