/**
 * The things a region's edge cuts (regionCrossers, src/shared/model/canvas.ts):
 * not regions, overlapping the region's frame with area above zero, not wholly
 * inside it. The Broadcast confirm names the seats among them, because a
 * region's Broadcast reaches only the seats it wholly holds. The seeds are the
 * two product-automation ran, where the confirm read 45 and 54 of 60.
 */
import { describe, expect, it } from "vitest";
import { regionCrossers, regionMembers } from "../src/shared/model/canvas";
import { canvasOf, note, region, seat } from "./support/model-nodes";

const SEAT = { width: 240, height: 96 } as const;
const ids = (nodes: ReadonlyArray<{ readonly id: string }>) => nodes.map((node) => node.id);

const seeded = (frame: { x: number; y: number; width: number; height: number }, rowGap: number, y0: number) => {
  const seats = Array.from({ length: 60 }, (_, i) => seat(`s${String(i).padStart(2, "0")}`, { x: 40 + (i % 10) * 170, y: y0 + Math.floor(i / 10) * rowGap, ...SEAT }));
  const big = region("r-big", frame, { label: "Big" });
  const canvas = canvasOf([big, ...seats, seat("s-lone", { x: 40, y: 1000, ...SEAT })]);
  return { canvas, big };
};

describe("the things a region's edge cuts", () => {
  it("is 15 for the 1760 x 700 seed, whose confirm read 45 of 60", () => {
    const { canvas, big } = seeded({ x: 0, y: 0, width: 1760, height: 700 }, 110, 80);
    expect(regionMembers(canvas, big)).toHaveLength(45);
    expect(regionCrossers(canvas, big)).toHaveLength(15);
  });

  it("is 6 for the 1800 x 900 seed, whose confirm read 54 of 60", () => {
    const { canvas, big } = seeded({ x: 0, y: 0, width: 1800, height: 900 }, 100, 60);
    expect(regionMembers(canvas, big)).toHaveLength(54);
    expect(regionCrossers(canvas, big)).toHaveLength(6);
  });

  it("never shares a node with the members, and is empty for a region that holds every seat", () => {
    const { canvas, big } = seeded({ x: 0, y: 0, width: 1800, height: 900 }, 100, 60);
    const members = new Set(ids(regionMembers(canvas, big)));
    expect(ids(regionCrossers(canvas, big)).some((id) => members.has(id))).toBe(false);
    const whole = seeded({ x: 0, y: 0, width: 3200, height: 1100 }, 100, 60);
    expect(regionCrossers(whole.canvas, whole.big)).toEqual([]);
  });

  it("leaves out a node wholly outside, and one that only touches the edge with no overlap", () => {
    const big = region("r-big", { x: 0, y: 0, width: 1000, height: 500 }, { label: "Big" });
    const canvas = canvasOf([
      big,
      seat("s-outside", { x: 2000, y: 2000, ...SEAT }),
      seat("s-touch-right", { x: 1000, y: 100, ...SEAT }),
      seat("s-touch-bottom", { x: 100, y: 500, ...SEAT }),
      seat("s-touch-left", { x: -240, y: 100, ...SEAT }),
      seat("s-corner", { x: 1000, y: 500, ...SEAT }),
    ]);
    expect(regionCrossers(canvas, big)).toEqual([]);
  });

  it("counts a node that overlaps by a sliver, and one that holds the region's corner", () => {
    const big = region("r-big", { x: 0, y: 0, width: 1000, height: 500 }, { label: "Big" });
    const canvas = canvasOf([
      big,
      seat("s-sliver", { x: 999, y: 100, ...SEAT }),
      seat("s-corner", { x: 900, y: 450, ...SEAT }),
      seat("s-inside", { x: 100, y: 100, ...SEAT }),
    ]);
    expect(ids(regionCrossers(canvas, big))).toEqual(["s-sliver", "s-corner"]);
  });

  it("gives every kind but a region, and no region: the caller keeps the kinds it wants", () => {
    const big = region("r-big", { x: 0, y: 0, width: 1000, height: 500 }, { label: "Big" });
    const canvas = canvasOf([
      big,
      note("n-cross", "cross", { x: 950, y: 100, width: 200, height: 100 }),
      region("r-cross", { x: 900, y: 100, width: 300, height: 300 }, { label: "Cross" }),
      seat("s-cross", { x: 900, y: 100, ...SEAT }),
    ]);
    expect(ids(regionCrossers(canvas, big))).toEqual(["n-cross", "s-cross"]);
  });

  it("comes in the order regionMembers does: the board's node order", () => {
    const big = region("r-big", { x: 0, y: 0, width: 1000, height: 500 }, { label: "Big" });
    const canvas = canvasOf([big, seat("s-b", { x: 950, y: 100, ...SEAT }), seat("s-a", { x: 960, y: 200, ...SEAT })]);
    expect(ids(regionCrossers(canvas, big))).toEqual(["s-b", "s-a"]);
  });
});
