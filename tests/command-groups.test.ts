import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  HotbarSlot,
  HotbarSlots,
  applyHotbarLeases,
  assignFixedSlot,
  clearHotbarNode,
  emptyHotbarSlots,
  nodeIdAt,
  pruneHotbarSlots,
  purgeNonEligibleSoftSlots,
  resolveHotbarSlots,
  slotIndexOf,
  slotMemberIds,
} from "../src/renderer/lib/hotbar-slots";
import {
  currentSelectionIds,
  firstFreeSlotIndex,
  groupLabel,
  makeCanvasCommandGroups,
  operatorHeldSlots,
  promoteExtraGroup,
  pruneExtraGroups,
  jumpCommandGroup,
  recallCommandGroup,
  saveSelectionAsNewGroup,
  saveSelectionToSlot,
  selectionIsGroup,
  slotContentKey,
  summarizeSlots,
  swapHotbarSlots,
  type CommandGroupRetap,
  type RecallContext,
} from "../src/renderer/lib/command-groups";
import { REGION_RETAP_GAP_MS } from "../src/renderer/lib/region-retap";
import { makeMemoryViewStateStore } from "../src/renderer/lib/view-state-stand-in";
import type { ViewCommandSlot, ViewStateStore } from "../src/renderer/lib/view-state";

const board = (entries: ReadonlyArray<readonly [number, HotbarSlot]>): HotbarSlot[] => {
  const slots = emptyHotbarSlots();
  for (const [index, slot] of entries) slots[index] = slot;
  return slots;
};
const fixed = (nodeId: string): HotbarSlot => ({ kind: "fixed", nodeId });
const leased = (nodeId: string): HotbarSlot => ({ kind: "leased", nodeId });
const evicted = (nodeId: string): HotbarSlot => ({ kind: "evicted", nodeId });
const group = (...nodeIds: string[]): HotbarSlot => ({ kind: "group", nodeIds });

const DOC = ["a", "b", "c", "d", "region", "r1", "r2"];
const context: RecallContext = {
  documentNodeIds: DOC,
  regionIds: new Set(["region"]),
  regionMembers: (id) => (id === "region" ? ["r2", "r1"] : []),
};

describe("group slot schema", () => {
  it("decodes a group and keeps the nine-slot board", () => {
    expect(Schema.decodeUnknownSync(HotbarSlot)(group("a", "b"))).toEqual(group("a", "b"));
    const decoded = Schema.decodeUnknownSync(HotbarSlots)(board([[2, group("a", "b")]]));
    expect(decoded[2]).toEqual(group("a", "b"));
  });

  it("rejects a group with no members or a blank id", () => {
    expect(() => Schema.decodeUnknownSync(HotbarSlot)({ kind: "group", nodeIds: [] })).toThrow();
    expect(() => Schema.decodeUnknownSync(HotbarSlot)({ kind: "group", nodeIds: [""] })).toThrow();
  });
});

describe("currentSelectionIds", () => {
  it("prefers a current multi set", () => {
    expect(currentSelectionIds("", ["a", "b"])).toEqual(["a", "b"]);
    expect(currentSelectionIds("b", ["a", "b"])).toEqual(["a", "b"]);
  });

  it("lets a later single write win over a stale multi set", () => {
    expect(currentSelectionIds("c", ["a", "b"])).toEqual(["c"]);
  });

  it("reads single and empty selections", () => {
    expect(currentSelectionIds("a", [])).toEqual(["a"]);
    expect(currentSelectionIds("", ["a"])).toEqual(["a"]);
    expect(currentSelectionIds("", [])).toEqual([]);
  });
});

