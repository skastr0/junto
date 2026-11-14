import { describe, expect, it } from "vitest";
import { cssRadii, shape, at } from "../src/window/canvas/paint/refs";

/**
 * The corner law: CSS multiplies every radius by one factor when a pair on any
 * edge would overlap. Every number here is checked against Chromium itself:
 * a 216 by 56 div with `border-radius: 999px 12px 12px 999px` captured off
 * screen has white at x 215 on its top row (a square right end) and starts at
 * x 23 on it (a round left end), which is [28, 0.34, 0.34, 28].
 */
describe("cssRadii: the values CSS draws", () => {
  it("scales every corner by one factor when a pill meets a small radius", () => {
    const f = 56 / (999 + 999);
    const used = [28, 12 * f, 12 * f, 28] as const;
    expect(cssRadii([999, 12, 12, 999], 216, 56)).toEqual(used);
    // Chromium's own capture: the right end is square (inset 0 at row 0), the
    // left end round (white starts at x 23, which is the 28px arc).
    expect(used[1]).toBeLessThan(0.5);
  });

  it("leaves a set that fits alone, the seat's own silhouette", () => {
    expect(cssRadii([28, 14, 14, 28], 216, 56)).toEqual([28, 14, 14, 28]);
  });

  it("keeps a scalar a scalar, a pill still half-round", () => {
    expect(cssRadii(999, 20, 20)).toBe(10);
    expect(cssRadii(6, 216, 56)).toBe(6);
  });

  it("is what a quad's builder records, so no painter has to know the law", () => {
    const quad = shape({ key: "shell", z: 1, rect: at(0, 0, 216, 56) }, {}, { radii: [999, 12, 12, 999] });
    expect(quad.radii).toEqual(cssRadii([999, 12, 12, 999], 216, 56));
    // A disc asks for no corners at all.
    const disc = shape({ key: "icon", z: 1, rect: at(0, 0, 34, 34) }, {}, { shape: "disc" });
    expect(disc.radii).toBeUndefined();
  });

  it("a zero-sized rect has no corners to draw", () => {
    expect(cssRadii(999, 0, 56)).toBe(0);
  });
});
