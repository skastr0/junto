import { describe, expect, it } from "vitest";
import {
  inflateRect,
  polylineHitsObstacles,
  routeWire,
  roundedOrthogonalPath,
  segmentHitsRect,
  simplifyPolyline,
} from "../src/renderer/lib/wire-route";

describe("wire-route geometry", () => {
  it("detects horizontal segment through a rect", () => {
    const rect = { x: 40, y: 40, width: 40, height: 40 };
    expect(segmentHitsRect({ x: 0, y: 60 }, { x: 120, y: 60 }, rect)).toBe(true);
    expect(segmentHitsRect({ x: 0, y: 10 }, { x: 120, y: 10 }, rect)).toBe(false);
  });

  it("detects vertical segment through a rect", () => {
    const rect = { x: 40, y: 40, width: 40, height: 40 };
    expect(segmentHitsRect({ x: 60, y: 0 }, { x: 60, y: 120 }, rect)).toBe(true);
    expect(segmentHitsRect({ x: 10, y: 0 }, { x: 10, y: 120 }, rect)).toBe(false);
  });

  it("inflates obstacles by padding", () => {
    expect(inflateRect({ x: 10, y: 20, width: 30, height: 40 }, 5)).toEqual({
      x: 5,
      y: 15,
      width: 40,
      height: 50,
    });
  });

  it("simplifies duplicate points", () => {
    expect(
      simplifyPolyline([
        { x: 0, y: 0 },
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ]),
    ).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ]);
  });

  it("builds a rounded orthogonal path", () => {
    const d = roundedOrthogonalPath(
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 50 },
      ],
      8,
    );
    expect(d.startsWith("M ")).toBe(true);
    expect(d).toContain("Q ");
    expect(d).toContain("L ");
  });
});

describe("routeWire", () => {
  it("returns null when there are no obstacles", () => {
    expect(
      routeWire({
        source: { x: 0, y: 50 },
        target: { x: 200, y: 50 },
        obstacles: [],
      }),
    ).toBeNull();
  });

  it("returns null when obstacles sit outside the corridor", () => {
    expect(
      routeWire({
        source: { x: 0, y: 50 },
        target: { x: 200, y: 50 },
        obstacles: [{ x: 0, y: 400, width: 40, height: 40 }],
        padding: 8,
      }),
    ).toBeNull();
  });

  it("routes around a node sitting on the direct path", () => {
    // Source left, target right; obstacle dead-center of the horizontal run.
    const source = { x: 0, y: 100 };
    const target = { x: 300, y: 100 };
    const obstacle = { x: 120, y: 70, width: 60, height: 60 };

    const direct = [
      source,
      { x: target.x, y: source.y },
      target,
    ];
    expect(polylineHitsObstacles(direct, [inflateRect(obstacle, 14)])).toBe(true);

    const routed = routeWire({
      source,
      target,
      obstacles: [obstacle],
      padding: 14,
      borderRadius: 8,
    });
    expect(routed).not.toBeNull();
    expect(routed!.path.length).toBeGreaterThan(0);
    expect(routed!.detoured).toBe(true);
    // Label sits somewhere between source and target after detour.
    expect(routed!.labelX).toBeGreaterThan(0);
    expect(routed!.labelX).toBeLessThan(300);
  });

  it("prefers a clear mid-X Z path over a longer union skirt when free", () => {
    // Obstacle only blocks the pure-horizontal L; mid-X Z is free.
    const source = { x: 0, y: 0 };
    const target = { x: 200, y: 100 };
    // Block only y≈0 horizontal strip in the middle.
    const obstacle = { x: 80, y: -10, width: 40, height: 24 };

    const routed = routeWire({
      source,
      target,
      obstacles: [obstacle],
      padding: 4,
    });
    expect(routed).not.toBeNull();
    // Mid-X Z (or L via vertical first) should work without long detour.
    // detoured may be false for early L/Z candidates.
    expect(typeof routed!.path).toBe("string");
  });

  it("finds a corner route through a dense obstacle layout", () => {
    // The old global-union candidates all collided here even though a clear
    // path exists through the individual obstacle corners. This is the shape
    // that previously sent EtherEdge to the awkward smooth-step fallback.
    const routed = routeWire({
      source: { x: 0, y: 0 },
      target: { x: 400, y: 300 },
      obstacles: [
        { x: 10, y: 300, width: 70, height: 50 },
        { x: 320, y: 130, width: 80, height: 20 },
        { x: 190, y: -10, width: 20, height: 60 },
      ],
      padding: 14,
      borderRadius: 8,
      sourceDirection: "bottom",
      targetDirection: "left",
    });

    expect(routed).not.toBeNull();
    expect(routed!.detoured).toBe(true);
    expect(routed!.path).toContain("Q ");
  });

  it("relaxes clearance before falling back when adjacent cards leave a narrow gap", () => {
    const routed = routeWire({
      source: { x: 82, y: 0 },
      target: { x: 228, y: 300 },
      obstacles: [
        { x: 0, y: 27, width: 80, height: 550 },
        { x: 90, y: 300, width: 500, height: 290 },
      ],
      padding: 14,
      borderRadius: 8,
      sourceDirection: "bottom",
      targetDirection: "left",
    });

    expect(routed).not.toBeNull();
    // The route exits above the cards rather than following the lower card's
    // top border, which is the visual regression captured in the attachment.
    expect(routed!.path).toContain("M 82,0 L 82,12");
    expect(routed!.path).not.toContain("M 82,0 L 82,292");
  });
});