describe("saveSelectionToSlot", () => {
  it("saves one node as fixed and moves it off other single slots", () => {
    const next = saveSelectionToSlot(board([[0, fixed("a")], [4, leased("b")]]), ["a"], 2, DOC);
    expect(next?.[0]).toEqual({ kind: "empty" });
    expect(next?.[2]).toEqual(fixed("a"));
    expect(next?.[4]).toEqual(leased("b"));
  });

  it("saves two or more as a group in document order", () => {
    const next = saveSelectionToSlot(emptyHotbarSlots(), ["c", "a", "b"], 0, DOC);
    expect(next?.[0]).toEqual(group("a", "b", "c"));
  });

  it("keeps members in their single slots and other groups (overlap allowed)", () => {
    const slots = board([[0, fixed("a")], [1, group("a", "d")]]);
    const next = saveSelectionToSlot(slots, ["a", "b"], 2, DOC);
    expect(next?.[0]).toEqual(fixed("a"));
    expect(next?.[1]).toEqual(group("a", "d"));
    expect(next?.[2]).toEqual(group("a", "b"));
  });

  it("replaces whatever the slot held", () => {
    for (const held of [fixed("d"), group("c", "d"), leased("d"), evicted("d")]) {
      const next = saveSelectionToSlot(board([[3, held]]), ["a", "b"], 3, DOC);
      expect(next?.[3]).toEqual(group("a", "b"));
    }
    const single = saveSelectionToSlot(board([[3, group("c", "d")]]), ["a"], 3, DOC);
    expect(single?.[3]).toEqual(fixed("a"));
  });

  it("drops dead and duplicate ids, collapsing to fixed when one is left", () => {
    expect(saveSelectionToSlot(emptyHotbarSlots(), ["a", "gone", "a"], 0, DOC)?.[0]).toEqual(fixed("a"));
  });

  it("saves nothing for an empty or dead selection or an out-of-range slot", () => {
    expect(saveSelectionToSlot(emptyHotbarSlots(), [], 0, DOC)).toBeNull();
    expect(saveSelectionToSlot(emptyHotbarSlots(), ["gone"], 0, DOC)).toBeNull();
    expect(saveSelectionToSlot(emptyHotbarSlots(), ["a", "b"], 9, DOC)).toBeNull();
    expect(saveSelectionToSlot(emptyHotbarSlots(), ["a", "b"], -1, DOC)).toBeNull();
  });

  it("always returns nine slots", () => {
    expect(saveSelectionToSlot([], ["a", "b"], 8, DOC)).toHaveLength(9);
  });
});

describe("swapHotbarSlots", () => {
  it("swaps two slots whole, keeping both assignments", () => {
    const next = swapHotbarSlots(board([[0, fixed("a")], [1, fixed("b")]]), 0, 1);
    expect(next[0]).toEqual(fixed("b"));
    expect(next[1]).toEqual(fixed("a"));
  });

  it("moves into an empty slot", () => {
    const next = swapHotbarSlots(board([[0, group("a", "b")]]), 0, 5);
    expect(next[0]).toEqual({ kind: "empty" });
    expect(next[5]).toEqual(group("a", "b"));
  });

  it("is a no-op for the same or an out-of-range index", () => {
    const slots = board([[0, fixed("a")]]);
    expect(swapHotbarSlots(slots, 0, 0)).toEqual(slots);
    expect(swapHotbarSlots(slots, 0, 9)).toEqual(slots);
  });
});

describe("firstFreeSlotIndex", () => {
  it("prefers empty, then soft-hold, then lease", () => {
    expect(firstFreeSlotIndex(board([[0, fixed("a")]]))).toBe(1);
    const full = Array.from({ length: 9 }, (_, i) => fixed(`n${i}`));
    full[6] = leased("x");
    expect(firstFreeSlotIndex(full)).toBe(6);
    full[7] = evicted("y");
    expect(firstFreeSlotIndex(full)).toBe(7);
  });

  it("never lands on an operator slot", () => {
    const full = Array.from({ length: 9 }, (_, i) => (i % 2 ? fixed(`n${i}`) : group(`g${i}`)));
    expect(firstFreeSlotIndex(full)).toBeNull();
  });
});

