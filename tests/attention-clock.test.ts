import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ATTENTION_CLOCK_FRAMES,
  ATTENTION_CLOCK_TICK_MS,
  attentionFrame$,
  resetAttentionClockForTests,
  retainAttentionClock,
} from "../src/renderer/lib/attention-clock";
import { canvasTier$ } from "../src/renderer/lib/canvas-tier";
import { surfaceMotionLive$ } from "../src/renderer/lib/surface-motion";

describe("attention clock", () => {
  const listeners = new Map<string, Set<() => void>>();
  let previousDocument: unknown;

  const installDom = () => {
    const dataset: Record<string, string | undefined> = {};
    const documentElement = { dataset };
    const doc = {
      documentElement,
      addEventListener: (type: string, fn: () => void) => {
        const set = listeners.get(type) ?? new Set();
        set.add(fn);
        listeners.set(type, set);
      },
      removeEventListener: (type: string, fn: () => void) => {
        listeners.get(type)?.delete(fn);
      },
    };
    previousDocument = (globalThis as { document?: unknown }).document;
    (globalThis as unknown as { document: typeof doc }).document = doc;
    return dataset;
  };

  afterEach(() => {
    resetAttentionClockForTests();
    vi.useRealTimers();
    surfaceMotionLive$.set(true);
    canvasTier$.set("near");
    listeners.clear();
    if (previousDocument === undefined) {
      delete (globalThis as { document?: unknown }).document;
    } else {
      (globalThis as { document: unknown }).document = previousDocument;
    }
    previousDocument = undefined;
  });

  it("does not stamp until retained", () => {
    const dataset = installDom();
    expect(dataset.markFrame).toBeUndefined();
    expect(attentionFrame$.peek()).toBe(0);
  });

  it("stamps frame 0 immediately and advances on the 90 ms tick", () => {
    vi.useFakeTimers();
    const dataset = installDom();
    const release = retainAttentionClock();
    expect(dataset.markFrame).toBe("0");

    vi.advanceTimersByTime(ATTENTION_CLOCK_TICK_MS);
    expect(dataset.markFrame).toBe("1");
    expect(attentionFrame$.peek()).toBe(1);

    vi.advanceTimersByTime(ATTENTION_CLOCK_TICK_MS * 7);
    expect(dataset.markFrame).toBe("8");

    release();
    expect(dataset.markFrame).toBeUndefined();
  });

  it("wraps after a full cycle of frames", () => {
    vi.useFakeTimers();
    installDom();
    retainAttentionClock();
    vi.advanceTimersByTime(ATTENTION_CLOCK_TICK_MS * ATTENTION_CLOCK_FRAMES);
    expect(attentionFrame$.peek()).toBe(0);
  });

  it("refcount: last release stops the clock", () => {
    vi.useFakeTimers();
    const dataset = installDom();
    const a = retainAttentionClock();
    const b = retainAttentionClock();
    vi.advanceTimersByTime(ATTENTION_CLOCK_TICK_MS);
    expect(dataset.markFrame).toBe("1");
    a();
    vi.advanceTimersByTime(ATTENTION_CLOCK_TICK_MS);
    expect(dataset.markFrame).toBe("2");
    b();
    vi.advanceTimersByTime(ATTENTION_CLOCK_TICK_MS);
    expect(dataset.markFrame).toBeUndefined();
  });

  it("pauses while surface motion is gated", () => {
    vi.useFakeTimers();
    const dataset = installDom();
    retainAttentionClock();
    vi.advanceTimersByTime(ATTENTION_CLOCK_TICK_MS);
    expect(dataset.markFrame).toBe("1");

    surfaceMotionLive$.set(false);
    expect(dataset.markFrame).toBeUndefined();
    vi.advanceTimersByTime(ATTENTION_CLOCK_TICK_MS * 4);
    expect(attentionFrame$.peek()).toBe(1);

    surfaceMotionLive$.set(true);
    expect(dataset.markFrame).toBe("1");
    vi.advanceTimersByTime(ATTENTION_CLOCK_TICK_MS);
    expect(dataset.markFrame).toBe("2");
  });

  it("keeps stepping at every tier: a seat moves wherever it is drawn", () => {
    vi.useFakeTimers();
    const dataset = installDom();
    retainAttentionClock();
    vi.advanceTimersByTime(ATTENTION_CLOCK_TICK_MS);
    expect(dataset.markFrame).toBe("1");
    for (const [tier, frame] of [["mid", "2"], ["far", "3"], ["overview", "4"], ["near", "5"]] as const) {
      canvasTier$.set(tier);
      vi.advanceTimersByTime(ATTENTION_CLOCK_TICK_MS);
      expect(dataset.markFrame, tier).toBe(frame);
    }
  });

});
