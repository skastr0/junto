/**
 * The box drawing overlay's answer, read into the page's pixels (B7). The
 * overlay is app-owned, but its answer is still decoded, never trusted.
 */
import { describe, expect, it } from "vitest";
import { BOX_OVERLAY_SCRIPT, BOX_OVERLAY_URL, drawnBoxOf } from "../src/main/junto/browser/box-overlay";

describe("the box overlay", () => {
  it("reads its box into the page's CSS pixels at the page's zoom", () => {
    expect(drawnBoxOf({ x: 10, y: 20, w: 40, h: 60 }, 1)).toEqual({ x: 10, y: 20, w: 40, h: 60 });
    expect(drawnBoxOf({ x: 10, y: 20, w: 40, h: 60 }, 2)).toEqual({ x: 5, y: 10, w: 20, h: 30 });
  });

  it("reads Escape and anything but four finite numbers as no box", () => {
    expect(drawnBoxOf(null, 1)).toBeUndefined();
    expect(drawnBoxOf({ x: 0, y: 0, w: Number.NaN, h: 1 }, 1)).toBeUndefined();
    expect(drawnBoxOf({ x: 0, y: 0, w: 0, h: 1 }, 1)).toBeUndefined();
    expect(drawnBoxOf({ x: "0", y: 0, w: 1, h: 1 }, 1)).toBeUndefined();
    expect(drawnBoxOf({ x: 0, y: 0, w: 1, h: 1 }, 0)).toBeUndefined();
  });

  it("loads nothing from the network and draws only from trusted input", () => {
    expect(decodeURIComponent(BOX_OVERLAY_URL)).toContain("default-src 'none'");
    expect(BOX_OVERLAY_URL.startsWith("data:text/html")).toBe(true);
    expect(BOX_OVERLAY_SCRIPT.match(/isTrusted/gu)?.length).toBeGreaterThanOrEqual(4);
  });
});
