/**
 * The region index (issue 912) answers every stack exactly as `regionStack`
 * does, at a cost of the regions near each target instead of every region.
 */
import { describe, expect, it } from "vitest";
import { asNodeId, type Node, type Region } from "../src/shared/model";
import { regionIndex, regionStack } from "../src/shared/model/canvas";

const region = (name: string, x: number, y: number, width: number, height: number): Region => ({
  kind: "region",
  id: asNodeId(name),
  z: 0,
  hold: false,
  label: name,
  x,
  y,
  width,
  height,
});

/** A fixed pseudo-random sequence, so the board is the same on every run. */
const random = (seed: number) => () => {
  seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
  return seed / 2 ** 32;
};

describe("the region index", () => {
  it("gives every target the stack regionStack gives it, nested, overlapping and board-wide regions included", () => {
    const next = random(912);
    const regions: Region[] = [region("board", -50_000, -50_000, 100_000, 100_000)];
    for (let i = 0; i < 300; i += 1) {
      const width = 200 + next() * 4000;
      const height = 200 + next() * 3000;
      regions.push(region(`r${String(i)}`, (next() - 0.5) * 40_000, (next() - 0.5) * 30_000, width, height));
    }
    // Nested ones, and two of the same area, so the id order is exercised.
    regions.push(region("inner-a", 100, 100, 400, 300), region("inner-b", 100, 100, 400, 300), region("outer", 0, 0, 2000, 2000));
    const placed = { nodes: new Map<Node["id"], Node>(regions.map((r) => [r.id, r])) };
    const index = regionIndex(regions);
    for (const r of regions) expect(index.stack(r, r.id).map((s) => s.id), r.id).toEqual(regionStack(placed, r.id).map((s) => s.id));
    for (let i = 0; i < 2000; i += 1) {
      const frame = { x: (next() - 0.5) * 44_000, y: (next() - 0.5) * 34_000, width: 216, height: 56 };
      expect(index.stack(frame).map((s) => s.id)).toEqual(regionStack(placed, frame).map((s) => s.id));
    }
    expect(index.stack({ x: 150, y: 150, width: 10, height: 10 }).map((s) => s.id)).toEqual(["board", "outer", "inner-a", "inner-b"]);
  });

  it("answers nothing on a board with no regions", () => {
    expect(regionIndex([]).stack({ x: 0, y: 0, width: 1, height: 1 })).toEqual([]);
  });
});
