import { afterEach, describe, expect, it, vi } from "vitest";
import {
  markViewportBusy,
  releaseViewportBusy,
  resetViewportBusy,
  viewportBusy$,
} from "../src/renderer/lib/viewport-busy";

describe("viewportBusy$", () => {
  afterEach(() => {
    resetViewportBusy();
    vi.useRealTimers();
  });

  it("marks busy immediately and holds release across wheel bursts", () => {
    vi.useFakeTimers();
    expect(viewportBusy$.peek()).toBe(false);

    markViewportBusy();
    expect(viewportBusy$.peek()).toBe(true);

    releaseViewportBusy();
    // Still busy during the hold window.
    expect(viewportBusy$.peek()).toBe(true);

    // Another mark cancels the pending release.
    vi.advanceTimersByTime(80);
    markViewportBusy();
    releaseViewportBusy();
    vi.advanceTimersByTime(159);
    expect(viewportBusy$.peek()).toBe(true);

    vi.advanceTimersByTime(2);
    expect(viewportBusy$.peek()).toBe(false);
  });

  it("forces idle after the hard max even if release is dropped", () => {
    vi.useFakeTimers();
    markViewportBusy();
    expect(viewportBusy$.peek()).toBe(true);
    // No releaseViewportBusy — only the max timer.
    vi.advanceTimersByTime(1_999);
    expect(viewportBusy$.peek()).toBe(true);
    vi.advanceTimersByTime(2);
    expect(viewportBusy$.peek()).toBe(false);
  });

  it("reset clears timers and forces idle", () => {
    vi.useFakeTimers();
    markViewportBusy();
    releaseViewportBusy();
    resetViewportBusy();
    expect(viewportBusy$.peek()).toBe(false);
    vi.advanceTimersByTime(500);
    expect(viewportBusy$.peek()).toBe(false);
  });
});
