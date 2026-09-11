import { describe, expect, it, vi } from "vitest";
import { createRendererSurfaceReadiness } from "../src/main/vellum-command/renderer-surface-readiness";

describe("renderer surface readiness", () => {
  it("accepts only the active committed document challenge", () => {
    vi.useFakeTimers();
    try {
      const timedOut = vi.fn();
      const after = createRendererSurfaceReadiness({
        timeoutMs: 1_000,
        orElse: timedOut,
        createChallenge: () => "generation-1",
      });
      after.documentStarted();
      const challenge = after.trustedDocumentCommitted();
      expect(after.acknowledge("stale-generation")).toBe(false);
      expect(after.ready()).toBe(false);
      expect(after.acknowledge(challenge)).toBe(true);
      vi.advanceTimersByTime(1_000);
      expect(after.ready()).toBe(true);
      expect(timedOut).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out one committed document that never mounts", () => {
    vi.useFakeTimers();
    try {
      const timedOut = vi.fn();
      const readiness = createRendererSurfaceReadiness({
        timeoutMs: 1_000,
        orElse: timedOut,
        createChallenge: () => "generation-1",
      });
      readiness.documentStarted();
      readiness.trustedDocumentCommitted();
      vi.advanceTimersByTime(999);
      expect(timedOut).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(timedOut).toHaveBeenCalledOnce();
      expect(readiness.ready()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out a document load that never commits", () => {
    vi.useFakeTimers();
    try {
      const timedOut = vi.fn();
      const readiness = createRendererSurfaceReadiness({
        timeoutMs: 1_000,
        loadTimeoutMs: 500,
        orElse: timedOut,
      });
      readiness.documentStarted();
      vi.advanceTimersByTime(499);
      expect(timedOut).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(timedOut).toHaveBeenCalledWith("load");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let repeated starts extend an absolute deadline", () => {
    const scheduled: Array<{ readonly callback: () => void; readonly delay: number }> = [];
    let clock = 0;
    const timedOut = vi.fn();
    const readiness = createRendererSurfaceReadiness({
      timeoutMs: 1_000,
      loadTimeoutMs: 500,
      orElse: timedOut,
      now: () => clock,
      schedule: (callback, delay) => {
        scheduled.push({ callback, delay });
        return scheduled.length;
      },
      cancel: () => undefined,
    });

    readiness.documentStarted();
    clock = 400;
    readiness.documentStarted();
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]?.delay).toBe(500);
    clock = 500;
    scheduled[0]?.callback();
    expect(timedOut).toHaveBeenCalledWith("load");
  });

  it("restores an unacknowledged document's remaining deadline after cancellation", () => {
    const delays: number[] = [];
    let clock = 0;
    const readiness = createRendererSurfaceReadiness({
      timeoutMs: 1_000,
      loadTimeoutMs: 500,
      orElse: vi.fn(),
      now: () => clock,
      createChallenge: () => "generation-1",
      schedule: (_callback, delay) => {
        delays.push(delay);
        return delays.length;
      },
      cancel: () => undefined,
    });

    readiness.documentStarted();
    readiness.trustedDocumentCommitted();
    clock = 900;
    readiness.documentStarted();
    clock = 950;
    expect(readiness.committedDocumentRestored()).toBe("generation-1");
    expect(delays.at(-1)).toBe(50);
  });

  it("cannot carry a stale receipt into a replacement document", () => {
    vi.useFakeTimers();
    try {
      const timedOut = vi.fn();
      const challenges = ["generation-1", "generation-2"];
      const readiness = createRendererSurfaceReadiness({
        timeoutMs: 1_000,
        orElse: timedOut,
        createChallenge: () => challenges.shift() ?? "unexpected",
      });
      readiness.documentStarted();
      const first = readiness.trustedDocumentCommitted();
      readiness.acknowledge(first);
      expect(readiness.ready()).toBe(true);

      readiness.documentStarted();
      const second = readiness.trustedDocumentCommitted();
      expect(readiness.acknowledge(first)).toBe(false);
      expect(second).toBe("generation-2");
      expect(readiness.ready()).toBe(false);
      vi.advanceTimersByTime(1_000);
      expect(timedOut).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("restores the acknowledged prior document when navigation is canceled", () => {
    vi.useFakeTimers();
    try {
      const timedOut = vi.fn();
      const readiness = createRendererSurfaceReadiness({
        timeoutMs: 1_000,
        orElse: timedOut,
        createChallenge: () => "generation-1",
      });
      readiness.documentStarted();
      const challenge = readiness.trustedDocumentCommitted();
      readiness.acknowledge(challenge);
      expect(readiness.ready()).toBe(true);

      readiness.documentStarted();
      expect(readiness.ready()).toBe(false);
      readiness.committedDocumentRestored();
      expect(readiness.ready()).toBe(true);
      vi.advanceTimersByTime(1_000);
      expect(timedOut).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("disposal cancels the bounded failure action", () => {
    vi.useFakeTimers();
    try {
      const timedOut = vi.fn();
      const readiness = createRendererSurfaceReadiness({ timeoutMs: 1_000, orElse: timedOut });
      readiness.trustedDocumentCommitted();
      readiness.dispose();
      vi.advanceTimersByTime(1_000);
      expect(timedOut).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
