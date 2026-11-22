/**
 * The obstacle index answers exactly what the whole-board scan answers, in the
 * same order; the router's indexed path is the path of the full scan.
 */
import { describe, expect, it } from "vitest";
import { createObstacleIndex } from "../src/shared/wire-obstacles";
import { inflateRect, polylineHitsObstacles, routeWire, type WireRect } from "../src/shared/wire-route";

/** A small deterministic PRNG, so a failure is a fixture and not a mood. */
const rng = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};

const board = (seed: number, count: number): WireRect[] => {
  const random = rng(seed);
  return Array.from({ length: count }, (_, i) => ({
    x: Math.round(random() * 8000),
    y: Math.round(random() * 8000),
    width: 40 + Math.round(random() * 260),
    height: 30 + Math.round(random() * 120),
    // Kept as a plain rect; the nodeId some callers add rides along untouched.
    ...(i === 0 ? {} : {}),
  }));
};

describe("the obstacle index", () => {
  it("returns the cards touching a box in the board's order, as the scan does", () => {
    const rects = board(7, 400);
    const index = createObstacleIndex(rects);
    const random = rng(11);
    for (let i = 0; i < 40; i += 1) {
      const minX = Math.round(random() * 8000);
      const minY = Math.round(random() * 8000);
      const box = { minX, maxX: minX + Math.round(random() * 2000), minY, maxY: minY + Math.round(random() * 2000) };
      const pad = Math.round(random() * 24);
      const scanned = rects.filter(
        (rect) =>
          rect.x + rect.width >= box.minX - pad &&
          rect.x <= box.maxX + pad &&
          rect.y + rect.height >= box.minY - pad &&
          rect.y <= box.maxY + pad,
      );
      expect(index.near(box, pad)).toEqual(scanned);
    }
  });

  it("answers a polyline hit exactly as the scan of inflated cards does", () => {
    const rects = board(19, 300);
    const index = createObstacleIndex(rects);
    const random = rng(23);
    for (let i = 0; i < 60; i += 1) {
      const points = [
        { x: random() * 8000, y: random() * 8000 },
        { x: random() * 8000, y: random() * 8000 },
        { x: random() * 8000, y: random() * 8000 },
      ];
      const pad = Math.round(random() * 30);
      const skipAt = Math.round(random() * rects.length);
      const skip = (rect: WireRect): boolean => rect === rects[skipAt];
      const scanned = polylineHitsObstacles(
        points,
        rects.filter((rect) => !skip(rect)).map((rect) => inflateRect(rect, pad)),
      );
      expect(index.hits(points, pad, skip)).toBe(scanned);
    }
  });

  it("routes the same path as the full scan on boards of every size", () => {
    const random = rng(31);
    for (let n = 0; n < 8; n += 1) {
      const rects = board(101 + n, 20 + n * 90);
      const index = createObstacleIndex(rects);
      for (let i = 0; i < 6; i += 1) {
        const source = { x: Math.round(random() * 8000), y: Math.round(random() * 8000) };
        const target = { x: Math.round(random() * 8000), y: Math.round(random() * 8000) };
        const input = {
          source,
          target,
          obstacles: rects,
          sourceDirection: "right" as const,
          targetDirection: "left" as const,
        };
        expect(routeWire({ ...input, index })).toEqual(routeWire(input));
      }
    }
  }, 30_000);

  it("routes a wire that needs more than three growths without reading a far field", () => {
    // A staircase of walls just off the direct corridor: each grows the box
    // one step further, and each step is clear of the box before it.
    const local: WireRect[] = [{ x: 495, y: -300, width: 20, height: 600 }];
    for (const y of [300, 320, 340, 360, 380, 400]) {
      local.push({ x: 400, y, width: 200, height: 10 });
      local.push({ x: 400, y: -y - 10, width: 200, height: 10 });
    }
    const far = Array.from({ length: 5000 }, (_, i) => ({
      x: 10_000 + (i % 50) * 300,
      y: 10_000 + Math.floor(i / 50) * 300,
      width: 200,
      height: 100,
    }));
    const obstacles = [...local, ...far];
    const index = createObstacleIndex(obstacles);
    let growths = 0;
    let scans = 0;
    const routed = routeWire({
      source: { x: 0, y: 0 },
      target: { x: 1000, y: 0 },
      obstacles,
      index,
      sourceDirection: "right",
      targetDirection: "left",
      onGrowth: (value) => {
        growths = value;
      },
      onScan: (count) => {
        scans += count;
      },
    });
    expect(routed).not.toBeNull();
    expect(growths).toBeGreaterThan(3);
    // Four local walls and the stairs: the far field is never in a pass.
    expect(scans).toBeLessThan(100);
  });
});
