import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  HotbarSlot,
  HotbarSlots,
  applyHotbarLeases,
  assignFixedSlot,
  clearHotbarNode,
  emptyHotbarSlots,
  fixedOrderOf,
  hotbarSlotsFromLegacyOrder,
  nodeIdAt,
  pruneHotbarSlots,
  resolveHotbarSlots,
  slotIndexOf,
  touchActiveMru,
} from "../src/renderer/lib/hotbar-slots";

describe("HotbarSlot schema", () => {
  it("decodes empty, fixed, and leased brands", () => {
    const decode = Schema.decodeUnknownSync(HotbarSlot);
    expect(decode({ kind: "empty" })).toEqual({ kind: "empty" });
    expect(decode({ kind: "fixed", nodeId: "n1" })).toEqual({
      kind: "fixed",
      nodeId: "n1",
    });
    expect(decode({ kind: "leased", nodeId: "n2" })).toEqual({
      kind: "leased",
      nodeId: "n2",
    });
  });

  it("requires exactly 9 slots", () => {
    const decode = Schema.decodeUnknownSync(HotbarSlots);
    expect(decode(emptyHotbarSlots())).toHaveLength(9);
    expect(() => decode([{ kind: "empty" }])).toThrow();
  });
});

describe("assignFixedSlot", () => {
  it("fixes a node at an index and clears it elsewhere", () => {
    let slots = emptyHotbarSlots();
    slots = assignFixedSlot(slots, "a", 0);
    slots = assignFixedSlot(slots, "b", 2);
    slots = assignFixedSlot(slots, "a", 4);
    expect(nodeIdAt(slots, 0)).toBeUndefined();
    expect(nodeIdAt(slots, 2)).toBe("b");
    expect(nodeIdAt(slots, 4)).toBe("a");
    expect(slots[4]?.kind).toBe("fixed");
  });
});

describe("applyHotbarLeases", () => {
  it("leases empty slots to recent active nodes without touching fixed", () => {
    let slots = emptyHotbarSlots();
    slots = assignFixedSlot(slots, "fixed-1", 0);
    const next = applyHotbarLeases(
      slots,
      ["active-new", "fixed-1", "active-old"],
      ["fixed-1", "active-new", "active-old", "ghost"],
    );
    expect(next[0]).toEqual({ kind: "fixed", nodeId: "fixed-1" });
    // Most recent active first into next empty indices
    expect(next[1]).toEqual({ kind: "leased", nodeId: "active-new" });
    expect(next[2]).toEqual({ kind: "leased", nodeId: "active-old" });
    expect(next[3]?.kind).toBe("empty");
    // fixed-1 not double-leased
    expect(next.filter((s) => s.kind !== "empty" && s.nodeId === "fixed-1")).toHaveLength(1);
  });

  it("preserves lease slot indices when MRU reorders (no reshuffle on focus)", () => {
    let slots = emptyHotbarSlots();
    slots = applyHotbarLeases(slots, ["a", "b", "c"], ["a", "b", "c"]);
    expect(slots.slice(0, 3).map((s) => (s.kind === "empty" ? null : s.nodeId))).toEqual([
      "a",
      "b",
      "c",
    ]);
    // Focus hops reorder MRU to c, a, b — slots must stay put.
    const next = applyHotbarLeases(slots, ["c", "a", "b"], ["a", "b", "c"]);
    expect(next.slice(0, 3).map((s) => (s.kind === "empty" ? null : s.nodeId))).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("keeps lease at same index when sticky working, even if dropped from MRU", () => {
    let slots = emptyHotbarSlots();
    slots = applyHotbarLeases(slots, ["a", "b"], ["a", "b"]);
    expect(slots[0]).toEqual({ kind: "leased", nodeId: "a" });
    const next = applyHotbarLeases(slots, ["b"], ["a", "b"], ["a"]);
    // a sticky at 0; b still at 1 — not compacted to front
    expect(next[0]).toEqual({ kind: "leased", nodeId: "a" });
    expect(next[1]).toEqual({ kind: "leased", nodeId: "b" });
  });

  it("frees non-sticky leases that leave the active set without compacting others", () => {
    let slots = emptyHotbarSlots();
    slots = applyHotbarLeases(slots, ["a", "b"], ["a", "b"]);
    expect(slots[0]?.kind).toBe("leased");
    const next = applyHotbarLeases(slots, ["b"], ["a", "b"]);
    // a not sticky + not MRU → free; b keeps index 1 (no reshuffle into 0)
    expect(next.map((s) => (s.kind === "empty" ? null : s.nodeId))).toEqual([
      null,
      "b",
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  it("fills empty slots sticky-first then MRU", () => {
    const slots = emptyHotbarSlots();
    const next = applyHotbarLeases(
      slots,
      ["mru-only"],
      ["sticky-w", "mru-only", "other"],
      ["sticky-w"],
    );
    expect(next[0]).toEqual({ kind: "leased", nodeId: "sticky-w" });
    expect(next[1]).toEqual({ kind: "leased", nodeId: "mru-only" });
  });

  it("leaves all empty when there is no activity", () => {
    const slots = assignFixedSlot(emptyHotbarSlots(), "only-fixed", 1);
    const next = applyHotbarLeases(slots, [], ["only-fixed", "x"]);
    expect(next[1]).toEqual({ kind: "fixed", nodeId: "only-fixed" });
    expect(next.filter((s) => s.kind === "leased")).toHaveLength(0);
  });
});

describe("resolveHotbarSlots", () => {
  it("prunes dead fixed nodes then leases", () => {
    let slots = assignFixedSlot(emptyHotbarSlots(), "gone", 0);
    slots = resolveHotbarSlots(slots, ["alive"], ["alive"]);
    expect(slots[0]).toEqual({ kind: "leased", nodeId: "alive" });
  });
});

describe("legacy + MRU helpers", () => {
  it("migrates dense order into leading fixed slots", () => {
    const slots = hotbarSlotsFromLegacyOrder(["a", "b"]);
    expect(fixedOrderOf(slots)).toEqual(["a", "b"]);
    expect(slots[0]?.kind).toBe("fixed");
    expect(slots[8]?.kind).toBe("empty");
  });

  it("touchActiveMru moves node to front", () => {
    expect(touchActiveMru(["a", "b"], "b")).toEqual(["b", "a"]);
    expect(touchActiveMru(["a", "b"], "c").slice(0, 3)).toEqual(["c", "a", "b"]);
  });

  it("slotIndexOf prefers fixed", () => {
    const slots = assignFixedSlot(emptyHotbarSlots(), "n", 3);
    expect(slotIndexOf(slots, "n")).toBe(3);
    expect(slotIndexOf(pruneHotbarSlots(slots, []), "n")).toBeNull();
  });

  it("clearHotbarNode empties every appearance", () => {
    const slots = clearHotbarNode(
      assignFixedSlot(emptyHotbarSlots(), "x", 2),
      "x",
    );
    expect(slotIndexOf(slots, "x")).toBeNull();
  });
});
