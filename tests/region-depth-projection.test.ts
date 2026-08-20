import { describe, expect, it } from "vitest";
import type { CanvasDoc, CanvasNode, GroupNode } from "../src/shared/canvas";
import { createFlowIdentityCache, toFlow } from "../src/renderer/lib/convert";

// Region nesting depth is projected once per toFlow and carried on node data,
// so GroupNode reads its MAX_REGION_DEPTH warning off props instead of the doc.

const emptyContext = {
  canvasName: "test",
  resolveActorRef: () => undefined,
};

const region = (
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
): GroupNode => ({ id, type: "group", label: id, x, y, width, height });

const card = (id: string, x: number, y: number): CanvasNode => ({
  id,
  type: "text",
  text: id,
  x,
  y,
  width: 40,
  height: 40,
});

const depthOf = (doc: CanvasDoc, id: string): number | undefined =>
  toFlow(doc, emptyContext).nodes.find((n) => n.id === id)?.data.regionDepth;

describe("region depth projection", () => {
  it("stacks nested regions by containment and leaves furniture undepthed", () => {
    const doc: CanvasDoc = {
      nodes: [
        region("outer", 0, 0, 600, 600),
        region("mid", 50, 50, 400, 400),
        region("inner", 100, 100, 200, 200),
        card("n", 120, 120),
      ],
      edges: [],
    };

    expect(depthOf(doc, "outer")).toBe(0);
    expect(depthOf(doc, "mid")).toBe(1);
    expect(depthOf(doc, "inner")).toBe(2);
    expect(depthOf(doc, "n")).toBeUndefined();
  });

  it("counts every container, overlapping regions included", () => {
    const doc: CanvasDoc = {
      nodes: [
        region("a", 0, 0, 600, 600),
        region("b", 0, 0, 500, 700),
        region("inner", 100, 100, 200, 200),
      ],
      edges: [],
    };

    expect(depthOf(doc, "inner")).toBe(2);
    expect(depthOf(doc, "a")).toBe(0);
    expect(depthOf(doc, "b")).toBe(0);
  });

  it("paints deeper regions above shallower ones, all below edges and furniture", () => {
    const doc: CanvasDoc = {
      nodes: [
        region("outer", 0, 0, 600, 600),
        region("inner", 100, 100, 200, 200),
        card("n", 700, 700),
      ],
      edges: [],
    };
    const byId = new Map(toFlow(doc, emptyContext).nodes.map((n) => [n.id, n]));

    const outer = byId.get("outer")?.zIndex ?? -1;
    const inner = byId.get("inner")?.zIndex ?? -1;
    const furniture = byId.get("n")?.zIndex ?? -1;
    expect(inner).toBeGreaterThan(outer);
    expect(furniture).toBeGreaterThan(inner);
  });

  it("re-mints a region whose depth changed under an unchanged node object", () => {
    const outer = region("outer", 0, 0, 200, 200);
    const sibling = region("sibling", 400, 400, 200, 200);
    const cache = createFlowIdentityCache();

    const before = toFlow({ nodes: [outer, sibling], edges: [] }, emptyContext, null, cache);
    expect(before.nodes.find((n) => n.id === "sibling")?.data.regionDepth).toBe(0);

    // Only `outer` is resized — `sibling` is the very same object, now nested.
    const grown = { ...outer, width: 800, height: 800 };
    const after = toFlow({ nodes: [grown, sibling], edges: [] }, emptyContext, null, cache);
    const projected = after.nodes.find((n) => n.id === "sibling");

    expect(projected?.data.node).toBe(sibling);
    expect(projected?.data.regionDepth).toBe(1);
    expect(projected).not.toBe(before.nodes.find((n) => n.id === "sibling"));
  });
});
