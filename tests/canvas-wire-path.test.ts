import { describe, expect, it } from "vitest";
import { wirePath } from "../src/shared/canvas-wire-path";
import { polylineHitsObstacles } from "../src/shared/wire-route";

const card = (x: number, y: number, width = 100, height = 60) => ({ x, y, width, height });

const orthogonal = (points: ReadonlyArray<{ x: number; y: number }>): boolean =>
  points.every((point, index) => {
    if (index === 0) return true;
    const previous = points[index - 1]!;
    return point.x === previous.x || point.y === previous.y;
  });

describe("wirePath", () => {
  it("joins a pair in line by their facing sides in one straight run", () => {
    const wire = wirePath({ from: card(0, 0), to: card(300, 0), obstacles: [] });
    expect(wire.radius).toBe(8);
    expect(wire.points).toEqual([
      { x: 100, y: 30 },
      { x: 300, y: 30 },
    ]);
  });

  it("joins a diagonal pair with one corner, as the desktop's smooth step does", () => {
    const wire = wirePath({ from: card(0, 0), to: card(300, 300), obstacles: [] });
    expect(wire.points).toEqual([
      { x: 100, y: 30 },
      { x: 350, y: 30 },
      { x: 350, y: 300 },
    ]);
  });

  it("detours around a card sitting between the pair", () => {
    const between = card(180, 0, 60, 60);
    const wire = wirePath({ from: card(0, 0), to: card(400, 0), obstacles: [between] });
    expect(wire.points[0]).toEqual({ x: 100, y: 30 });
    expect(wire.points[wire.points.length - 1]).toEqual({ x: 400, y: 30 });
    expect(wire.points.length).toBeGreaterThan(2);
    expect(orthogonal(wire.points)).toBe(true);
    expect(polylineHitsObstacles(wire.points, [between])).toBe(false);
  });

  it("leaves and enters by the authored sides over the computed ones", () => {
    const wire = wirePath({
      from: card(0, 0),
      to: card(300, 0),
      fromSide: "bottom",
      toSide: "bottom",
      obstacles: [],
    });
    expect(wire.points[0]).toEqual({ x: 50, y: 60 });
    expect(wire.points[wire.points.length - 1]).toEqual({ x: 350, y: 60 });
    // Out of the bottom and back up into the bottom: the run dips below both.
    expect(wire.points[1]!.y).toBeGreaterThan(60);
    expect(orthogonal(wire.points)).toBe(true);
  });

  it("never answers more than 256 points", () => {
    const obstacles = Array.from({ length: 40 }, (_, index) =>
      card(140 + (index % 8) * 40, -200 + Math.floor(index / 8) * 100, 20, 60),
    );
    const wire = wirePath({ from: card(0, 0), to: card(600, 0), obstacles });
    expect(wire.points.length).toBeLessThanOrEqual(256);
    expect(wire.points.length).toBeGreaterThanOrEqual(2);
  });
});