describe("recallCommandGroup", () => {
  const slots = board([
    [0, group("c", "a")],
    [1, fixed("b")],
    [2, fixed("region")],
    [3, leased("d")],
  ]);

  it("does nothing for an empty slot", () => {
    expect(recallCommandGroup(slots, 8, context, null, 0)).toEqual({ step: { kind: "none" }, memory: null });
  });

  it("frames a group's live members in document order", () => {
    const { step, memory } = recallCommandGroup(slots, 0, context, null, 0);
    expect(step).toEqual({ kind: "frame-group", nodeIds: ["a", "c"] });
    expect(memory).toEqual({ slotIndex: 0, key: "group:c,a", atMs: 0, memberCursor: -1 });
  });

  it("re-tapping a group cycles and opens members, wrapping", () => {
    let memory: CommandGroupRetap | null = null;
    const steps = [0, 100, 200, 300].map((at) => {
      const result = recallCommandGroup(slots, 0, context, memory, at);
      memory = result.memory;
      return result.step;
    });
    expect(steps).toEqual([
      { kind: "frame-group", nodeIds: ["a", "c"] },
      { kind: "open", nodeId: "a" },
      { kind: "open", nodeId: "c" },
      { kind: "open", nodeId: "a" },
    ]);
  });

  it("a slow second press frames the group again", () => {
    const first = recallCommandGroup(slots, 0, context, null, 0);
    const late = recallCommandGroup(slots, 0, context, first.memory, REGION_RETAP_GAP_MS + 1);
    expect(late.step.kind).toBe("frame-group");
  });

  it("focuses a node, and a re-tap opens it", () => {
    const first = recallCommandGroup(slots, 1, context, null, 0);
    expect(first.step).toEqual({ kind: "focus", nodeId: "b" });
    const second = recallCommandGroup(slots, 1, context, first.memory, 100);
    expect(second.step).toEqual({ kind: "open", nodeId: "b" });
  });

  it("recalls leased and soft-held nodes like fixed ones", () => {
    expect(recallCommandGroup(slots, 3, context, null, 0).step).toEqual({ kind: "focus", nodeId: "d" });
  });

  it("focuses a region, and re-taps cycle its members in document order", () => {
    const first = recallCommandGroup(slots, 2, context, null, 0);
    expect(first.step).toEqual({ kind: "focus", nodeId: "region" });
    const second = recallCommandGroup(slots, 2, context, first.memory, 100);
    expect(second.step).toEqual({ kind: "open", nodeId: "r1" });
    const third = recallCommandGroup(slots, 2, context, second.memory, 200);
    expect(third.step).toEqual({ kind: "open", nodeId: "r2" });
  });

  it("an empty region only focuses, even on re-tap", () => {
    const empty: RecallContext = { ...context, regionMembers: () => [] };
    const first = recallCommandGroup(slots, 2, empty, null, 0);
    expect(recallCommandGroup(slots, 2, empty, first.memory, 100).step).toEqual({
      kind: "focus",
      nodeId: "region",
    });
  });

  it("a press on another slot resets the cycle", () => {
    const first = recallCommandGroup(slots, 0, context, null, 0);
    const other = recallCommandGroup(slots, 1, context, first.memory, 50);
    const back = recallCommandGroup(slots, 0, context, other.memory, 100);
    expect(back.step.kind).toBe("frame-group");
  });

  it("a re-tap after the slot's content changed is a first press", () => {
    const first = recallCommandGroup(slots, 1, context, null, 0);
    const resaved = board([[1, fixed("d")]]);
    expect(recallCommandGroup(resaved, 1, context, first.memory, 100).step).toEqual({
      kind: "focus",
      nodeId: "d",
    });
  });

  it("does nothing when every member is gone", () => {
    const dead: RecallContext = { ...context, documentNodeIds: ["b"] };
    expect(recallCommandGroup(slots, 0, dead, null, 0).step).toEqual({ kind: "none" });
    expect(recallCommandGroup(board([[0, fixed("gone")]]), 0, context, null, 0).step).toEqual({
      kind: "none",
    });
  });
});

describe("pruning with groups", () => {
  it("drops dead members and empties a group only when none is left", () => {
    const slots = board([[0, group("a", "b", "c")], [1, group("x", "y")], [2, fixed("gone")]]);
    const next = pruneHotbarSlots(slots, ["a", "c"]);
    expect(next[0]).toEqual(group("a", "c"));
    expect(next[1]).toEqual({ kind: "empty" });
    expect(next[2]).toEqual({ kind: "empty" });
  });

  it("keeps an untouched group's identity", () => {
    const slots = board([[0, group("a", "b")]]);
    expect(pruneHotbarSlots(slots, ["a", "b"])[0]).toBe(slots[0]);
  });

  it("a group left with one member still recalls it", () => {
    const next = pruneHotbarSlots(board([[0, group("a", "b")]]), ["a"]);
    expect(recallCommandGroup(next, 0, context, null, 0).step).toEqual({
      kind: "frame-group",
      nodeIds: ["a"],
    });
  });
});

