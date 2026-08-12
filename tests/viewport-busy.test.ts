import { afterEach, describe, expect, it, vi } from "vitest";
import {
  VIEWPORT_BUSY_CLASS,
  VIEWPORT_BUSY_END_HOLD_MS,
  VIEWPORT_BUSY_MAX_MS,
  bindViewportBusyHost,
  markViewportBusy,
  releaseViewportBusy,
  resetViewportBusy,
  viewportBusy$,
  withViewportBusy,
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
    vi.advanceTimersByTime(VIEWPORT_BUSY_END_HOLD_MS - 1);
    expect(viewportBusy$.peek()).toBe(true);

    vi.advanceTimersByTime(2);
    expect(viewportBusy$.peek()).toBe(false);
  });

  it("forces idle after the hard max even if release is dropped", () => {
    vi.useFakeTimers();
    markViewportBusy();
    expect(viewportBusy$.peek()).toBe(true);
    // No releaseViewportBusy — only the max timer.
    vi.advanceTimersByTime(VIEWPORT_BUSY_MAX_MS - 1);
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

/** Minimal classList host — no jsdom required for unit tests. */
const makeHost = (className = ""): HTMLElement => {
  const classes = new Set(className.split(/\s+/).filter(Boolean));
  const host = {
    classList: {
      contains: (name: string) => classes.has(name),
      add: (name: string) => {
        classes.add(name);
      },
      remove: (name: string) => {
        classes.delete(name);
      },
      toggle: (name: string, force?: boolean) => {
        const on = force ?? !classes.has(name);
        if (on) classes.add(name);
        else classes.delete(name);
        return on;
      },
    },
    get className() {
      return [...classes].join(" ");
    },
    set className(next: string) {
      classes.clear();
      for (const part of next.split(/\s+/).filter(Boolean)) classes.add(part);
    },
  };
  return host as unknown as HTMLElement;
};

describe("viewport compositor promotion host class", () => {
  afterEach(() => {
    resetViewportBusy();
    vi.useRealTimers();
  });

  it("starts settled — host has no busy/promotion class", () => {
    const host = makeHost("react-flow");
    bindViewportBusyHost(host);
    expect(viewportBusy$.peek()).toBe(false);
    expect(host.classList.contains(VIEWPORT_BUSY_CLASS)).toBe(false);
  });

  it("promotes host on mark and keeps class latched across repeated marks", () => {
    const host = makeHost();
    bindViewportBusyHost(host);
    markViewportBusy();
    expect(host.classList.contains(VIEWPORT_BUSY_CLASS)).toBe(true);
    markViewportBusy();
    markViewportBusy();
    expect(host.classList.contains(VIEWPORT_BUSY_CLASS)).toBe(true);
    expect(viewportBusy$.peek()).toBe(true);
  });

  it("releases promotion after settle hold; second interaction cancels pending release", () => {
    vi.useFakeTimers();
    const host = makeHost();
    bindViewportBusyHost(host);

    markViewportBusy();
    expect(host.classList.contains(VIEWPORT_BUSY_CLASS)).toBe(true);

    releaseViewportBusy();
    vi.advanceTimersByTime(VIEWPORT_BUSY_END_HOLD_MS - 1);
    expect(host.classList.contains(VIEWPORT_BUSY_CLASS)).toBe(true);

    // Second interaction cancels pending release.
    markViewportBusy();
    releaseViewportBusy();
    vi.advanceTimersByTime(VIEWPORT_BUSY_END_HOLD_MS - 1);
    expect(host.classList.contains(VIEWPORT_BUSY_CLASS)).toBe(true);

    vi.advanceTimersByTime(2);
    expect(host.classList.contains(VIEWPORT_BUSY_CLASS)).toBe(false);
    expect(viewportBusy$.peek()).toBe(false);
  });

  it("withViewportBusy promotes through work and schedules release after", async () => {
    vi.useFakeTimers();
    const host = makeHost();
    bindViewportBusyHost(host);

    const done = withViewportBusy(async () => {
      expect(host.classList.contains(VIEWPORT_BUSY_CLASS)).toBe(true);
      return "ok";
    });
    await done;
    expect(host.classList.contains(VIEWPORT_BUSY_CLASS)).toBe(true);
    vi.advanceTimersByTime(VIEWPORT_BUSY_END_HOLD_MS + 1);
    expect(host.classList.contains(VIEWPORT_BUSY_CLASS)).toBe(false);
  });

  it("reset / unmount clears host class and pending release work", () => {
    vi.useFakeTimers();
    const host = makeHost();
    const unbind = bindViewportBusyHost(host);
    markViewportBusy();
    releaseViewportBusy();
    expect(host.classList.contains(VIEWPORT_BUSY_CLASS)).toBe(true);

    resetViewportBusy();
    unbind();
    expect(host.classList.contains(VIEWPORT_BUSY_CLASS)).toBe(false);
    expect(viewportBusy$.peek()).toBe(false);
    vi.advanceTimersByTime(VIEWPORT_BUSY_END_HOLD_MS + 50);
    expect(host.classList.contains(VIEWPORT_BUSY_CLASS)).toBe(false);
  });

  it("re-bind after className rewrite restores busy class without dropping promotion", () => {
    const host = makeHost("react-flow impact-mode");
    bindViewportBusyHost(host);
    markViewportBusy();
    expect(host.classList.contains(VIEWPORT_BUSY_CLASS)).toBe(true);

    // Simulate React rewriting className (drops is-viewport-busy).
    host.className = "react-flow connection-focus-mode";
    expect(host.classList.contains(VIEWPORT_BUSY_CLASS)).toBe(false);

    bindViewportBusyHost(host);
    expect(host.classList.contains(VIEWPORT_BUSY_CLASS)).toBe(true);
  });
});
