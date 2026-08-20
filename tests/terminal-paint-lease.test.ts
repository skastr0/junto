import { describe, expect, it } from "vitest";
import { shouldPresentTerminalFrames } from "../src/renderer/lib/terminal-paint-lease";

describe("shouldPresentTerminalFrames", () => {
  it("presents when the seat is visible and motion flags are omitted", () => {
    expect(shouldPresentTerminalFrames({ visible: true })).toBe(true);
  });

  it("does not present a hidden keep-alive seat", () => {
    expect(shouldPresentTerminalFrames({ visible: false })).toBe(false);
  });

  it("does not present when reduced motion is on", () => {
    expect(
      shouldPresentTerminalFrames({ visible: true, reducedMotion: true }),
    ).toBe(false);
    expect(
      shouldPresentTerminalFrames({ visible: true, reducedMotion: false }),
    ).toBe(true);
  });

  it("does not present when surface motion is paused", () => {
    expect(
      shouldPresentTerminalFrames({ visible: true, surfaceMotionLive: false }),
    ).toBe(false);
    expect(
      shouldPresentTerminalFrames({ visible: true, surfaceMotionLive: true }),
    ).toBe(true);
  });

  it("stays off when the seat is hidden even if motion is live", () => {
    expect(
      shouldPresentTerminalFrames({
        visible: false,
        reducedMotion: false,
        surfaceMotionLive: true,
      }),
    ).toBe(false);
  });

  it("treats reduced motion and a paused surface as the same pause", () => {
    expect(
      shouldPresentTerminalFrames({
        visible: true,
        reducedMotion: true,
        surfaceMotionLive: true,
      }),
    ).toBe(false);
    expect(
      shouldPresentTerminalFrames({
        visible: true,
        reducedMotion: false,
        surfaceMotionLive: false,
      }),
    ).toBe(false);
  });
});
