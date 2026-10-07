import { observable } from "@legendapp/state";
import { use$ } from "@legendapp/state/react";
import { useEffect } from "react";
import type { SheetChanged, SheetGrid } from "@shared/model/sheet";
import { getJuntoApi } from "./junto-api";

// What each sheet on screen holds. A sheet's grid is content of its own: it is
// not on the sheet's node, it is read by canvas and id and written by its own
// command. A grid is read the first time something shows it, and read again
// whenever main says it was written.

export type SheetApi = {
  readonly modelSheetRead: (input: { readonly canvas: string; readonly id: string }) => Promise<SheetGrid>;
  readonly onModelSheetChanged: (listener: (event: SheetChanged) => void) => () => void;
};

const keyOf = (canvas: string, id: string): string => `${canvas}/${id}`;

export const createSheetStore = (getApi: () => SheetApi | undefined) => {
  const grids$ = observable<Record<string, SheetGrid>>({});
  /** How many readers hold each sheet. A sheet nobody shows is not kept. */
  const held = new Map<string, number>();
  /** Bumped by every read and every local write, so a slow read cannot land over a newer grid. */
  const turn = new Map<string, number>();
  let unwatch: (() => void) | undefined;

  const read = (canvas: string, id: string): void => {
    const api = getApi();
    if (!api) return;
    const key = keyOf(canvas, id);
    const mine = (turn.get(key) ?? 0) + 1;
    turn.set(key, mine);
    void api.modelSheetRead({ canvas, id }).then(
      (grid) => {
        if (turn.get(key) === mine && held.has(key)) grids$[key]!.set(grid);
      },
      () => undefined,
    );
  };

  const watch = (): void => {
    if (unwatch) return;
    unwatch = getApi()?.onModelSheetChanged((event) => {
      if (held.has(keyOf(event.canvas, event.id))) read(event.canvas, event.id);
    });
  };

  /** Keep a sheet's grid for as long as the caller shows it. Returns the way to let go. */
  const hold = (canvas: string, id: string): (() => void) => {
    const key = keyOf(canvas, id);
    const before = held.get(key) ?? 0;
    held.set(key, before + 1);
    watch();
    if (before === 0) read(canvas, id);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (held.get(key) ?? 1) - 1;
      if (left > 0) {
        held.set(key, left);
        return;
      }
      held.delete(key);
      turn.delete(key);
      grids$[key]!.delete();
      if (held.size === 0) {
        unwatch?.();
        unwatch = undefined;
      }
    };
  };

  return {
    /** The grid of one sheet, followed. Undefined until it has been read. */
    grid$: (canvas: string, id: string) => grids$[keyOf(canvas, id)]!,
    hold,
    /** The grid as it stands now, read once and not followed. */
    gridOf: (canvas: string, id: string): SheetGrid | undefined => grids$[keyOf(canvas, id)]!.peek(),
    /** Show a grid the window has just written, ahead of main saying so. */
    show: (canvas: string, id: string, grid: SheetGrid): void => {
      const key = keyOf(canvas, id);
      if (!held.has(key)) return;
      turn.set(key, (turn.get(key) ?? 0) + 1);
      grids$[key]!.set(grid);
    },
  };
};

export type SheetStore = ReturnType<typeof createSheetStore>;

export const sheetStore = createSheetStore(getJuntoApi);

/** The grid of a sheet, kept for as long as the caller is mounted. Undefined until read. */
export const useSheetGrid = (canvas: string, id: string): SheetGrid | undefined => {
  useEffect(() => {
    if (!canvas || !id) return;
    return sheetStore.hold(canvas, id);
  }, [canvas, id]);
  return use$(() => (canvas && id ? sheetStore.grid$(canvas, id).get() : undefined));
};
