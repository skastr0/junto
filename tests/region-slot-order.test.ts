import { describe, expect, it } from "vitest";
import { assignSlot, mergeSlotOrder } from "../src/renderer/lib/region-rollups";

describe("mergeSlotOrder", () => {
  it("keeps presentational order and appends new regions", () => {
    expect(mergeSlotOrder(["b", "a"], ["a", "b", "c"])).toEqual(["b", "a", "c"]);
  });

  it("drops gone regions", () => {
    expect(mergeSlotOrder(["a", "gone", "b"], ["b", "a"])).toEqual(["a", "b"]);
  });

  it("caps at 9", () => {
    const live = Array.from({ length: 12 }, (_, i) => `r${i}`);
    expect(mergeSlotOrder([], live)).toHaveLength(9);
  });
});

describe("assignSlot", () => {
  it("places a region into the requested slot", () => {
    expect(assignSlot(["a", "b", "c"], "x", 1)).toEqual(["a", "x", "b", "c"]);
  });

  it("moves an existing region without duplicating", () => {
    expect(assignSlot(["a", "b", "c"], "c", 0)).toEqual(["c", "a", "b"]);
  });
});
