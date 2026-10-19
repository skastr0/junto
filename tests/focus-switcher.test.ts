import { afterEach, describe, expect, it, vi } from "vitest";
import { asCanvasName, type Node, type Seat } from "../src/shared/model";
import {
  buildFocusSwitcherCatalog,
  cancelFocusSwitcher,
  commitFocusSwitcher,
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
import { state$ } from "../src/renderer/lib/state";
import { modelStore } from "../src/renderer/lib/use-model";
import { note, region, seat, taskBoard } from "./support/model-nodes";

const agent = (id: string, label: string) => seat(id, { label });
const tasks = (id: string, name = "Backlog") => taskBoard(id, { name });

/** Hold these nodes as the open canvas; returns the function that puts things back. */
const holdOpen = (nodes: ReadonlyArray<Node>): (() => void) => {
  const previous = state$.canvasName.peek();
  const release = modelStore.adopt({ canvas: asCanvasName("switcher"), seq: 0, nodes, wires: [] });
  state$.canvasName.set("switcher");
  return () => {
    state$.canvasName.set(previous);
    release();
  };
};

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
    region("lane", { x: 0, y: 0, width: 400, height: 300 }),
  ];
  it("lists agents only, the most recently visited first, then the never visited by name", () => {
    const catalog = buildFocusSwitcherCatalog({
      nodes,
      focusNodeIds: ["bravo", "alpha"],
      hotbarSlots: slotsWith([{ index: 0, nodeId: "sink" }]),
      recentIds: ["sink", "memo"],
    });
    // sink was visited; alpha and bravo never were. The note is not an agent.
    expect(catalog.map((entry) => entry.nodeId)).toEqual(["sink", "alpha", "bravo"]);
    expect(catalog.map((entry) => entry.current)).toEqual([false, false, true]);
    expect(catalog[0]?.hotbarSlot).toBe(1);
    expect(catalog[1]?.hotbarSlot).toBeNull();
  });

  it("follows the visit order, not urgency or name", () => {
    const catalog = buildFocusSwitcherCatalog({
      nodes,
      focusNodeIds: [],
      hotbarSlots: emptyHotbarSlots(),
      recentIds: ["bravo", "sink", "alpha"],
    });
    expect(catalog.map((entry) => entry.nodeId)).toEqual(["bravo", "sink", "alpha"]);
  });

  it("is not capped", () => {
    const many = Array.from({ length: 40 }, (_, i) => agent(`a${i}`, `Agent ${i}`));
    const catalog = buildFocusSwitcherCatalog({
      nodes: many,
      focusNodeIds: [],
      hotbarSlots: emptyHotbarSlots(),
      recentIds: [],
    });
    expect(catalog).toHaveLength(40);
  });
});

describe("openingIndex", () => {
  const entry = (nodeId: string, current = false) => ({
    nodeId,
    title: nodeId,
    hotbarSlot: null,
    current,
  });

  it("comes up on the most recent agent, or the least recent stepping back", () => {
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
  it("opens on the seat visited just before, and landing on a seat makes it the most recent", () => {
    const previousSlots = state$.hotbarSlots.peek();
    const previousRegistry = dock$.registry.peek();
    const previousMru = state$.hotbarActiveMru.peek();
    const letGo = holdOpen([agent("alpha", "Alpha"), agent("bravo", "Bravo"), agent("cy", "Cy")]);
    try {
      state$.hotbarSlots.set(emptyHotbarSlots());
      dock$.registry.set(initialWorkbenchState());
      state$.hotbarActiveMru.set(["alpha", "bravo", "cy"]);
      expect(openFocusSwitcher(1)).toBe(true);
      const session = focusSwitcher$.session.peek();
      expect(session?.entries.map((entry) => entry.nodeId)).toEqual(["alpha", "bravo", "cy"]);
      // Nothing is in front, so it comes up on the most recent.
      expect(session && session.entries[session.selectedIndex]?.nodeId).toBe("alpha");
      expect(selectFocusSwitcherIndex(2)).toBe(true);
      commitFocusSwitcher();
      expect(state$.hotbarActiveMru.peek().slice(0, 3)).toEqual(["cy", "alpha", "bravo"]);
    } finally {
      letGo();
      state$.hotbarSlots.set(previousSlots);
      dock$.registry.set(previousRegistry);
      state$.hotbarActiveMru.set(previousMru);
    }
  });

  afterEach(() => {
    cancelFocusSwitcher();
  });

  it("opens on the next catalog entry and freezes order across moves", () => {
    const previousSlots = state$.hotbarSlots.peek();
    const previousRegistry = dock$.registry.peek();
    const letGo = holdOpen([agent("alpha", "Alpha"), agent("bravo", "Bravo"), tasks("sink")]);
    try {
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
      letGo();
      state$.hotbarSlots.set(previousSlots);
      dock$.registry.set(previousRegistry);
    }
  });

  it("closes without opening anything when the window is left", () => {
    const letGo = holdOpen([agent("alpha", "Alpha"), agent("bravo", "Bravo")]);
    const listeners = new Map<string, () => void>();
    const target = {
      addEventListener: (type: string, listener: () => void) => void listeners.set(type, listener),
      removeEventListener: (type: string) => void listeners.delete(type),
    };
    vi.stubGlobal("window", target);
    vi.stubGlobal("document", { ...target, hidden: true });
    try {
      for (const leave of ["blur", "visibilitychange"]) {
        expect(openFocusSwitcher(1)).toBe(true);
        listeners.get(leave)!();
        expect(focusSwitcher$.session.peek()).toBeNull();
        expect(listeners.size).toBe(0);
      }
    } finally {
      vi.unstubAllGlobals();
      letGo();
    }
  });

  it("refuses to open with fewer than two agents", () => {
    const letGo = holdOpen([agent("solo", "Solo")]);
    try {
      expect(openFocusSwitcher(1)).toBe(false);
      expect(focusSwitcher$.session.peek()).toBeNull();
    } finally {
      letGo();
    }
  });
});
