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
  commandGroupKey,
  currentSelectionIds,
  firstFreeSlotIndex,
  groupLabel,
  makeCanvasCommandGroups,
  operatorHeldSlots,
  recallCommandGroup,
  saveSelectionToSlot,
  selectionIsGroup,
  slotContentKey,
  slotIndexForKey,
  summarizeSlots,
  swapHotbarSlots,
  type CommandGroupKeyEvent,
  type CommandGroupRetap,
  type RecallContext,
} from "../src/renderer/lib/command-groups";
import { REGION_RETAP_GAP_MS } from "../src/renderer/lib/region-retap";

const board = (entries: ReadonlyArray<readonly [number, HotbarSlot]>): HotbarSlot[] => {
  const slots = emptyHotbarSlots();
  for (const [index, slot] of entries) slots[index] = slot;
  return slots;
};
const fixed = (nodeId: string): HotbarSlot => ({ kind: "fixed", nodeId });
const leased = (nodeId: string): HotbarSlot => ({ kind: "leased", nodeId });
const evicted = (nodeId: string): HotbarSlot => ({ kind: "evicted", nodeId });
const group = (...nodeIds: string[]): HotbarSlot => ({ kind: "group", nodeIds });

const key = (partial: Partial<CommandGroupKeyEvent>): CommandGroupKeyEvent => ({
  key: "1",
  code: "Digit1",
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  repeat: false,
  ...partial,
});

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

describe("commandGroupKey", () => {
  it("saves with ⌘ on mac and Ctrl elsewhere", () => {
    expect(commandGroupKey(key({ metaKey: true }), true)).toEqual({ kind: "save", slotIndex: 0 });
    expect(commandGroupKey(key({ ctrlKey: true }), false)).toEqual({ kind: "save", slotIndex: 0 });
  });

  it("ignores the other platform's modifier", () => {
    expect(commandGroupKey(key({ ctrlKey: true }), true)).toBeNull();
    expect(commandGroupKey(key({ metaKey: true }), false)).toBeNull();
    expect(commandGroupKey(key({ metaKey: true, ctrlKey: true }), true)).toBeNull();
  });

  it("recalls on a bare digit", () => {
    expect(commandGroupKey(key({ key: "7", code: "Digit7" }), true)).toEqual({
      kind: "recall",
      slotIndex: 6,
    });
  });

  it("never acts on alt, shift, or auto-repeat", () => {
    expect(commandGroupKey(key({ altKey: true }), true)).toBeNull();
    expect(commandGroupKey(key({ shiftKey: true }), true)).toBeNull();
    expect(commandGroupKey(key({ repeat: true }), true)).toBeNull();
    expect(commandGroupKey(key({ repeat: true, metaKey: true }), true)).toBeNull();
  });

  it("reads the physical digit row, so non-US layouts reach the slots", () => {
    // AZERTY: the unshifted Digit1 key types "&".
    expect(slotIndexForKey({ key: "&", code: "Digit1" })).toBe(0);
    expect(slotIndexForKey({ key: "9", code: "Numpad9" })).toBe(8);
    // A letter on a digit-typing layout is still not a slot.
    expect(slotIndexForKey({ key: "1", code: "KeyQ" })).toBeNull();
  });

  it("falls back to the character when there is no code", () => {
    expect(slotIndexForKey({ key: "3", code: "" })).toBe(2);
    expect(slotIndexForKey({ key: "3" })).toBe(2);
    expect(slotIndexForKey({ key: "0" })).toBeNull();
    expect(slotIndexForKey({ key: "a" })).toBeNull();
  });

  it("zero and non-digit keys are not ours", () => {
    expect(commandGroupKey(key({ key: "0", code: "Digit0" }), true)).toBeNull();
    expect(commandGroupKey(key({ key: "k", code: "KeyK", metaKey: true }), true)).toBeNull();
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
