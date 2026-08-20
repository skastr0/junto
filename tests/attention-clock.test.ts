import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ATTENTION_CLOCK_PHASES,
  ATTENTION_CLOCK_TICK_MS,
  attentionBeat$,
  attentionPhase$,
  resetAttentionClockForTests,
  retainAttentionClock,
} from "../src/renderer/lib/attention-clock";
import { surfaceMotionLive$ } from "../src/renderer/lib/surface-motion";
import { viewportBusy$ } from "../src/renderer/lib/viewport-busy";

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
    viewportBusy$.set(false);
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
    expect(dataset.attentionPhase).toBeUndefined();
    expect(attentionPhase$.peek()).toBe(0);
  });

  it("stamps phase 0 immediately and advances on the 90 ms tick", () => {
    vi.useFakeTimers();
    const dataset = installDom();
    const release = retainAttentionClock();
    expect(dataset.attentionPhase).toBe("0");
    expect(dataset.attentionBeat).toBe("0");

    vi.advanceTimersByTime(ATTENTION_CLOCK_TICK_MS);
    expect(dataset.attentionPhase).toBe("1");
    expect(attentionPhase$.peek()).toBe(1);

    vi.advanceTimersByTime(ATTENTION_CLOCK_TICK_MS * 7);
    expect(dataset.attentionPhase).toBe("0");
    expect(dataset.attentionBeat).toBe("1");
    expect(attentionBeat$.peek()).toBe(1);

    release();
    expect(dataset.attentionPhase).toBeUndefined();
    expect(dataset.attentionBeat).toBeUndefined();
  });

  it("wraps after eight phases", () => {
    vi.useFakeTimers();
    installDom();
    retainAttentionClock();
    vi.advanceTimersByTime(ATTENTION_CLOCK_TICK_MS * ATTENTION_CLOCK_PHASES);
    expect(attentionPhase$.peek()).toBe(0);
    expect(attentionBeat$.peek()).toBe(1);
  });

  it("refcount: last release stops the clock", () => {
    vi.useFakeTimers();
    const dataset = installDom();
    const a = retainAttentionClock();
    const b = retainAttentionClock();
    vi.advanceTimersByTime(ATTENTION_CLOCK_TICK_MS);
    expect(dataset.attentionPhase).toBe("1");
    a();
    vi.advanceTimersByTime(ATTENTION_CLOCK_TICK_MS);
    expect(dataset.attentionPhase).toBe("2");
    b();
    vi.advanceTimersByTime(ATTENTION_CLOCK_TICK_MS);
    expect(dataset.attentionPhase).toBeUndefined();
  });

  it("pauses while surface motion is gated", () => {
    vi.useFakeTimers();
    const dataset = installDom();
    retainAttentionClock();
    vi.advanceTimersByTime(ATTENTION_CLOCK_TICK_MS);
    expect(dataset.attentionPhase).toBe("1");

    surfaceMotionLive$.set(false);
    expect(dataset.attentionPhase).toBeUndefined();
    vi.advanceTimersByTime(ATTENTION_CLOCK_TICK_MS * 4);
    expect(attentionPhase$.peek()).toBe(1);

    surfaceMotionLive$.set(true);
    expect(dataset.attentionPhase).toBe("1");
    vi.advanceTimersByTime(ATTENTION_CLOCK_TICK_MS);
    expect(dataset.attentionPhase).toBe("2");
  });

  it("freezes mid-pan without clearing the stamp", () => {
    vi.useFakeTimers();
    const dataset = installDom();
    retainAttentionClock();
    vi.advanceTimersByTime(ATTENTION_CLOCK_TICK_MS);
    expect(dataset.attentionPhase).toBe("1");

    viewportBusy$.set(true);
    vi.advanceTimersByTime(ATTENTION_CLOCK_TICK_MS * 4);
    expect(dataset.attentionPhase).toBe("1");

    viewportBusy$.set(false);
    vi.advanceTimersByTime(ATTENTION_CLOCK_TICK_MS);
    expect(dataset.attentionPhase).toBe("2");
  });
});
