import { afterEach, describe, expect, it } from "vitest";
import {
  computeSurfaceMotion,
  resetSurfaceMotionGate,
  setSurfaceMotionForTests,
  startSurfaceMotionGate,
  surfaceMotionLive$,
} from "../src/renderer/lib/surface-motion";

describe("computeSurfaceMotion", () => {
  it("is live only when the page is visible and motion is allowed", () => {
    expect(
      computeSurfaceMotion({ pageVisible: true, reducedMotion: false }),
    ).toBe("live");
    expect(
      computeSurfaceMotion({ pageVisible: false, reducedMotion: false }),
    ).toBe("paused");
    expect(
      computeSurfaceMotion({ pageVisible: true, reducedMotion: true }),
    ).toBe("paused");
    expect(
      computeSurfaceMotion({ pageVisible: false, reducedMotion: true }),
    ).toBe("paused");
  });
});

describe("surfaceMotion gate (stubbed document)", () => {
  const listeners = new Map<string, Set<() => void>>();
  let previousDocument: unknown;
  let previousWindow: unknown;

  const installDom = (opts?: {
    readonly visibilityState?: DocumentVisibilityState;
    readonly reducedMotion?: boolean;
  }) => {
    const dataset: Record<string, string | undefined> = {};
    const documentElement = { dataset };
    const add = (type: string, fn: () => void) => {
      const set = listeners.get(type) ?? new Set();
      set.add(fn);
      listeners.set(type, set);
    };
    const remove = (type: string, fn: () => void) => {
      listeners.get(type)?.delete(fn);
    };
    const mediaListeners = new Set<(ev?: unknown) => void>();
    const motionQuery = {
      matches: opts?.reducedMotion ?? false,
      addEventListener: (_: string, fn: (ev?: unknown) => void) => {
        mediaListeners.add(fn);
      },
      removeEventListener: (_: string, fn: (ev?: unknown) => void) => {
        mediaListeners.delete(fn);
      },
      addListener: (fn: (ev?: unknown) => void) => {
        mediaListeners.add(fn);
      },
      removeListener: (fn: (ev?: unknown) => void) => {
        mediaListeners.delete(fn);
      },
    };

    const doc = {
      documentElement,
      visibilityState: (opts?.visibilityState ?? "visible") as DocumentVisibilityState,
      addEventListener: add,
      removeEventListener: remove,
    };
    previousDocument = (globalThis as { document?: unknown }).document;
    previousWindow = (globalThis as { window?: unknown }).window;
    (globalThis as unknown as { document: typeof doc }).document = doc;
    (globalThis as unknown as {
      window: { matchMedia: (query: string) => typeof motionQuery };
    }).window = {
      matchMedia: (_query: string) => motionQuery,
    };

    return {
      dataset,
      setVisibility(state: DocumentVisibilityState) {
        doc.visibilityState = state;
        for (const fn of listeners.get("visibilitychange") ?? []) fn();
      },
      setReducedMotion(matches: boolean) {
        motionQuery.matches = matches;
        for (const fn of mediaListeners) fn();
      },
    };
  };

  afterEach(() => {
    resetSurfaceMotionGate();
    listeners.clear();
    if (previousDocument === undefined) {
      delete (globalThis as { document?: unknown }).document;
    } else {
      (globalThis as { document: unknown }).document = previousDocument;
    }
    if (previousWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as { window: unknown }).window = previousWindow;
    }
    previousDocument = undefined;
    previousWindow = undefined;
  });

  it("stamps documentElement dataset and surfaceMotionLive$", () => {
    const { dataset } = installDom();
    setSurfaceMotionForTests("live");
    expect(dataset.surfaceMotion).toBe("live");
    expect(surfaceMotionLive$.peek()).toBe(true);

    setSurfaceMotionForTests("paused");
    expect(dataset.surfaceMotion).toBe("paused");
    expect(surfaceMotionLive$.peek()).toBe(false);
  });

  it("startSurfaceMotionGate is idempotent, reacts to hide, and cleans up", () => {
    const dom = installDom({ visibilityState: "visible" });
    const stopA = startSurfaceMotionGate();
    const stopB = startSurfaceMotionGate();
    expect(stopA).toBe(stopB);
    expect(dom.dataset.surfaceMotion).toBe("live");
    expect(surfaceMotionLive$.peek()).toBe(true);

    dom.setVisibility("hidden");
    expect(dom.dataset.surfaceMotion).toBe("paused");
    expect(surfaceMotionLive$.peek()).toBe(false);

    dom.setVisibility("visible");
    expect(dom.dataset.surfaceMotion).toBe("live");

    stopA();
    expect(dom.dataset.surfaceMotion).toBeUndefined();
    expect(surfaceMotionLive$.peek()).toBe(true);
  });

  it("pauses when prefers-reduced-motion flips on", () => {
    const dom = installDom({ visibilityState: "visible", reducedMotion: false });
    startSurfaceMotionGate();
    expect(dom.dataset.surfaceMotion).toBe("live");

    dom.setReducedMotion(true);
    expect(dom.dataset.surfaceMotion).toBe("paused");
  });
});
