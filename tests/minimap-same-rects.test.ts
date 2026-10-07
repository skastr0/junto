import { describe, expect, it } from "vitest";
import { sameRects, type MinimapNodeRect } from "../src/renderer/components/FactoryMinimap";

const rect = (id: string, x: number, over: Partial<MinimapNodeRect> = {}): MinimapNodeRect => ({
  id, x, y: 0, width: 216, height: 56, fill: "#123", stroke: "#456", ...over,
});

describe("the minimap publishes its rectangles only when the map changed", () => {
  it("is the same map when every rectangle says what it said", () => {
    const before = [rect("a", 0), rect("b", 300, { seat: { urgency: "blocked" } })];
    const after = [rect("a", 0), rect("b", 300, { seat: { urgency: "blocked" } })];
    expect(sameRects(before, after)).toBe(true);
  });

  it("is a new map when nothing was published yet", () => {
    expect(sameRects(undefined, [rect("a", 0)])).toBe(false);
  });

  it("is a new map when a card moved, resized, changed colour, came or went", () => {
    const before = [rect("a", 0), rect("b", 300)];
    expect(sameRects(before, [rect("a", 0), rect("b", 340)])).toBe(false);
    expect(sameRects(before, [rect("a", 0), rect("b", 300, { width: 240 })])).toBe(false);
    expect(sameRects(before, [rect("a", 0), rect("b", 300, { fill: "#999" })])).toBe(false);
    expect(sameRects(before, [rect("a", 0)])).toBe(false);
    expect(sameRects(before, [rect("a", 0), rect("b", 300), rect("c", 600)])).toBe(false);
    expect(sameRects(before, [rect("b", 300), rect("a", 0)])).toBe(false);
  });

  it("is a new map when a seat's urgency changed, or a card became a seat", () => {
    const before = [rect("a", 0, { seat: { urgency: "needs-you" } })];
    expect(sameRects(before, [rect("a", 0, { seat: { urgency: "blocked" } })])).toBe(false);
    expect(sameRects(before, [rect("a", 0)])).toBe(false);
    expect(sameRects([rect("a", 0)], [rect("a", 0, { seat: {} })])).toBe(false);
  });
});
