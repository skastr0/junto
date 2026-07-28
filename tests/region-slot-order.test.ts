import { describe, expect, it } from "vitest";
import { assignSlot, mergeSlotOrder } from "../src/renderer/lib/region-rollups";
import { deriveRegionRollups as deriveRegionRollupsWithContext } from "../src/shared/region-rollup";
import type { CanvasDoc } from "../src/shared/canvas";
import { executionContextForDoc } from "./helpers/actor-ref-fixtures";

const deriveRegionRollups = (doc: CanvasDoc) => {
  const context = executionContextForDoc(doc);
  return deriveRegionRollupsWithContext({
    doc,
    canvasName: context.canvasName,
    resolveActorRef: context.resolveActorRef,
  });
};

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

  it("empty live list yields empty order (caller must fall back to cold rollups)", () => {
    expect(mergeSlotOrder(["a", "b"], [])).toEqual([]);
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

describe("cold rollup shell", () => {
  it("deriveRegionRollups without activity inputs still lists every group", () => {
    const doc: CanvasDoc = {
      nodes: [
        { id: "r1", type: "group", label: "Tower", x: 0, y: 0, width: 200, height: 200 },
        { id: "r2", type: "group", label: "Booth", x: 300, y: 0, width: 200, height: 200 },
        { id: "n1", type: "text", text: "note", x: 10, y: 10, width: 80, height: 40 },
      ],
      edges: [],
    };
    const rollups = deriveRegionRollups(doc);
    expect(rollups.map((r) => r.label)).toEqual(["Tower", "Booth"]);
    expect(rollups.every((r) => r.severity === "idle")).toBe(true);
  });
});
