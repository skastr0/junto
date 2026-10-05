import { describe, expect, it } from "vitest";
import { wireSides } from "../src/renderer/lib/wire-sides";

const seat = (x: number, y: number) => ({ x, y, width: 184, height: 56 });

describe("wireSides", () => {
  it("joins two cards in a row by their facing sides", () => {
    expect(wireSides(seat(0, 0), seat(400, 0))).toEqual({ source: "right", target: "left" });
    expect(wireSides(seat(400, 0), seat(0, 0))).toEqual({ source: "left", target: "right" });
  });

  it("joins two cards in a column by their facing sides", () => {
    expect(wireSides(seat(0, 0), seat(0, 300))).toEqual({ source: "bottom", target: "top" });
    expect(wireSides(seat(0, 300), seat(0, 0))).toEqual({ source: "top", target: "bottom" });
  });

  it("keeps facing sides when a row is only slightly out of line", () => {
    expect(wireSides(seat(0, 0), seat(400, 30))).toEqual({ source: "right", target: "left" });
    expect(wireSides(seat(0, 0), seat(400, -30))).toEqual({ source: "right", target: "left" });
  });

  it("takes one corner on a diagonal: out along the longer axis, in by the side facing back", () => {
    // Up and to the right, further across than up.
    expect(wireSides(seat(0, 0), seat(500, -300))).toEqual({ source: "right", target: "bottom" });
    // Up and to the right, further up than across.
    expect(wireSides(seat(0, 0), seat(300, -500))).toEqual({ source: "top", target: "left" });
    // Down and to the left.
    expect(wireSides(seat(0, 0), seat(-500, 300))).toEqual({ source: "left", target: "top" });
    expect(wireSides(seat(0, 0), seat(-300, 500))).toEqual({ source: "bottom", target: "right" });
  });

  it("never leaves by a side that faces away from the far card", () => {
    for (const [x, y] of [[500, -300], [500, 300], [-500, 300], [-500, -300], [600, 0], [0, 600], [-600, 0], [0, -600]] as const) {
      const sides = wireSides(seat(0, 0), seat(x, y));
      if (x > 200) expect(sides.source).not.toBe("left");
      if (x < -200) expect(sides.source).not.toBe("right");
      if (y > 200) expect(sides.source).not.toBe("top");
      if (y < -200) expect(sides.source).not.toBe("bottom");
      if (x > 200) expect(sides.target).not.toBe("right");
      if (x < -200) expect(sides.target).not.toBe("left");
      if (y > 200) expect(sides.target).not.toBe("bottom");
      if (y < -200) expect(sides.target).not.toBe("top");
    }
  });

  it("answers the mirrored pair when the wire is read the other way", () => {
    const there = wireSides(seat(0, 0), seat(500, -300));
    const back = wireSides(seat(500, -300), seat(0, 0));
    expect(there.source === "right" || there.source === "top").toBe(true);
    expect(back.source === "left" || back.source === "bottom").toBe(true);
  });

  it("still answers for overlapping cards", () => {
    const sides = wireSides(seat(0, 0), seat(40, 10));
    expect(["left", "right", "top", "bottom"]).toContain(sides.source);
    expect(["left", "right", "top", "bottom"]).toContain(sides.target);
  });
});
