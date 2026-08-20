import { describe, expect, it } from "vitest";
import { shouldKeepFleetLoop } from "../src/renderer/components/fleet/FleetRenderer";

const keep = (
  patch: Partial<Parameters<typeof shouldKeepFleetLoop>[0]> = {},
) =>
  shouldKeepFleetLoop({
    inView: true,
    focused: false,
    reducedMotion: false,
    needsRender: false,
    surfaceMotionLive: true,
    ...patch,
  });

describe("shouldKeepFleetLoop", () => {
  it("does not pin rAF for idle in-view unfocused cards", () => {
    expect(keep()).toBe(false);
  });

  it("keeps the loop only while an in-view card still needs a present", () => {
    expect(keep({ needsRender: true })).toBe(true);
    expect(keep({ needsRender: false })).toBe(false);
  });

  it("stops when surface motion is paused", () => {
    expect(
      keep({ needsRender: true, surfaceMotionLive: false }),
    ).toBe(false);
  });

  it("does not keep the loop for off-screen cards", () => {
    expect(keep({ inView: false, needsRender: true })).toBe(false);
  });

  it("focused and reduced-motion do not pin the loop once settled", () => {
    expect(keep({ focused: true, needsRender: false })).toBe(false);
    expect(keep({ reducedMotion: true, needsRender: false })).toBe(false);
    expect(keep({ focused: true, needsRender: true })).toBe(true);
  });
});