describe("leases around groups", () => {
  it("never overwrite or clear a group", () => {
    const slots = board([[0, group("a", "b")]]);
    const next = applyHotbarLeases(slots, ["c"], DOC, ["c"]);
    expect(next[0]).toEqual(group("a", "b"));
    expect(next[1]).toEqual(leased("c"));
  });

  it("resolve prunes group members too", () => {
    const next = resolveHotbarSlots(board([[0, group("a", "gone")]]), DOC, [], []);
    expect(next[0]).toEqual(group("a"));
  });

  it("purging non-actor soft slots leaves groups alone", () => {
    const slots = board([[0, group("a", "b")], [1, evicted("note")]]);
    const next = purgeNonEligibleSoftSlots(slots, new Set());
    expect(next[0]).toEqual(group("a", "b"));
    expect(next[1]).toEqual({ kind: "empty" });
  });

  it("a group member can still lease its own slot", () => {
    const next = applyHotbarLeases(board([[0, group("a", "b")]]), ["a"], DOC, ["a"]);
    expect(next[1]).toEqual(leased("a"));
  });
});

describe("single-slot helpers around groups", () => {
  const slots = board([[0, group("a", "b")], [1, fixed("a")]]);

  it("slotIndexOf and nodeIdAt see single-node slots only", () => {
    expect(slotIndexOf(slots, "a")).toBe(1);
    expect(slotIndexOf(slots, "b")).toBeNull();
    expect(nodeIdAt(slots, 0)).toBeUndefined();
  });

  it("slotMemberIds lists every held node", () => {
    expect(slotMemberIds(slots[0]!)).toEqual(["a", "b"]);
    expect(slotMemberIds(slots[1]!)).toEqual(["a"]);
    expect(slotMemberIds({ kind: "empty" })).toEqual([]);
  });

  it("assigning or clearing a node leaves groups intact", () => {
    expect(assignFixedSlot(slots, "a", 4)[0]).toEqual(group("a", "b"));
    expect(assignFixedSlot(slots, "a", 4)[1]).toEqual({ kind: "empty" });
    expect(clearHotbarNode(slots, "a")[0]).toEqual(group("a", "b"));
  });
});

describe("presentation", () => {
  const titles: Record<string, string> = { a: "Scout", b: "Builder", c: "Critic" };
  const titleOf = (id: string) => titles[id] ?? id;

  it("labels groups by first member and count", () => {
    expect(groupLabel([])).toBe("");
    expect(groupLabel(["Scout"])).toBe("Scout");
    expect(groupLabel(["Scout", "Builder", "Critic"])).toBe("Scout +2");
  });

  it("summarizes every slot for the picker", () => {
    const summary = summarizeSlots(board([[0, group("a", "b", "c")], [1, leased("a")]]), titleOf);
    expect(summary).toHaveLength(9);
    expect(summary[0]).toEqual({
      index: 0,
      taken: true,
      held: true,
      count: 3,
      label: "Scout +2",
      detail: "Scout, Builder, Critic",
    });
    expect(summary[1]).toMatchObject({ taken: true, held: false, count: 1, label: "Scout" });
    expect(summary[2]).toMatchObject({ taken: false, held: false, count: 0, label: "", detail: "" });
  });

  it("knows when the selection is exactly a group", () => {
    expect(selectionIsGroup(["b", "a"], group("a", "b"))).toBe(true);
    expect(selectionIsGroup(["a"], group("a", "b"))).toBe(false);
    expect(selectionIsGroup(["a", "b", "c"], group("a", "b"))).toBe(false);
    expect(selectionIsGroup(["a"], fixed("a"))).toBe(false);
  });

  it("fingerprints content", () => {
    expect(slotContentKey(undefined)).toBe("");
    expect(slotContentKey({ kind: "empty" })).toBe("");
    expect(slotContentKey(fixed("a"))).toBe(slotContentKey(leased("a")));
    expect(slotContentKey(group("a", "b"))).not.toBe(slotContentKey(group("b", "a", "c")));
  });
});

