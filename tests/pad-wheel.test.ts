import { describe, expect, test } from "vitest";
import { identityCamera } from "../src/shared/pad-geom";
import { CAMERA_ZOOM_MAX, wheelCamera } from "../src/renderer/components/pad/pad-editor-model";

const wheel = (deltaX: number, deltaY: number, mods: { ctrlKey?: boolean; metaKey?: boolean; deltaMode?: number } = {}) => ({
  deltaX,
  deltaY,
  deltaMode: mods.deltaMode ?? 0,
  ctrlKey: mods.ctrlKey ?? false,
  metaKey: mods.metaKey ?? false,
});

describe("pad wheel", () => {
  test("a two-finger scroll pans the view with the fingers", () => {
    const next = wheelCamera(identityCamera, wheel(12, 8), { x: 100, y: 100 });
    expect(next).toEqual({ x: 12, y: 8, zoom: 1 });
  });

  test("a pinch zooms at the pointer and keeps the point under it", () => {
    const at = { x: 200, y: 100 };
    const next = wheelCamera(identityCamera, wheel(0, -20, { ctrlKey: true }), at);
    expect(next.zoom).toBeGreaterThan(1);
    expect(next.x + at.x / next.zoom).toBeCloseTo(at.x);
    expect(next.y + at.y / next.zoom).toBeCloseTo(at.y);
  });

  test("a line-mode wheel pans by lines", () => {
    expect(wheelCamera(identityCamera, wheel(0, 3, { deltaMode: 1 }), { x: 0, y: 0 }).y).toBe(48);
  });
});

describe("pad wheel limits", () => {
  test("a pinch past the max lands on the max, with the point held", () => {
    const at = { x: 120, y: 80 };
    const near = { x: 0, y: 0, zoom: CAMERA_ZOOM_MAX * 0.98 };
    const next = wheelCamera(near, wheel(0, -50, { ctrlKey: true }), at);
    expect(next.zoom).toBe(CAMERA_ZOOM_MAX);
    expect(next.x + at.x / next.zoom).toBeCloseTo(near.x + at.x / near.zoom);
  });

  test("Shift on a plain wheel pans sideways", () => {
    const next = wheelCamera(identityCamera, { ...wheel(0, 10), shiftKey: true }, { x: 0, y: 0 });
    expect(next).toEqual({ x: 10, y: 0, zoom: 1 });
  });
});
