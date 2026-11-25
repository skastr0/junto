import { describe, expect, it } from "vitest";
import { cameraDrifted } from "../e2e/harness/camera-drift";

// The 1x proof's overview stop on the Mac mini: the shot was taken at the camera the proof
// placed, then a real click on a badge under the minimap flew the camera to the minimap's
// target, and the badge rectangles read afterwards belonged to that camera.
const placed = { x: -60, y: 523, zoom: 0.15 };
const afterMinimapClick = { x: -883.7217118828951, y: 624.4397601628713, zoom: 0.15 };

describe("cameraDrifted", () => {
  it("sees the camera a minimap click flew to", () => {
    expect(cameraDrifted(placed, afterMinimapClick)).toBe(true);
  });

  it("holds while the camera is where the shot was taken", () => {
    expect(cameraDrifted(placed, { ...placed })).toBe(false);
    expect(cameraDrifted(placed, { x: -60.004, y: 523.004, zoom: 0.15 })).toBe(false);
  });

  it("sees a zoom change at the same position", () => {
    expect(cameraDrifted(placed, { ...placed, zoom: 0.16 })).toBe(true);
  });
});
