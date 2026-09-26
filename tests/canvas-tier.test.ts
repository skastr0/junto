import { afterEach, describe, expect, it } from "vitest";
import {
  TIER_FAR_MIN,
  TIER_HYSTERESIS,
  TIER_MID_MIN,
  TIER_NEAR_MIN,
  canvasTier$,
  clearCanvasTier,
  publishCanvasTier,
  tierForZoom,
} from "../src/renderer/lib/canvas-tier";

describe("canvas tier", () => {
  afterEach(() => clearCanvasTier());

  it("maps a fresh zoom straight to its tier", () => {
    expect(tierForZoom(1)).toBe("near");
    expect(tierForZoom(TIER_NEAR_MIN)).toBe("near");
    expect(tierForZoom(0.5)).toBe("mid");
    expect(tierForZoom(0.25)).toBe("far");
    expect(tierForZoom(0.15)).toBe("overview");
  });

  it("holds a tier until a boundary is passed by the margin, both ways", () => {
    const justBelow = TIER_MID_MIN - TIER_HYSTERESIS / 2;
    expect(tierForZoom(justBelow, "mid")).toBe("mid");
    expect(tierForZoom(TIER_MID_MIN - TIER_HYSTERESIS - 0.001, "mid")).toBe("far");
    const justAbove = TIER_MID_MIN + TIER_HYSTERESIS / 2;
    expect(tierForZoom(justAbove, "far")).toBe("far");
    expect(tierForZoom(TIER_MID_MIN + TIER_HYSTERESIS + 0.001, "far")).toBe("mid");
  });

  it("jumps several tiers at once when the camera moves far", () => {
    expect(tierForZoom(0.1, "near")).toBe("overview");
    expect(tierForZoom(1.2, "overview")).toBe("near");
    expect(tierForZoom(TIER_FAR_MIN - 0.05, "mid")).toBe("overview");
  });

  it("keeps the tier for a zoom it cannot read", () => {
    expect(tierForZoom(Number.NaN, "far")).toBe("far");
    expect(tierForZoom(0, "mid")).toBe("mid");
  });

  it("publishes to the observable", () => {
    expect(publishCanvasTier(0.3)).toBe("far");
    expect(canvasTier$.peek()).toBe("far");
    clearCanvasTier();
    expect(canvasTier$.peek()).toBe("near");
  });
});