describe("per-canvas memory", () => {
  it("keeps only operator slots", () => {
    const slots = board([[0, fixed("a")], [1, group("a", "b")], [2, leased("c")], [3, evicted("d")]]);
    expect(operatorHeldSlots(slots)).toEqual(board([[0, fixed("a")], [1, group("a", "b")]]));
  });

  it("remembers each canvas separately and returns an empty board for strangers", () => {
    const memory = makeCanvasCommandGroups();
    memory.remember("alpha", board([[0, group("a", "b")], [2, leased("c")]]));
    memory.remember("beta", board([[4, fixed("z")]]));
    expect(memory.recall("alpha")).toEqual(board([[0, group("a", "b")]]));
    expect(memory.recall("beta")).toEqual(board([[4, fixed("z")]]));
    expect(memory.recall("gamma")).toEqual(emptyHotbarSlots());
    expect(memory.recall("")).toEqual(emptyHotbarSlots());
  });

  it("ignores a blank canvas name and hands out copies", () => {
    const memory = makeCanvasCommandGroups();
    memory.remember("", board([[0, fixed("a")]]));
    expect(memory.recall("")).toEqual(emptyHotbarSlots());
    memory.remember("alpha", board([[0, fixed("a")]]));
    memory.recall("alpha")[0] = fixed("mutated");
    expect(memory.recall("alpha")[0]).toEqual(fixed("a"));
  });
});

