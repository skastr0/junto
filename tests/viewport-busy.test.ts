import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  VIEWPORT_BUSY_ATTR,
  VIEWPORT_BUSY_END_HOLD_MS,
  VIEWPORT_BUSY_IDLE_MS,
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

  it("forces idle after the inactivity timeout even if release is dropped", () => {
    vi.useFakeTimers();
    markViewportBusy();
    expect(viewportBusy$.peek()).toBe(true);
    // No releaseViewportBusy — only the inactivity watchdog.
    vi.advanceTimersByTime(VIEWPORT_BUSY_IDLE_MS - 1);
    expect(viewportBusy$.peek()).toBe(true);
    vi.advanceTimersByTime(2);
    expect(viewportBusy$.peek()).toBe(false);
  });

  it("never force-releases a continuous gesture — every mark refreshes the watchdog", () => {
    vi.useFakeTimers();
    markViewportBusy();
    // Ten seconds of continuous marks at 500ms each — far past the old
    // absolute 2s cap, which force-dropped mid-gesture here.
    for (let tick = 0; tick < 20; tick += 1) {
      vi.advanceTimersByTime(500);
      markViewportBusy();
      expect(viewportBusy$.peek()).toBe(true);
    }
    // Sustained silence is the only forced release.
    vi.advanceTimersByTime(VIEWPORT_BUSY_IDLE_MS + 1);
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

/** Minimal `document` for a node test: only the attribute surface the gate writes. */
const installFakeDocument = (): { readonly busy: () => boolean; readonly restore: () => void } => {
  const attrs = new Set<string>();
  const documentElement = {
    toggleAttribute: (name: string, force?: boolean) => {
      const on = force ?? !attrs.has(name);
      if (on) attrs.add(name);
      else attrs.delete(name);
      return on;
    },
    hasAttribute: (name: string) => attrs.has(name),
  };
  const previous = (globalThis as { document?: unknown }).document;
  (globalThis as { document?: unknown }).document = { documentElement };
  return {
    busy: () => attrs.has(VIEWPORT_BUSY_ATTR),
    restore: () => {
      if (previous === undefined) delete (globalThis as { document?: unknown }).document;
      else (globalThis as { document?: unknown }).document = previous;
    },
  };
};

describe("viewport compositor promotion marker (html attribute)", () => {
  let dom: ReturnType<typeof installFakeDocument>;
  beforeEach(() => {
    dom = installFakeDocument();
  });
  afterEach(() => {
    resetViewportBusy();
    dom.restore();
    vi.useRealTimers();
  });

  it("starts settled — no busy marker on the document", () => {
    expect(viewportBusy$.peek()).toBe(false);
    expect(dom.busy()).toBe(false);
  });

  it("stamps the marker on mark and keeps it latched across repeated marks", () => {
    markViewportBusy();
    expect(dom.busy()).toBe(true);
    markViewportBusy();
    markViewportBusy();
    expect(dom.busy()).toBe(true);
    expect(viewportBusy$.peek()).toBe(true);
  });

  it("clears the marker after the settle hold; a second interaction cancels the pending release", () => {
    vi.useFakeTimers();
    markViewportBusy();
    expect(dom.busy()).toBe(true);

    releaseViewportBusy();
    vi.advanceTimersByTime(VIEWPORT_BUSY_END_HOLD_MS - 1);
    expect(dom.busy()).toBe(true);

    markViewportBusy();
    releaseViewportBusy();
    vi.advanceTimersByTime(VIEWPORT_BUSY_END_HOLD_MS - 1);
    expect(dom.busy()).toBe(true);

    vi.advanceTimersByTime(2);
    expect(dom.busy()).toBe(false);
    expect(viewportBusy$.peek()).toBe(false);
  });

  it("withViewportBusy stamps through the work and schedules release after", async () => {
    vi.useFakeTimers();
    const done = withViewportBusy(async () => {
      expect(dom.busy()).toBe(true);
      return "ok";
    });
    await done;
    expect(dom.busy()).toBe(true);
    vi.advanceTimersByTime(VIEWPORT_BUSY_END_HOLD_MS + 1);
    expect(dom.busy()).toBe(false);
  });

  it("reset clears the marker and pending release work", () => {
    vi.useFakeTimers();
    markViewportBusy();
    releaseViewportBusy();
    expect(dom.busy()).toBe(true);
    resetViewportBusy();
    expect(dom.busy()).toBe(false);
    vi.advanceTimersByTime(VIEWPORT_BUSY_IDLE_MS + 1);
    expect(dom.busy()).toBe(false);
    expect(viewportBusy$.peek()).toBe(false);
  });

  it("holds the marker across a long gesture — silence, not duration, releases it", () => {
    vi.useFakeTimers();
    markViewportBusy();
    for (let tick = 0; tick < 12; tick += 1) {
      vi.advanceTimersByTime(500);
      markViewportBusy();
      expect(dom.busy()).toBe(true);
    }
    vi.advanceTimersByTime(VIEWPORT_BUSY_IDLE_MS + 1);
    expect(dom.busy()).toBe(false);
  });
});
