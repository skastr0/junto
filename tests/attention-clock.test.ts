import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ATTENTION_CLOCK_FRAMES,
  ATTENTION_CLOCK_RESUME_MS,
  ATTENTION_CLOCK_TICK_MS,
  attentionFrame$,
  resetAttentionClockForTests,
  retainAttentionClock,
} from "../src/renderer/lib/attention-clock";
import { canvasTier$ } from "../src/renderer/lib/canvas-tier";
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

  it("freezes mid-pan without clearing the stamp, and resumes after a quiet hold", () => {
    vi.useFakeTimers();
    const dataset = installDom();
    retainAttentionClock();
    vi.advanceTimersByTime(ATTENTION_CLOCK_TICK_MS);
    expect(dataset.markFrame).toBe("1");

    viewportBusy$.set(true);
    vi.advanceTimersByTime(ATTENTION_CLOCK_TICK_MS * 4);
    expect(dataset.markFrame).toBe("1");

    viewportBusy$.set(false);
    vi.advanceTimersByTime(ATTENTION_CLOCK_RESUME_MS - 1);
    expect(dataset.markFrame).toBe("1");
    vi.advanceTimersByTime(1 + ATTENTION_CLOCK_TICK_MS);
    expect(dataset.markFrame).toBe("2");
  });

  it("stays frozen across the gaps of a bursty pan", () => {
    vi.useFakeTimers();
    const dataset = installDom();
    retainAttentionClock();
    vi.advanceTimersByTime(ATTENTION_CLOCK_TICK_MS);
    for (let burst = 0; burst < 6; burst += 1) {
      viewportBusy$.set(true);
      vi.advanceTimersByTime(250);
      viewportBusy$.set(false);
      vi.advanceTimersByTime(ATTENTION_CLOCK_RESUME_MS - 100);
    }
    expect(dataset.markFrame).toBe("1");
  });

  it("stops below the near tier and drops the stamp, so loops show their pose", () => {
    vi.useFakeTimers();
    const dataset = installDom();
    retainAttentionClock();
    vi.advanceTimersByTime(ATTENTION_CLOCK_TICK_MS);
    expect(dataset.markFrame).toBe("1");

    canvasTier$.set("mid");
    expect(dataset.markFrame).toBeUndefined();
    vi.advanceTimersByTime(ATTENTION_CLOCK_TICK_MS * 4);
    expect(dataset.markFrame).toBeUndefined();

    canvasTier$.set("far");
    vi.advanceTimersByTime(ATTENTION_CLOCK_TICK_MS);
    expect(dataset.markFrame).toBeUndefined();

    canvasTier$.set("near");
    expect(dataset.markFrame).toBe("1");
    vi.advanceTimersByTime(ATTENTION_CLOCK_TICK_MS);
    expect(dataset.markFrame).toBe("2");
  });
});