describe("kept in view state", () => {
  /** A store that counts what a window writes, over the same memory main will answer with. */
  const countingStore = (inner: ViewStateStore = makeMemoryViewStateStore()) => {
    const slotWrites: Array<{ canvas: string; index: number; slot: ViewCommandSlot }> = [];
    const extraWrites: Array<ReadonlyArray<ReadonlyArray<string>>> = [];
    const store: ViewStateStore = {
      ...inner,
      writeSlot: (canvas, index, slot) => {
        slotWrites.push({ canvas, index, slot });
        inner.writeSlot(canvas, index, slot);
      },
      writeExtras: (canvas, extras) => {
        extraWrites.push(extras);
        inner.writeExtras(canvas, extras);
      },
    };
    return { store, slotWrites, extraWrites };
  };

  it("brings a canvas's groups back to a window that never saw them", () => {
    // The proof the operator asked for, short of the quit: one window writes,
    // a window opened after it reads the same store.
    const store = makeMemoryViewStateStore();
    const first = makeCanvasCommandGroups(store);
    first.remember("alpha", board([[0, fixed("a")], [1, group("a", "b")], [2, leased("c")]]));
    first.rememberExtras("alpha", [["d", "e"], ["f"]]);

    const opened = makeCanvasCommandGroups(store);
    expect(opened.recall("alpha")).toEqual(board([[0, fixed("a")], [1, group("a", "b")]]));
    expect(opened.recallExtras("alpha")).toEqual([["d", "e"], ["f"]]);
    expect(opened.recall("beta")).toEqual(emptyHotbarSlots());
    expect(opened.recallExtras("beta")).toEqual([]);
  });

  it("writes only the rows that changed, so a recomputed lease costs nothing", () => {
    const counted = countingStore();
    const memory = makeCanvasCommandGroups(counted.store);
    memory.remember("alpha", board([[0, fixed("a")]]));
    expect(counted.slotWrites.map((write) => write.index)).toEqual([0]);
    counted.slotWrites.length = 0;
    // A lease appears beside it: nothing the operator holds moved.
    memory.remember("alpha", board([[0, fixed("a")], [3, leased("z")]]));
    expect(counted.slotWrites).toEqual([]);
    // The group takes digit 1 too: the row that changed is the one written.
    memory.remember("alpha", board([[0, group("a", "b")], [1, fixed("c")]]));
    expect(counted.slotWrites.map((write) => write.index)).toEqual([0, 1]);
    expect(counted.slotWrites[0]!.slot).toEqual({ kind: "group", nodeIds: ["a", "b"] });
    expect(counted.slotWrites[1]!.slot).toEqual({ kind: "fixed", nodeId: "c" });
  });

  it("never writes a lease, a soft-hold, or a blank canvas", () => {
    const counted = countingStore();
    const memory = makeCanvasCommandGroups(counted.store);
    memory.remember("alpha", board([[0, leased("a")], [1, evicted("b")]]));
    memory.remember("", board([[0, fixed("a")]]));
    memory.rememberExtras("", [["a"]]);
    expect(counted.slotWrites).toEqual([]);
    expect(counted.extraWrites).toEqual([]);
  });

  it("writes the groups past nine as one ordered list, and only when it changes", () => {
    const counted = countingStore();
    const memory = makeCanvasCommandGroups(counted.store);
    memory.rememberExtras("alpha", [["a", "b"], ["c"]]);
    memory.rememberExtras("alpha", [["a", "b"], ["c"]]);
    expect(counted.extraWrites).toHaveLength(1);
    memory.rememberExtras("alpha", [["c"], ["a", "b"]]);
    expect(counted.extraWrites).toHaveLength(2);
    expect(counted.extraWrites[1]).toEqual([["c"], ["a", "b"]]);
    expect(memory.recallExtras("alpha")).toEqual([["c"], ["a", "b"]]);
  });

  it("settles nothing on an echo while a lease is held, so the lease stays where it was", () => {
    const store = makeMemoryViewStateStore();
    const memory = makeCanvasCommandGroups(store);
    memory.remember("alpha", board([[0, fixed("a")]]));
    // The window's live board: the operator row plus a lease the store never saw.
    const live = board([[0, fixed("a")], [4, leased("s")]]);
    expect(memory.settle("alpha", live, [])).toBeNull();

    // Another window's write does settle, and leases are left to recompute.
    makeCanvasCommandGroups(store).remember("alpha", board([[2, group("b", "c")]]));
    expect(memory.settle("alpha", live, [])).toEqual({ slots: board([[2, group("b", "c")]]), extras: [] });
  });

  it("never shows a half-written board: a window's own multi-row write is not announced to it", () => {
    const store = makeMemoryViewStateStore();
    const memory = makeCanvasCommandGroups(store);
    const heard: Array<ReadonlyArray<HotbarSlot>> = [];
    memory.onChange((canvas) => heard.push(memory.recall(canvas)));
    memory.remember("alpha", board([[0, group("a", "b")], [1, fixed("c")], [2, fixed("d")]]));
    // Three rows changed, and none of them was read back as a board of its own.
    expect(heard).toEqual([]);
    const opened = makeCanvasCommandGroups(store);
    expect(opened.recall("alpha")).toEqual(board([[0, group("a", "b")], [1, fixed("c")], [2, fixed("d")]]));
  });

  it("converges a second window from per-row pushes, and that window writes nothing back", () => {
    const counted = countingStore();
    const first = makeCanvasCommandGroups(counted.store);
    const second = makeCanvasCommandGroups(counted.store);
    let seenBySecond: ReadonlyArray<HotbarSlot> = emptyHotbarSlots();
    second.onChange((canvas) => {
      const next = second.settle(canvas, seenBySecond, []);
      if (next) seenBySecond = next.slots;
    });
    counted.slotWrites.length = 0;
    first.remember("alpha", board([[0, group("a", "b")], [1, fixed("c")], [2, fixed("d")]]));
    expect(seenBySecond).toEqual(board([[0, group("a", "b")], [1, fixed("c")], [2, fixed("d")]]));
    // Exactly the three rows the first window wrote: the second wrote none back.
    expect(counted.slotWrites.map((write) => write.index)).toEqual([0, 1, 2]);
  });

  it("hands a push from the store to this window, and drops its own echo", () => {
    const store = makeMemoryViewStateStore();
    const memory = makeCanvasCommandGroups(store);
    const heard: string[] = [];
    const stop = memory.onChange((canvas) => heard.push(canvas));
    // Another window saves a group on this same canvas.
    const other = makeCanvasCommandGroups(store);
    other.remember("alpha", board([[4, group("a", "b")]]));
    expect(heard).toEqual(["alpha"]);
    expect(memory.recall("alpha")).toEqual(board([[4, group("a", "b")]]));
    stop();
    other.remember("alpha", board([[5, fixed("c")]]));
    expect(heard).toEqual(["alpha"]);
  });
});

