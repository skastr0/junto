import { describe, expect, it, vi } from "vitest";
import { heapRow, readHeap, startHeapLog, type HeapInput } from "../src/node/observability/heap-log";

const MB = 1024 * 1024;
const heap = (usedMb: number, limitMb = 4096): HeapInput => ({
  rss: 900 * MB,
  heapUsed: usedMb * MB,
  heapTotal: (usedMb + 50) * MB,
  external: 20 * MB,
  arrayBuffers: 5 * MB,
  heapLimit: limitMb * MB,
  nativeContexts: 1,
  detachedContexts: 0,
});

describe("a process's own heap rows", () => {
  it("read this process's heap against a real limit", () => {
    const now = readHeap();
    expect(now.heapUsed).toBeGreaterThan(0);
    expect(now.heapLimit).toBeGreaterThan(now.heapUsed);
    expect(heapRow(heap(1024)).heapUsedPct).toBe(25);
    expect(heapRow(heap(1, 0)).heapUsedPct).toBe(0);
  });

  it("write a named row each interval, warn once per line crossed, and a last row on stop", () => {
    vi.useFakeTimers();
    try {
      const rows: Array<[string, string]> = [];
      let used = 1000;
      const stop = startHeapLog({ label: "core", read: () => heap(used), write: (level, message) => rows.push([level, message]), intervalMs: 1000 });
      vi.advanceTimersByTime(1000);
      used = 3200;
      vi.advanceTimersByTime(1000);
      vi.advanceTimersByTime(1000);
      stop();
      const info = rows.filter(([level]) => level === "info").map(([, message]) => message);
      expect(info.length).toBe(4);
      expect(info.every((message) => message.startsWith("[metrics] core heap {"))).toBe(true);
      expect(JSON.parse(info[0]!.slice("[metrics] core heap ".length))).toMatchObject({ heapUsedMb: 1000, heapLimitMb: 4096, rssMb: 900 });
      expect(rows.filter(([level]) => level === "warn").map(([, message]) => message)).toEqual([
        "[metrics] core heap passed 50% of its limit: 3200 of 4096 MB",
        "[metrics] core heap passed 75% of its limit: 3200 of 4096 MB",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("report a failing read once per streak", () => {
    vi.useFakeTimers();
    try {
      const rows: Array<[string, string]> = [];
      let broken = true;
      const stop = startHeapLog({
        label: "core",
        read: () => {
          if (broken) throw new Error("no heap");
          return heap(10);
        },
        write: (level, message) => rows.push([level, message]),
        intervalMs: 1000,
      });
      vi.advanceTimersByTime(3000);
      broken = false;
      vi.advanceTimersByTime(1000);
      stop();
      expect(rows.filter(([level]) => level === "warn").map(([, message]) => message)).toEqual(["[metrics] core heap sample failed: no heap"]);
      expect(rows.filter(([level]) => level === "info").length).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a heap row that cannot be written", () => {
  it("never throws out of the timer, even when the failure row fails too", () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const stop = startHeapLog({
        label: "core",
        read: () => heap(10),
        write: () => {
          calls += 1;
          throw new Error("log closed");
        },
        intervalMs: 1000,
      });
      expect(() => vi.advanceTimersByTime(3000)).not.toThrow();
      expect(() => stop()).not.toThrow();
      expect(calls).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
