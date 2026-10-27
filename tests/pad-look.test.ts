import { describe, expect, test } from "vitest";
import type { PadShape } from "../src/shared/pad";
import { PAD_LOOK, padArrowHead, padEdgeMid, padTextLayout } from "../src/shared/pad-project";

const box = (w: number, h: number, type: PadShape["type"] = "box"): PadShape =>
  ({ id: "s", type, x: 0, y: 0, w, h, z: 0 }) as PadShape;

describe("pad look", () => {
  test("a shape's words wrap to its width and centre in it", () => {
    const layout = padTextLayout(box(120, 120), "ship the pad before the review");
    const perLine = Math.floor((120 - 2 * PAD_LOOK.inset) / (PAD_LOOK.text * PAD_LOOK.advance));
    expect(layout.anchor).toBe("middle");
    expect(layout.x).toBe(60);
    expect(layout.lines.length).toBeGreaterThan(1);
    for (const line of layout.lines) expect(line.length).toBeLessThanOrEqual(perLine);
    expect(layout.lines.join(" ")).toBe("ship the pad before the review");
  });

  test("words past a shape's height end in an ellipsis", () => {
    const layout = padTextLayout(box(80, 40), "one two three four five six seven eight nine ten");
    expect(layout.lines).toHaveLength(1);
    expect(layout.lines[0]!.endsWith("…")).toBe(true);
  });

  test("a label reads from its top left and never cuts", () => {
    const layout = padTextLayout(box(60, 10, "label"), "a long label that keeps going");
    expect(layout.anchor).toBe("start");
    expect(layout.x).toBe(0);
    expect(layout.lines.join(" ")).toBe("a long label that keeps going");
  });

  test("an arrowhead points along the last leg and ignores repeated points", () => {
    const head = padArrowHead([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 0 }]);
    expect(head?.[0]).toEqual({ x: 100, y: 0 });
    expect(head?.[1].x).toBeCloseTo(100 - PAD_LOOK.arrow);
    expect(Math.abs(head![1].y - head![2].y)).toBeCloseTo(PAD_LOOK.arrow);
    expect(padArrowHead([{ x: 5, y: 5 }])).toBeUndefined();
  });

  test("an edge's label sits halfway along its route", () => {
    expect(padEdgeMid([{ x: 0, y: 0 }, { x: 10, y: 0 }])).toEqual({ x: 5, y: 0 });
    expect(padEdgeMid([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }])).toEqual({ x: 10, y: 0 });
  });
});
