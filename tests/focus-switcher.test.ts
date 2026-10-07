import { afterEach, describe, expect, it, vi } from "vitest";
import type { CanvasNode, TextNode } from "../src/shared/canvas";
import {
  buildFocusSwitcherCatalog,
  cancelFocusSwitcher,
  focusMruNodeIds,
  focusSwitcher$,
  moveFocusSwitcher,
  nextSelectedIndex,
  openFocusSwitcher,
  openingIndex,
  selectFocusSwitcherIndex,
  wrapIndex,
} from "../src/renderer/lib/focus-switcher";
import { emptyHotbarSlots, type HotbarSlot } from "../src/renderer/lib/hotbar-slots";
import { dock$, terminalSurfaceId } from "../src/renderer/lib/dock-state";
import { initialWorkbenchState, openSurface } from "../src/renderer/lib/surface-registry";
import { SEAT_URGENCY, type SeatUrgency } from "../src/renderer/lib/seat-line";
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
    agent("sink", "Sink"),
    note("memo", "Field notes"),
    region("lane"),
  ];
  const urgency: Record<string, SeatUrgency> = {
    alpha: SEAT_URGENCY.working,
    bravo: SEAT_URGENCY.working,
    sink: SEAT_URGENCY.review,
  };
  const urgencyOf = (node: CanvasNode): SeatUrgency => urgency[node.id]!;

  it("lists agents only, the ones that need the operator first, then by name", () => {
    const catalog = buildFocusSwitcherCatalog({
      nodes,
      focusNodeIds: ["bravo", "alpha"],
      hotbarSlots: slotsWith([{ index: 0, nodeId: "sink" }]),
      urgencyOf,
    });
    expect(catalog.map((entry) => entry.nodeId)).toEqual(["sink", "alpha", "bravo"]);
    expect(catalog.map((entry) => entry.current)).toEqual([false, false, true]);
    expect(catalog[0]?.hotbarSlot).toBe(1);
    expect(catalog[1]?.hotbarSlot).toBeNull();
  });

  it("is not capped", () => {
    const many = Array.from({ length: 40 }, (_, i) => agent(`a${i}`, `Agent ${i}`));
    const catalog = buildFocusSwitcherCatalog({
      nodes: many,
      focusNodeIds: [],
      hotbarSlots: emptyHotbarSlots(),
      urgencyOf: () => SEAT_URGENCY.review,
    });
    expect(catalog).toHaveLength(40);
  });
});

describe("openingIndex", () => {
  const entry = (nodeId: string, current = false) => ({
    nodeId,
    title: nodeId,
    kindLabel: "Agent",
    hotbarSlot: null,
    current,
  });

  it("comes up on the most urgent agent, or the least urgent stepping back", () => {
    const entries = [entry("a"), entry("b", true), entry("c")];
    expect(openingIndex(entries, 1)).toBe(0);
    expect(openingIndex(entries, -1)).toBe(2);
  });

  it("skips the agent already in front", () => {
    expect(openingIndex([entry("a", true), entry("b"), entry("c")], 1)).toBe(1);
    expect(openingIndex([entry("a"), entry("b"), entry("c", true)], -1)).toBe(1);
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
      // Agents only: the task node is not in the switcher.
      expect(first?.entries.map((entry) => entry.nodeId)).toEqual(["alpha", "bravo"]);
      expect(first && first.entries[first.selectedIndex]?.nodeId).toBe("bravo");

      const frozen = first?.entries.map((entry) => entry.nodeId);
      expect(moveFocusSwitcher(1)).toBe(true);
      expect(focusSwitcher$.session.peek()?.entries.map((entry) => entry.nodeId)).toEqual(
        frozen,
      );

      expect(selectFocusSwitcherIndex(0)).toBe(true);
      expect(focusSwitcher$.session.peek()?.selectedIndex).toBe(0);
    } finally {
      state$.doc.set(previousDoc);
      state$.hotbarSlots.set(previousSlots);
      dock$.registry.set(previousRegistry);
    }
  });

  it("closes without opening anything when the window is left", () => {
    const previousDoc = state$.doc.peek();
    const listeners = new Map<string, () => void>();
    const target = {
      addEventListener: (type: string, listener: () => void) => void listeners.set(type, listener),
      removeEventListener: (type: string) => void listeners.delete(type),
    };
    vi.stubGlobal("window", target);
    vi.stubGlobal("document", { ...target, hidden: true });
    try {
      state$.doc.set({ nodes: [agent("alpha", "Alpha"), agent("bravo", "Bravo")], edges: [] });
      for (const leave of ["blur", "visibilitychange"]) {
        expect(openFocusSwitcher(1)).toBe(true);
        listeners.get(leave)!();
        expect(focusSwitcher$.session.peek()).toBeNull();
        expect(listeners.size).toBe(0);
      }
    } finally {
      vi.unstubAllGlobals();
      state$.doc.set(previousDoc);
    }
  });

  it("refuses to open with fewer than two agents", () => {
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
