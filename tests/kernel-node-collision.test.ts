import { describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import { buildNodeCanvasIndex } from "../src/main/vellum/kernel/service";

// forge-review sdk-kernel-build fix 4 — a colliding node id must never route
// a flag write to the wrong canvas.

describe("buildNodeCanvasIndex", () => {
  const doc = (nodeIds: ReadonlyArray<string>): CanvasDoc =>
    ({
      nodes: nodeIds.map((id) => ({ id, type: "text", text: id, x: 0, y: 0, width: 100, height: 40 })),
      edges: [],
    }) as unknown as CanvasDoc;

  it("indexes every node to its one owning canvas when ids are unique", () => {
    const docs = new Map([
      ["canvas-a", doc(["n1", "n2"])],
      ["canvas-b", doc(["n3"])],
    ]);
    const { index, collisions } = buildNodeCanvasIndex(docs);
    expect(index.get("n1")).toBe("canvas-a");
    expect(index.get("n2")).toBe("canvas-a");
    expect(index.get("n3")).toBe("canvas-b");
    expect(collisions).toEqual([]);
  });

  it("a node id shared by two canvases is excluded from the index entirely — never routed to either", () => {
    const docs = new Map([
      ["canvas-a", doc(["shared", "only-a"])],
      ["canvas-b", doc(["shared", "only-b"])],
    ]);
    const { index, collisions } = buildNodeCanvasIndex(docs);
    expect(index.has("shared")).toBe(false);
    expect(index.get("only-a")).toBe("canvas-a");
    expect(index.get("only-b")).toBe("canvas-b");
    expect(collisions).toEqual([{ nodeId: "shared", canvases: ["canvas-a", "canvas-b"] }]);
  });

  it("a collision across three canvases is reported once with every owning canvas named", () => {
    const docs = new Map([
      ["canvas-a", doc(["dup"])],
      ["canvas-b", doc(["dup"])],
      ["canvas-c", doc(["dup"])],
    ]);
    const { index, collisions } = buildNodeCanvasIndex(docs);
    expect(index.has("dup")).toBe(false);
    expect(collisions).toEqual([{ nodeId: "dup", canvases: ["canvas-a", "canvas-b", "canvas-c"] }]);
  });

  it("an empty doc set produces an empty index and no collisions", () => {
    const { index, collisions } = buildNodeCanvasIndex(new Map());
    expect(index.size).toBe(0);
    expect(collisions).toEqual([]);
  });
});
