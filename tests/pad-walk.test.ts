import { describe, expect, test } from "vitest";
import { asPadElementId, emptyPad, type PadShape } from "../src/shared/pad";
import { connectTargets, connectedWords, readingOrder, selectedWords, shapeName, walkShapes } from "../src/renderer/components/pad/pad-walk";

const shape = (id: string, x: number, y: number, more: Partial<PadShape> = {}): PadShape =>
  ({ id: asPadElementId(id), type: "box", x, y, w: 100, h: 60, z: 0, ...more }) as PadShape;

const a = shape("a", 300, 10);
const b = shape("b", 0, 0, { type: "diamond", text: "Ready?" });
const c = shape("c", 0, 200);
const pad = { ...emptyPad(), shapes: [a, b, c] };

describe("pad by keyboard", () => {
  test("shapes read top to bottom, a row left to right", () => {
    expect(readingOrder(pad.shapes).map((s) => s.id)).toEqual(["b", "a", "c"]);
  });

  test("a walk starts at the first shape and leaves past either end", () => {
    expect(walkShapes(pad.shapes, undefined, 1)?.id).toBe("b");
    expect(walkShapes(pad.shapes, undefined, -1)?.id).toBe("c");
    expect(walkShapes(pad.shapes, "b", 1)?.id).toBe("a");
    expect(walkShapes(pad.shapes, "c", 1)).toBeUndefined();
    expect(walkShapes(pad.shapes, "b", -1)).toBeUndefined();
    expect(walkShapes([], undefined, 1)).toBeUndefined();
  });

  test("the status line names the kind, the words and the place in the walk", () => {
    expect(shapeName(b)).toBe("Diamond, Ready?");
    expect(shapeName(a)).toBe("Box");
    expect(selectedWords(pad, b)).toBe("Selected Diamond, Ready?, 1 of 3");
    expect(connectedWords(a, b)).toBe("Connected Box to Diamond, Ready?");
  });

  test("a keyboard connector walks every other shape", () => {
    expect(connectTargets(pad, "a").map((s) => s.id)).toEqual(["b", "c"]);
  });
});
