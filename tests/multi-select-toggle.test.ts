import { describe, expect, it } from "vitest";
import { toggleInSelection } from "../src/renderer/lib/multi-select-gesture";

type FakeNode = { id: string; selected: boolean };

/** React Flow's store, as far as a shift-press on a card touches it. */
const fakeStore = (nodes: FakeNode[], multiSelectionActive: boolean) => {
  const state = {
    multiSelectionActive,
    nodeLookup: new Map(nodes.map((node) => [node.id, node])),
    edges: [] as Array<{ selected?: boolean }>,
    /** What the flag said at the moment React Flow was asked to add. */
    flagWhenAdding: undefined as boolean | undefined,
    addSelectedNodes: (ids: string[]) => {
      state.flagWhenAdding = state.multiSelectionActive;
      // React Flow replaces the selection unless the key is down.
      for (const node of nodes) node.selected = ids.includes(node.id) || (state.multiSelectionActive && node.selected);
    },
    unselectNodesAndEdges: ({ nodes: gone }: { nodes: FakeNode[] }) => {
      for (const node of gone) node.selected = false;
    },
  };
  const store = {
    getState: () => state,
    setState: (patch: Partial<typeof state>) => Object.assign(state, patch),
  };
  return { state, store: store as unknown as Parameters<typeof toggleInSelection>[0] };
};

describe("a shift-press on a card", () => {
  it("adds the card to the selection and leaves React Flow's key state as it found it", () => {
    const nodes = [{ id: "a", selected: true }, { id: "b", selected: false }];
    const { state, store } = fakeStore(nodes, false);
    toggleInSelection(store, "b");
    expect(nodes.map((node) => node.selected)).toEqual([true, true]);
    // It was told the key is down for the add, and only for the add.
    expect(state.flagWhenAdding).toBe(true);
    expect(state.multiSelectionActive).toBe(false);
  });

  it("takes a selected card out and leaves the key state as it found it", () => {
    const nodes = [{ id: "a", selected: true }, { id: "b", selected: true }];
    const { state, store } = fakeStore(nodes, false);
    toggleInSelection(store, "b");
    expect(nodes.map((node) => node.selected)).toEqual([true, false]);
    expect(state.multiSelectionActive).toBe(false);
  });

  it("does not turn the key state off when React Flow already had it on", () => {
    const nodes = [{ id: "a", selected: true }, { id: "b", selected: false }];
    const { state, store } = fakeStore(nodes, true);
    toggleInSelection(store, "b");
    expect(state.multiSelectionActive).toBe(true);
  });

  it("changes nothing for a card that is not there", () => {
    const { state, store } = fakeStore([{ id: "a", selected: true }], false);
    toggleInSelection(store, "gone");
    expect(state.multiSelectionActive).toBe(false);
    expect(state.flagWhenAdding).toBeUndefined();
  });
});
