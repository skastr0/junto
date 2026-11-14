// The camera's numbers (docs/canvas-gpu-inventory/interaction.md, section 1;
// architecture section 14), as pure arithmetic. Every constant here has a
// receipt in the inventory.

import { describe, expect, it } from "vitest";
import {
  CAMERA_SETTLE_MS,
  boardToScreen,
  centreCamera,
  easeCubicInOut,
  fitCamera,
  interpolateCamera,
  panCamera,
  screenToBoard,
  wheelCamera,
} from "../src/window/canvas/engine/camera";

const mods = { ctrl: false, meta: false, shift: false };

describe("screen and board", () => {
  it("are inverses at every zoom", () => {
    const camera = { x: 120, y: -40, zoom: 0.6 };
    const board = { x: 317, y: -82 };
    const screen = boardToScreen(camera, board);
    const back = screenToBoard(camera, screen);
    expect(back.x).toBeCloseTo(board.x, 10);
    expect(back.y).toBeCloseTo(board.y, 10);
  });
});

describe("wheel", () => {
  it("pans by the screen delta * 1.2 on both axes, at every zoom", () => {
    const at = { at: { x: 100, y: 100 }, dx: 30, dy: -40, deltaMode: 0, ...mods };
    for (const zoom of [0.15, 1, 2.5]) {
      const out = wheelCamera({ x: 0, y: 0, zoom }, at, true);
      expect(out.kind).toBe("pan");
      // d3's translateBy multiplies by k, cancelling React Flow's divide.
      expect(out.camera).toEqual({ x: -36, y: 48, zoom });
    }
  });

  it("normalizes line mode by 20", () => {
    const out = wheelCamera({ x: 0, y: 0, zoom: 1 }, { at: { x: 0, y: 0 }, dx: 1, dy: 2, deltaMode: 1, ...mods }, true);
    expect(out.camera).toEqual({ x: -24, y: -48, zoom: 1 });
  });

  it("zooms about the pointer on a macOS pinch (ctrl+wheel, factor 10)", () => {
    const camera = { x: 0, y: 0, zoom: 1 };
    const at = { x: 200, y: 150 };
    const board = screenToBoard(camera, at);
    const out = wheelCamera(camera, { at, dx: 0, dy: 100, deltaMode: 0, ...mods, ctrl: true }, true);
    expect(out.kind).toBe("pinch");
    expect(out.camera.zoom).toBeCloseTo(0.25, 12);
    expect(screenToBoard(out.camera, at)).toEqual(board);
  });

  it("zooms about the pointer with Cmd+wheel on macOS", () => {
    const camera = { x: 0, y: 0, zoom: 1 };
    const at = { x: 200, y: 150 };
    const board = screenToBoard(camera, at);
    const out = wheelCamera(camera, { at, dx: 0, dy: 100, deltaMode: 0, ...mods, meta: true }, true);
    expect(out.kind).toBe("zoom");
    expect(out.camera.zoom).toBeCloseTo(2 ** -0.2, 12);
    expect(screenToBoard(out.camera, at)).toEqual(board);
  });

  it("uses Control as the zoom key off macOS", () => {
    const out = wheelCamera({ x: 0, y: 0, zoom: 1 }, { at: { x: 0, y: 0 }, dx: 0, dy: 100, deltaMode: 0, ...mods, ctrl: true }, false);
    expect(out.kind).toBe("zoom");
    expect(out.camera.zoom).toBeCloseTo(2 ** -0.2, 12);
  });

  it("pans sideways with Shift off macOS", () => {
    const out = wheelCamera({ x: 0, y: 0, zoom: 1 }, { at: { x: 0, y: 0 }, dx: 5, dy: 10, deltaMode: 0, ...mods, shift: true }, false);
    expect(out.camera).toEqual({ x: -12, y: 0, zoom: 1 });
  });

  it("clamps zoom to 0.15 and 2.5", () => {
    const out = wheelCamera({ x: 0, y: 0, zoom: 1 }, { at: { x: 0, y: 0 }, dx: 0, dy: 2000, deltaMode: 0, ...mods, meta: true }, true);
    expect(out.camera.zoom).toBe(0.15);
    const back = wheelCamera({ x: 0, y: 0, zoom: 1 }, { at: { x: 0, y: 0 }, dx: 0, dy: -2000, deltaMode: 0, ...mods, meta: true }, true);
    expect(back.camera.zoom).toBe(2.5);
  });
});

describe("keyboard pan", () => {
  it("flies at 900 px a second, ramped", () => {
    const out = panCamera({ x: 0, y: 0, zoom: 1 }, ["d"], 16, 200, false);
    expect(out.x).toBeCloseTo(-900 * 0.016, 12);
    expect(out.y).toBe(0);
  });

  it("boosts by 2.4 with Shift and clamps a stalled frame at 64 ms", () => {
    const out = panCamera({ x: 0, y: 0, zoom: 1 }, ["w"], 1000, 200, true);
    expect(out.y).toBeCloseTo(900 * 2.4 * 0.064, 12);
  });

  it("normalizes diagonals and ramps from zero", () => {
    const out = panCamera({ x: 0, y: 0, zoom: 1 }, ["w", "d"], 16, 0, false);
    expect(out).toEqual({ x: 0, y: 0, zoom: 1 });
    const ramp = panCamera({ x: 0, y: 0, zoom: 1 }, ["w", "d"], 16, 65, false);
    const step = 900 * 0.016 * 0.5;
    expect(ramp.x).toBeCloseTo(-step / Math.SQRT2, 12);
    expect(ramp.y).toBeCloseTo(step / Math.SQRT2, 12);
  });
});

describe("fit and centre", () => {
  it("fits bounds with padding and caps the zoom", () => {
    const camera = fitCamera({ x: 100, y: 100, width: 100, height: 100 }, { width: 1000, height: 800 }, 0.18, 1.15);
    expect(camera.zoom).toBe(1.15);
    expect(camera.x).toBeCloseTo(500 - 150 * 1.15, 12);
    expect(camera.y).toBeCloseTo(400 - 150 * 1.15, 12);
  });

  it("centres a board point, keeping the zoom when none is given", () => {
    expect(centreCamera({ width: 800, height: 600 }, { x: 50, y: 20 }, 2)).toEqual({ x: 400 - 100, y: 300 - 40, zoom: 2 });
  });
});

describe("smooth moves", () => {
  it("lands exactly on both ends and uses the cubic in-out ease", () => {
    const from = { x: 0, y: 0, zoom: 0.4 };
    const to = { x: -1200, y: 300, zoom: 1.6 };
    const viewport = { width: 800, height: 600 };
    expect(interpolateCamera(from, to, viewport, 0)).toBe(from);
    expect(interpolateCamera(from, to, viewport, 1)).toBe(to);
    expect(easeCubicInOut(0)).toBe(0);
    expect(easeCubicInOut(0.5)).toBe(0.5);
    expect(easeCubicInOut(1)).toBe(1);
    expect(easeCubicInOut(0.25)).toBeCloseTo(0.0625, 12);
    // A midpoint is a real view, not a linear blend of the corners.
    const half = interpolateCamera(from, to, viewport, 0.5);
    expect(half.zoom).toBeGreaterThan(0.4);
    expect(half.zoom).toBeLessThan(1.6);
  });

  it("settles after 160 ms", () => {
    expect(CAMERA_SETTLE_MS).toBe(160);
  });
});
