import { describe, expect, it } from "vitest";
import type { SheetChanged, SheetGrid } from "../src/shared/model/sheet";
import { createSheetStore, type SheetApi } from "../src/renderer/lib/sheet-store";

const grid = (cell: string): SheetGrid =>
  ({ columns: [{ id: "c1", name: "A" }], rows: [{ id: "r1", cells: { c1: cell } }] }) as unknown as SheetGrid;

const rig = () => {
  const stored = new Map<string, SheetGrid>();
  const reads: string[] = [];
  const listeners = new Set<(event: SheetChanged) => void>();
  const waiting: Array<() => void> = [];
  let hold = false;
  const api: SheetApi = {
    modelSheetRead: ({ canvas, id }) => {
      reads.push(`${canvas}/${id}`);
      const answer = stored.get(`${canvas}/${id}`) ?? ({ columns: [], rows: [] } as SheetGrid);
      return hold ? new Promise((resolve) => waiting.push(() => resolve(answer))) : Promise.resolve(answer);
    },
    onModelSheetChanged: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    api,
    stored,
    reads,
    listeners,
    written: (canvas: string, id: string) => {
      for (const listener of [...listeners]) listener({ canvas, id } as SheetChanged);
    },
    holdReads: (on: boolean) => {
      hold = on;
    },
    answer: () => {
      for (const go of waiting.splice(0)) go();
    },
  };
};

const settle = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("the window's sheet store", () => {
  it("reads a grid the first time a sheet is shown, and once however many show it", async () => {
    const r = rig();
    r.stored.set("factory/s1", grid("one"));
    const store = createSheetStore(() => r.api);
    expect(store.gridOf("factory", "s1")).toBeUndefined();
    const first = store.hold("factory", "s1");
    const second = store.hold("factory", "s1");
    await settle();
    expect(r.reads).toEqual(["factory/s1"]);
    expect(store.gridOf("factory", "s1")).toEqual(grid("one"));
    first();
    expect(store.gridOf("factory", "s1")).toEqual(grid("one"));
    second();
    expect(store.gridOf("factory", "s1")).toBeUndefined();
    expect(r.listeners.size).toBe(0);
  });

  it("reads again when main says a held sheet was written, and ignores one it does not hold", async () => {
    const r = rig();
    r.stored.set("factory/s1", grid("one"));
    const store = createSheetStore(() => r.api);
    const release = store.hold("factory", "s1");
    await settle();
    r.stored.set("factory/s1", grid("two"));
    r.written("factory", "s1");
    r.written("factory", "other");
    r.written("elsewhere", "s1");
    await settle();
    expect(r.reads).toEqual(["factory/s1", "factory/s1"]);
    expect(store.gridOf("factory", "s1")).toEqual(grid("two"));
    release();
  });

  it("shows a grid the window just wrote at once, and a read begun before it does not undo it", async () => {
    const r = rig();
    r.stored.set("factory/s1", grid("old"));
    const store = createSheetStore(() => r.api);
    r.holdReads(true);
    const release = store.hold("factory", "s1");
    store.show("factory", "s1", grid("typed"));
    expect(store.gridOf("factory", "s1")).toEqual(grid("typed"));
    r.answer();
    await settle();
    expect(store.gridOf("factory", "s1")).toEqual(grid("typed"));
    release();
  });

  it("keeps nothing for a sheet nobody shows, and does nothing without a main", async () => {
    const r = rig();
    const store = createSheetStore(() => r.api);
    store.show("factory", "s1", grid("typed"));
    expect(store.gridOf("factory", "s1")).toBeUndefined();
    const none = createSheetStore(() => undefined);
    const release = none.hold("factory", "s1");
    await settle();
    expect(none.gridOf("factory", "s1")).toBeUndefined();
    release();
  });
});
