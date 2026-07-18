import { describe, expect, it } from "vitest";
import {
  membersInDocumentOrder,
  REGION_RETAP_GAP_MS,
  regionDigitVerdict,
  type RegionRetapMemory,
} from "../src/renderer/lib/region-retap";

describe("regionDigitVerdict", () => {
  it("first press selects the region", () => {
    const { verdict, memory } = regionDigitVerdict(null, 0, 1000, 3);
    expect(verdict).toEqual({ kind: "select-region" });
    expect(memory).toEqual({ slotIndex: 0, atMs: 1000, memberCursor: -1 });
  });

  it("re-tap within gap advances to first member", () => {
    const prev: RegionRetapMemory = { slotIndex: 0, atMs: 1000, memberCursor: -1 };
    const { verdict, memory } = regionDigitVerdict(prev, 0, 1000 + REGION_RETAP_GAP_MS, 3);
    expect(verdict).toEqual({ kind: "select-member", index: 0 });
    expect(memory.memberCursor).toBe(0);
    expect(memory.atMs).toBe(1000 + REGION_RETAP_GAP_MS);
  });

  it("further re-taps within gap cycle members and wrap", () => {
    let mem: RegionRetapMemory | null = null;
    let t = 0;
    // region
    ({ memory: mem } = regionDigitVerdict(mem, 2, t, 3));
    t += 50;
    // m0, m1, m2, m0
    for (const want of [0, 1, 2, 0]) {
      const r = regionDigitVerdict(mem, 2, t, 3);
      expect(r.verdict).toEqual({ kind: "select-member", index: want });
      mem = r.memory;
      t += 50;
    }
  });

  it("gap expiry restarts at region select", () => {
    const prev: RegionRetapMemory = { slotIndex: 1, atMs: 1000, memberCursor: 1 };
    const { verdict, memory } = regionDigitVerdict(
      prev,
      1,
      1000 + REGION_RETAP_GAP_MS + 1,
      4,
    );
    expect(verdict).toEqual({ kind: "select-region" });
    expect(memory.memberCursor).toBe(-1);
  });

  it("different slot always selects region even inside gap", () => {
    const prev: RegionRetapMemory = { slotIndex: 0, atMs: 1000, memberCursor: 0 };
    const { verdict, memory } = regionDigitVerdict(prev, 3, 1050, 2);
    expect(verdict).toEqual({ kind: "select-region" });
    expect(memory.slotIndex).toBe(3);
    expect(memory.memberCursor).toBe(-1);
  });

  it("empty members never cycle (always region)", () => {
    const first = regionDigitVerdict(null, 0, 0, 0);
    expect(first.verdict).toEqual({ kind: "select-region" });
    const second = regionDigitVerdict(first.memory, 0, 50, 0);
    expect(second.verdict).toEqual({ kind: "select-region" });
    expect(second.memory.memberCursor).toBe(-1);
  });

  it("single member re-taps stay on index 0", () => {
    let mem: RegionRetapMemory | null = null;
    ({ memory: mem } = regionDigitVerdict(mem, 0, 0, 1));
    const a = regionDigitVerdict(mem, 0, 40, 1);
    expect(a.verdict).toEqual({ kind: "select-member", index: 0 });
    const b = regionDigitVerdict(a.memory, 0, 80, 1);
    expect(b.verdict).toEqual({ kind: "select-member", index: 0 });
  });

  it("accepts a custom gap", () => {
    const prev: RegionRetapMemory = { slotIndex: 0, atMs: 0, memberCursor: -1 };
    expect(regionDigitVerdict(prev, 0, 300, 2, 500).verdict.kind).toBe("select-member");
    expect(regionDigitVerdict(prev, 0, 501, 2, 500).verdict.kind).toBe("select-region");
  });
});

describe("membersInDocumentOrder", () => {
  it("filters to members and preserves document order", () => {
    expect(membersInDocumentOrder(["c", "a", "z"], ["a", "b", "c", "d"])).toEqual(["a", "c"]);
  });

  it("drops ids not in the document list", () => {
    expect(membersInDocumentOrder(["x", "a"], ["a", "b"])).toEqual(["a"]);
  });

  it("empty either side yields empty", () => {
    expect(membersInDocumentOrder([], ["a"])).toEqual([]);
    expect(membersInDocumentOrder(["a"], [])).toEqual([]);
  });
});
