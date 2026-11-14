import { describe, expect, it } from "vitest";
import { focusOrder, stepFocus, type FocusCard } from "../src/window/lib/canvas-focus-order";

const card = (id: string, x: number, y: number, kind = "agent"): FocusCard => ({ id, x, y, kind });

describe("the canvas keyboard focus order", () => {
  it("reads the board top to bottom, then left to right", () => {
    const nodes = [
      card("c", 0, 400),
      card("b", 300, 0),
      card("a", 0, 0),
      card("d", -300, 0),
    ];
    expect(focusOrder(nodes)).toEqual(["d", "a", "b", "c"]);
  });

  it("leaves regions out: they paint no keyboard focus ring", () => {
    const nodes = [card("seat", 0, 0), card("region", -100, -100, "region")];
    expect(focusOrder(nodes)).toEqual(["seat"]);
  });

  it("breaks a tie by id, so the walk is one order", () => {
    expect(focusOrder([card("b", 0, 0), card("a", 0, 0)])).toEqual(["a", "b"]);
  });

  it("wraps forward from the last card and back from the first", () => {
    const order = ["a", "b", "c"];
    expect(stepFocus(order, "c", 1)).toBe("a");
    expect(stepFocus(order, "a", -1)).toBe("c");
  });

  it("starts at the ends when no card holds the ring", () => {
    const order = ["a", "b", "c"];
    expect(stepFocus(order, "", 1)).toBe("a");
    expect(stepFocus(order, "", -1)).toBe("c");
  });

  it("starts at an end when the held card is gone", () => {
    expect(stepFocus(["a", "b"], "removed", 1)).toBe("a");
    expect(stepFocus(["a", "b"], "removed", -1)).toBe("b");
  });

  it("has no step on an empty canvas", () => {
    expect(stepFocus([], "", 1)).toBeUndefined();
  });
});