describe("groups beyond nine", () => {
  const held = (): HotbarSlot[] =>
    emptyHotbarSlots().map((_, index) => fixed(`h${index}`));
  const docIds = ["a", "b", "c", ...Array.from({ length: 9 }, (_, index) => `h${index}`)];

  it("a new group takes the first free slot, even with groups past nine", () => {
    const next = saveSelectionAsNewGroup(board([[0, fixed("h0")]]), [["c"]], ["b", "a"], docIds)!;
    expect(next.slots[1]).toEqual(group("a", "b"));
    expect(next.extras).toEqual([["c"]]);
  });

  it("goes past nine without a key once the operator holds all nine, never twice", () => {
    const first = saveSelectionAsNewGroup(held(), [], ["b", "a"], docIds)!;
    expect(first.slots).toEqual(held());
    expect(first.extras).toEqual([["a", "b"]]);
    const again = saveSelectionAsNewGroup(first.slots, first.extras, ["a", "b"], docIds)!;
    expect(again.extras).toEqual([["a", "b"]]);
    const third = saveSelectionAsNewGroup(again.slots, again.extras, ["c"], docIds)!;
    expect(third.extras).toEqual([["a", "b"], ["c"]]);
  });

  it("a lease or idle hold yields to a new group before it goes past nine", () => {
    const slots = held();
    slots[6] = leased("c");
    const next = saveSelectionAsNewGroup(slots, [], ["a", "b"], docIds)!;
    expect(next.slots[6]).toEqual(group("a", "b"));
    expect(next.extras).toEqual([]);
  });

  it("saves nothing for a selection with no live node", () => {
    expect(saveSelectionAsNewGroup(held(), [], ["gone"], docIds)).toBeNull();
  });

  it("drops deleted members and empty groups, keeping untouched groups as they were", () => {
    const keep = ["a", "b"];
    const pruned = pruneExtraGroups([keep, ["b", "gone"], ["gone"]], ["a", "b"]);
    expect(pruned).toEqual([["a", "b"], ["b"]]);
    expect(pruned[0]).toBe(keep);
  });

  it("promoting takes the slot's key; the operator's group there moves past nine", () => {
    const slots = held();
    slots[2] = group("h2", "h3");
    const next = promoteExtraGroup(slots, [["a", "b"], ["c"]], 0, 2, docIds);
    expect(next.slots[2]).toEqual(group("a", "b"));
    expect(next.extras).toEqual([["h2", "h3"], ["c"]]);
  });

  it("promoting over a lease or empty slot just replaces it", () => {
    const next = promoteExtraGroup(board([[4, leased("h4")]]), [["a", "b"], ["c"]], 1, 4, docIds);
    expect(next.slots[4]).toEqual(fixed("c"));
    expect(next.extras).toEqual([["a", "b"]]);
    const empty = promoteExtraGroup(emptyHotbarSlots(), [["a", "b"]], 0, 8, docIds);
    expect(empty.slots[8]).toEqual(group("a", "b"));
    expect(empty.extras).toEqual([]);
  });
});

describe("jumpCommandGroup", () => {
  const all = (): boolean => true;

  it("opens the first member, then the next while one of them is in front, and wraps", () => {
    const slots = board([[1, group("c", "a", "b")]]);
    expect(jumpCommandGroup(slots, 1, context, all, null)).toBe("a");
    expect(jumpCommandGroup(slots, 1, context, all, "a")).toBe("b");
    expect(jumpCommandGroup(slots, 1, context, all, "b")).toBe("c");
    expect(jumpCommandGroup(slots, 1, context, all, "c")).toBe("a");
  });

  it("starts at the first member when something outside the group is in front", () => {
    expect(jumpCommandGroup(board([[0, group("b", "c")]]), 0, context, all, "d")).toBe("b");
  });

  it("skips members that have nothing to open", () => {
    const slots = board([[0, group("a", "b", "c")]]);
    const opens = (id: string): boolean => id !== "b";
    expect(jumpCommandGroup(slots, 0, context, opens, "a")).toBe("c");
    expect(jumpCommandGroup(slots, 0, context, () => false, null)).toBeNull();
  });

  it("goes to a single node, and stays on it when it is already in front", () => {
    const slots = board([[4, fixed("d")]]);
    expect(jumpCommandGroup(slots, 4, context, all, null)).toBe("d");
    expect(jumpCommandGroup(slots, 4, context, all, "d")).toBe("d");
  });

  it("steps through a region's members in document order", () => {
    const slots = board([[2, fixed("region")]]);
    expect(jumpCommandGroup(slots, 2, context, all, null)).toBe("r1");
    expect(jumpCommandGroup(slots, 2, context, all, "r1")).toBe("r2");
  });

  it("does nothing for an empty slot or members that are gone", () => {
    expect(jumpCommandGroup(board([]), 3, context, all, null)).toBeNull();
    expect(jumpCommandGroup(board([[0, group("gone", "also-gone")]]), 0, context, all, null)).toBeNull();
  });
});
