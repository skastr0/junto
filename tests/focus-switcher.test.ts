import { afterEach, describe, expect, it } from "vitest";
import type { CanvasNode, TextNode } from "../src/shared/canvas";
import {
  buildFocusSwitcherCatalog,
  cancelFocusSwitcher,
  focusMruNodeIds,
  focusSwitcher$,
  jumpFocusSwitcherHotbar,
  moveFocusSwitcher,
  nextSelectedIndex,
  openFocusSwitcher,
  selectFocusSwitcherIndex,
  wrapIndex,
} from "../src/renderer/lib/focus-switcher";
import { emptyHotbarSlots, type HotbarSlot } from "../src/renderer/lib/hotbar-slots";
import { dock$, terminalSurfaceId } from "../src/renderer/lib/dock-state";
import { initialWorkbenchState, openSurface } from "../src/renderer/lib/surface-registry";
import { state$ } from "../src/renderer/lib/state";

const agent = (id: string, label: string): TextNode => ({
  id,
  type: "text",
  text: label,
  x: 0,
  y: 0,
  width: 200,
  height: 80,
  ether: {
    entity: { kind: "agent", name: `local:${id}` },
    terminal: { bindingId: `local:${id}`, harness: "codex" },
  },
});

const tasks = (id: string, label = "Backlog"): TextNode => ({
  id,
  type: "text",
  text: label,
  x: 0,
  y: 0,
  width: 200,
  height: 80,
  ether: { entity: { kind: "task" }, tasks: { items: [] } },
});

const note = (id: string, text: string): TextNode => ({
  id,
  type: "text",
  text,
  x: 0,
  y: 0,
  width: 200,
  height: 80,
});

const region = (id: string): CanvasNode => ({
  id,
  type: "group",
  label: "Lane",
  x: 0,
  y: 0,
  width: 400,
  height: 300,
});

const slotsWith = (fixed: ReadonlyArray<{ readonly index: number; readonly nodeId: string }>): HotbarSlot[] => {
  const slots = emptyHotbarSlots();
  for (const item of fixed) {
    slots[item.index] = { kind: "fixed", nodeId: item.nodeId };
  }
  return slots;
};

describe("wrapIndex / nextSelectedIndex", () => {
  it("wraps forward and backward", () => {
    expect(wrapIndex(0, 3)).toBe(0);
    expect(wrapIndex(3, 3)).toBe(0);
    expect(wrapIndex(-1, 3)).toBe(2);
    expect(nextSelectedIndex(0, 3, 1)).toBe(1);
    expect(nextSelectedIndex(2, 3, 1)).toBe(0);
    expect(nextSelectedIndex(0, 3, -1)).toBe(2);
  });

  it("is 0 on empty", () => {
    expect(nextSelectedIndex(0, 0, 1)).toBe(0);
  });
});

describe("buildFocusSwitcherCatalog", () => {
  const nodes = [
    agent("alpha", "Alpha hub"),
    agent("bravo", "Bravo"),
    tasks("sink"),
    note("memo", "Field notes"),
    region("lane"),
  ];

  it("ranks open focus MRU first, then hotbar slots, then recency, then document order", () => {
    const catalog = buildFocusSwitcherCatalog({
      nodes,
      focusNodeIds: ["bravo", "alpha"],
      hotbarSlots: slotsWith([{ index: 0, nodeId: "sink" }]),
      hotbarActiveMru: ["memo"],
    });
    expect(catalog.map((entry) => entry.nodeId)).toEqual([
      "bravo",
      "alpha",
      "sink",
      "memo",
    ]);
    expect(catalog[0]?.current).toBe(true);
    expect(catalog[0]?.parked).toBe(true);
    expect(catalog[1]?.parked).toBe(true);
    expect(catalog[2]?.hotbarSlot).toBe(1);
    expect(catalog.find((entry) => entry.nodeId === "lane")).toBeUndefined();
  });

  it("drops furniture and unbound kinds, and caps the list", () => {
    const many = Array.from({ length: 20 }, (_, i) => agent(`a${i}`, `Agent ${i}`));
    const catalog = buildFocusSwitcherCatalog({
      nodes: many,
      focusNodeIds: [],
      hotbarSlots: emptyHotbarSlots(),
      hotbarActiveMru: [],
      cap: 5,
    });
    expect(catalog).toHaveLength(5);
    expect(catalog[0]?.nodeId).toBe("a0");
  });

  it("does not duplicate a parked node that is also on the hotbar", () => {
    const catalog = buildFocusSwitcherCatalog({
      nodes,
      focusNodeIds: ["alpha"],
      hotbarSlots: slotsWith([{ index: 2, nodeId: "alpha" }]),
      hotbarActiveMru: ["alpha"],
    });
    expect(catalog.filter((entry) => entry.nodeId === "alpha")).toHaveLength(1);
    expect(catalog[0]?.hotbarSlot).toBe(3);
  });
});

describe("focusMruNodeIds", () => {
  it("maps terminal surfaces in MRU order", () => {
    let state = initialWorkbenchState();
    state = openSurface(state, { id: terminalSurfaceId("alpha"), kind: "terminal" }).state;
    state = openSurface(state, { id: terminalSurfaceId("bravo"), kind: "terminal" }).state;
    expect(focusMruNodeIds(state.surfaces, state.focusMru)).toEqual(["bravo", "alpha"]);
  });
});

describe("focus switcher session", () => {
  afterEach(() => {
    cancelFocusSwitcher();
  });

  it("opens on the next catalog entry and freezes order across moves", () => {
    const previousDoc = state$.doc.peek();
    const previousSlots = state$.hotbarSlots.peek();
    const previousRegistry = dock$.registry.peek();
    try {
      state$.doc.set({
        nodes: [agent("alpha", "Alpha"), agent("bravo", "Bravo"), tasks("sink")],
        edges: [],
      });
      state$.hotbarSlots.set(emptyHotbarSlots());
      let registry = initialWorkbenchState();
      registry = openSurface(registry, {
        id: terminalSurfaceId("alpha"),
        kind: "terminal",
      }).state;
      dock$.registry.set(registry);

      expect(openFocusSwitcher(1)).toBe(true);
      const first = focusSwitcher$.session.peek();
      expect(first).not.toBeNull();
      expect(first?.entries.map((entry) => entry.nodeId)[0]).toBe("alpha");
      expect(first && first.entries[first.selectedIndex]?.nodeId).not.toBe("alpha");

      const frozen = first?.entries.map((entry) => entry.nodeId);
      expect(moveFocusSwitcher(1)).toBe(true);
      expect(focusSwitcher$.session.peek()?.entries.map((entry) => entry.nodeId)).toEqual(
        frozen,
      );

      expect(selectFocusSwitcherIndex(0)).toBe(true);
      expect(focusSwitcher$.session.peek()?.selectedIndex).toBe(0);
      expect(jumpFocusSwitcherHotbar(1)).toBe(false);
    } finally {
      state$.doc.set(previousDoc);
      state$.hotbarSlots.set(previousSlots);
      dock$.registry.set(previousRegistry);
    }
  });

  it("refuses to open with fewer than two models", () => {
    const previousDoc = state$.doc.peek();
    try {
      state$.doc.set({ nodes: [agent("solo", "Solo")], edges: [] });
      expect(openFocusSwitcher(1)).toBe(false);
      expect(focusSwitcher$.session.peek()).toBeNull();
    } finally {
      state$.doc.set(previousDoc);
    }
  });
});
