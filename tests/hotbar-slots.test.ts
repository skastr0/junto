import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  HotbarSlot,
  HotbarSlots,
  applyHotbarLeases,
  assignFixedSlot,
  clearHotbarNode,
  emptyHotbarSlots,
  filterLeaseCandidateIds,
  fixedOrderOf,
  hotbarSlotsFromLegacyOrder,
  isFillableSlot,
  nodeIdAt,
  pruneHotbarSlots,
  purgeNonEligibleSoftSlots,
  resolveHotbarSlots,
  slotIndexOf,
  touchActiveMru,
} from "../src/renderer/lib/hotbar-slots";

describe("HotbarSlot schema", () => {
  it("decodes empty, fixed, leased, and evicted brands", () => {
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
    expect(decode({ kind: "evicted", nodeId: "n3" })).toEqual({
      kind: "evicted",
      nodeId: "n3",
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
  it("leases empty slots to sticky actors without touching fixed", () => {
    let slots = emptyHotbarSlots();
    slots = assignFixedSlot(slots, "fixed-1", 0);
    const next = applyHotbarLeases(
      slots,
      ["active-new", "fixed-1", "active-old"],
      ["fixed-1", "active-new", "active-old", "ghost"],
      ["active-new", "active-old"],
    );
    expect(next[0]).toEqual({ kind: "fixed", nodeId: "fixed-1" });
    // Most recent sticky (MRU order) first into next empty indices
    expect(next[1]).toEqual({ kind: "leased", nodeId: "active-new" });
    expect(next[2]).toEqual({ kind: "leased", nodeId: "active-old" });
    expect(next[3]?.kind).toBe("empty");
    // fixed-1 not double-leased
    expect(next.filter((s) => s.kind !== "empty" && s.nodeId === "fixed-1")).toHaveLength(1);
  });

  it("preserves lease slot indices when MRU reorders (no reshuffle on focus)", () => {
    let slots = emptyHotbarSlots();
    slots = applyHotbarLeases(slots, ["a", "b", "c"], ["a", "b", "c"], ["a", "b", "c"]);
    expect(slots.slice(0, 3).map((s) => (s.kind === "empty" ? null : s.nodeId))).toEqual([
      "a",
      "b",
      "c",
    ]);
    // Focus hops reorder MRU to c, a, b — sticky still holds; slots stay put.
    const next = applyHotbarLeases(slots, ["c", "a", "b"], ["a", "b", "c"], ["a", "b", "c"]);
    expect(next.slice(0, 3).map((s) => (s.kind === "empty" ? null : s.nodeId))).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("keeps lease at same index when sticky working, even if dropped from MRU", () => {
    let slots = emptyHotbarSlots();
    slots = applyHotbarLeases(slots, ["a", "b"], ["a", "b"], ["a", "b"]);
    expect(slots[0]).toEqual({ kind: "leased", nodeId: "a" });
    const next = applyHotbarLeases(slots, ["b"], ["a", "b"], ["a", "b"]);
    // a sticky at 0; b still at 1 — not compacted to front
    expect(next[0]).toEqual({ kind: "leased", nodeId: "a" });
    expect(next[1]).toEqual({ kind: "leased", nodeId: "b" });
  });

  it("demotes non-sticky leases to evicted even if they remain in MRU", () => {
    let slots = emptyHotbarSlots();
    slots = applyHotbarLeases(slots, ["a", "b"], ["a", "b"], ["a", "b"]);
    expect(slots[0]?.kind).toBe("leased");
    // a leaves sticky (idle) but still appears first in focus MRU — must soft-hold.
    // b stays sticky → hard lease.
    const next = applyHotbarLeases(slots, ["a", "b"], ["a", "b"], ["b"]);
    expect(next.map((s) => (s.kind === "empty" ? null : `${s.kind}:${s.nodeId}`))).toEqual([
      "evicted:a",
      "leased:b",
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
    expect(isFillableSlot(next[0]!)).toBe(true);
    expect(isFillableSlot(next[1]!)).toBe(false);
  });

  it("keeps three working agents visible as evicted after they all go idle", () => {
    let slots = emptyHotbarSlots();
    slots = applyHotbarLeases(slots, ["a", "b", "c"], ["a", "b", "c"], ["a", "b", "c"]);
    const next = applyHotbarLeases(slots, ["a", "b", "c"], ["a", "b", "c"], []);
    expect(next.slice(0, 3)).toEqual([
      { kind: "evicted", nodeId: "a" },
      { kind: "evicted", nodeId: "b" },
      { kind: "evicted", nodeId: "c" },
    ]);
  });

  it("new sticky fills empty before displacing evicted", () => {
    let slots = emptyHotbarSlots();
    slots = applyHotbarLeases(slots, ["a"], ["a", "b", "c"], ["a"]);
    slots = applyHotbarLeases(slots, ["a"], ["a", "b", "c"], []);
    expect(slots[0]).toEqual({ kind: "evicted", nodeId: "a" });
    // empty slots exist — new sticky takes first empty (index 1), not a's slot
    const next = applyHotbarLeases(slots, ["b"], ["a", "b", "c"], ["b"]);
    expect(next[0]).toEqual({ kind: "evicted", nodeId: "a" });
    expect(next[1]).toEqual({ kind: "leased", nodeId: "b" });
  });

  it("displaces oldest evicted first when no empty slots remain", () => {
    // Fill all 9 sticky, then idle → all evicted; new sticky takes oldest lease (slot 0)
    const nine = ["a", "b", "c", "d", "e", "f", "g", "h", "i"];
    let slots = emptyHotbarSlots();
    slots = applyHotbarLeases(slots, nine, nine, nine);
    expect(slots.every((s) => s.kind === "leased")).toBe(true);
    slots = applyHotbarLeases(slots, nine, nine, []);
    expect(slots.every((s) => s.kind === "evicted")).toBe(true);
    const next = applyHotbarLeases(slots, ["new"], [...nine, "new"], ["new"]);
    expect(next[0]).toEqual({ kind: "leased", nodeId: "new" });
    // remaining stay soft-held
    expect(next[1]).toEqual({ kind: "evicted", nodeId: "b" });
    expect(next[8]).toEqual({ kind: "evicted", nodeId: "i" });
  });

  it("idle MRU-held soft-holds make way for newly sticky actors (oldest first)", () => {
    // Regression: historical focus alone used to keep hard leases and block newcomers.
    const idle = ["a", "b", "c", "d", "e", "f", "g", "h", "i"];
    let slots = emptyHotbarSlots();
    slots = applyHotbarLeases(slots, idle, idle, idle);
    // All go idle but stay in MRU — must demote to fillable soft-holds.
    slots = applyHotbarLeases(slots, idle, idle, []);
    expect(slots.every((s) => s.kind === "evicted")).toBe(true);
    // Two new working actors without prior lease — take oldest two holds (0, 1).
    const next = applyHotbarLeases(
      slots,
      ["new-2", "new-1", ...idle],
      [...idle, "new-1", "new-2"],
      ["new-1", "new-2"],
    );
    expect(next[0]).toEqual({ kind: "leased", nodeId: "new-2" }); // MRU-newer sticky first
    expect(next[1]).toEqual({ kind: "leased", nodeId: "new-1" });
    expect(next[2]).toEqual({ kind: "evicted", nodeId: "c" });
  });

  it("promotes an evicted node back to leased when it becomes sticky again", () => {
    let slots = emptyHotbarSlots();
    slots = applyHotbarLeases(slots, ["a", "b"], ["a", "b"], ["a", "b"]);
    slots = applyHotbarLeases(slots, ["a", "b"], ["a", "b"], []);
    expect(slots[0]).toEqual({ kind: "evicted", nodeId: "a" });
    const next = applyHotbarLeases(slots, ["a"], ["a", "b"], ["a"]);
    expect(next[0]).toEqual({ kind: "leased", nodeId: "a" });
    expect(next[1]).toEqual({ kind: "evicted", nodeId: "b" });
  });

  it("fills empty slots only for sticky actors (MRU alone is not enough)", () => {
    const slots = emptyHotbarSlots();
    const next = applyHotbarLeases(
      slots,
      ["mru-only", "sticky-w"],
      ["sticky-w", "mru-only", "other"],
      ["sticky-w"],
    );
    expect(next[0]).toEqual({ kind: "leased", nodeId: "sticky-w" });
    // mru-only is not sticky → no hard lease
    expect(next.filter((s) => s.kind === "leased")).toEqual([
      { kind: "leased", nodeId: "sticky-w" },
    ]);
  });

  it("leaves fixed-only board without leases when there is no activity", () => {
    const slots = assignFixedSlot(emptyHotbarSlots(), "only-fixed", 1);
    const next = applyHotbarLeases(slots, [], ["only-fixed", "x"]);
    expect(next[1]).toEqual({ kind: "fixed", nodeId: "only-fixed" });
    expect(next.filter((s) => s.kind === "leased" || s.kind === "evicted")).toHaveLength(0);
  });
});

describe("resolveHotbarSlots", () => {
  it("prunes dead fixed nodes then leases sticky", () => {
    let slots = assignFixedSlot(emptyHotbarSlots(), "gone", 0);
    slots = resolveHotbarSlots(slots, ["alive"], ["alive"], ["alive"]);
    expect(slots[0]).toEqual({ kind: "leased", nodeId: "alive" });
  });

  it("prunes dead evicted nodes to empty", () => {
    let slots = emptyHotbarSlots();
    slots = applyHotbarLeases(slots, ["a"], ["a"], ["a"]);
    slots = applyHotbarLeases(slots, ["a"], ["a"], []);
    expect(slots[0]?.kind).toBe("evicted");
    const next = resolveHotbarSlots(slots, [], []);
    expect(next[0]).toEqual({ kind: "empty" });
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

  it("filterLeaseCandidateIds keeps only actors", () => {
    const actors = new Set(["agent-1", "agent-2"]);
    expect(filterLeaseCandidateIds(["note", "agent-1", "task", "agent-2"], actors)).toEqual([
      "agent-1",
      "agent-2",
    ]);
  });

  it("purgeNonEligibleSoftSlots drops non-actor leased/evicted but keeps fixed", () => {
    let slots = emptyHotbarSlots();
    slots = applyHotbarLeases(slots, ["agent", "note"], ["agent", "note"], ["agent", "note"]);
    slots = assignFixedSlot(slots, "task-fixed", 5);
    const next = purgeNonEligibleSoftSlots(slots, new Set(["agent"]));
    expect(next[0]).toEqual({ kind: "leased", nodeId: "agent" });
    // note was leased at index 1 — not an actor → empty
    expect(next[1]).toEqual({ kind: "empty" });
    expect(next[5]).toEqual({ kind: "fixed", nodeId: "task-fixed" });
  });

  it("non-actor sticky ids never receive leases when filtered at the call site", () => {
    const actors = new Set(["agent-a"]);
    const mru = filterLeaseCandidateIds(["note", "task", "agent-a", "region"], actors);
    const sticky = filterLeaseCandidateIds(["agent-a", "working-note"], actors);
    const next = applyHotbarLeases(
      emptyHotbarSlots(),
      mru,
      ["note", "task", "agent-a", "region"],
      sticky,
    );
    expect(next.filter((s) => s.kind === "leased")).toEqual([
      { kind: "leased", nodeId: "agent-a" },
    ]);
  });

  it("slotIndexOf prefers fixed then leased then evicted", () => {
    const slots = assignFixedSlot(emptyHotbarSlots(), "n", 3);
    expect(slotIndexOf(slots, "n")).toBe(3);
    expect(slotIndexOf(pruneHotbarSlots(slots, []), "n")).toBeNull();
    let soft = emptyHotbarSlots();
    soft = applyHotbarLeases(soft, ["e"], ["e"], ["e"]);
    soft = applyHotbarLeases(soft, ["e"], ["e"], []);
    expect(slotIndexOf(soft, "e")).toBe(0);
    expect(soft[0]?.kind).toBe("evicted");
  });

  it("clearHotbarNode empties every appearance", () => {
    const slots = clearHotbarNode(
      assignFixedSlot(emptyHotbarSlots(), "x", 2),
      "x",
    );
    expect(slotIndexOf(slots, "x")).toBeNull();
  });
});
