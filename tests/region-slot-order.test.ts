import { describe, expect, it } from "vitest";
import {
  assignSlot,
  fuseRegionRollups,
  mergeSlotOrder,
  pruneSlotOrder,
} from "../src/renderer/lib/region-rollups";
import {
  deriveRegionRollups as deriveRegionRollupsWithContext,
  type RegionRollup,
} from "../src/shared/region-rollup";
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

describe("pruneSlotOrder", () => {
  it("keeps assigned order and never auto-appends live ids", () => {
    expect(pruneSlotOrder(["b", "a"], ["a", "b", "c"])).toEqual(["b", "a"]);
  });

  it("drops gone nodes", () => {
    expect(pruneSlotOrder(["a", "gone", "b"], ["b", "a"])).toEqual(["a", "b"]);
  });

  it("caps at 9", () => {
    const order = Array.from({ length: 12 }, (_, i) => `n${i}`);
    const live = order;
    expect(pruneSlotOrder(order, live)).toHaveLength(9);
  });

  it("empty assignment stays empty even when live nodes exist", () => {
    expect(pruneSlotOrder([], ["a", "b", "c"])).toEqual([]);
  });

  it("empty live list clears order", () => {
    expect(pruneSlotOrder(["a", "b"], [])).toEqual([]);
  });
});

describe("mergeSlotOrder (alias of prune)", () => {
  it("does not append — controlled hotbar", () => {
    expect(mergeSlotOrder(["b", "a"], ["a", "b", "c"])).toEqual(["b", "a"]);
  });
});

describe("assignSlot", () => {
  it("places any node into the requested slot", () => {
    expect(assignSlot(["a", "b", "c"], "x", 1)).toEqual(["a", "x", "b", "c"]);
  });

  it("moves an existing node without duplicating", () => {
    expect(assignSlot(["a", "b", "c"], "c", 0)).toEqual(["c", "a", "b"]);
  });
});

describe("fuseRegionRollups", () => {
  const rollup = (
    severity: "attention" | "idle",
    reason?: string,
  ): RegionRollup => ({
    regionId: "r1",
    label: "Region",
    severity,
    counts: {
      total: 1,
      blocked: 0,
      attention: severity === "attention" ? 1 : 0,
      working: 0,
    },
    members: [{
      nodeId: "actor",
      label: "Actor",
      kind: "agent",
      severity,
      reasons: reason ? [reason] : [],
    }],
  });

  it("does not preserve cached activity after a generation is gone", () => {
    const fused = fuseRegionRollups(
      [rollup("idle")],
      [rollup("attention", "activity:attention")],
      new Set(["actor"]),
    );
    expect(fused[0]).toMatchObject({
      severity: "idle",
      counts: { attention: 0 },
    });
    expect(fused[0]?.members[0]).toMatchObject({
      nodeId: "actor",
      severity: "idle",
    });
  });

  it("still keeps worse live evidence for seats without a tombstone", () => {
    expect(
      fuseRegionRollups(
        [rollup("idle")],
        [rollup("attention", "permission:pending")],
      )[0]?.severity,
    ).toBe("attention");
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
