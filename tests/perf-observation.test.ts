import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appMenuTemplate } from "../src/main/junto/app-menu";
import {
  heapLinesCrossed,
  processKind,
  processMetricsRow,
  startProcessMetricsLog,
  type MainHeapInput,
  type ProcessMetricInput,
} from "../src/main/junto/observability/process-metrics-log";
import { makePerfTraceRecorder, traceFileName, tracesToPrune } from "../src/main/junto/observability/perf-trace";
import { framePressureRow, scriptKey } from "../src/renderer/lib/frame-pressure-log";

const MB = 1024 * 1024;
const heap = (usedMb: number, limitMb = 4096): MainHeapInput => ({
  rss: 600 * MB,
  heapUsed: usedMb * MB,
  heapTotal: (usedMb + 50) * MB,
  external: 20 * MB,
  arrayBuffers: 5 * MB,
  heapLimit: limitMb * MB,
  nativeContexts: 1,
  detachedContexts: 0,
});
const metric = (type: string, cpu: number, kb: number, serviceName?: string): ProcessMetricInput => ({
  pid: Math.round(cpu * 100) + kb,
  type,
  ...(serviceName === undefined ? {} : { serviceName }),
  cpu: { percentCPUUsage: cpu, idleWakeupsPerSecond: 120, cumulativeCPUUsage: 42.04 },
  memory: { workingSetSize: kb, peakWorkingSetSize: kb * 2 },
});

describe("process metrics rows", () => {
  it("name utility processes by service and sort by CPU", () => {
    expect(processKind(metric("Utility", 1, 1, "Junto Core"))).toBe("Utility:Junto Core");
    expect(processKind(metric("GPU", 1, 1))).toBe("GPU");
    const row = processMetricsRow([metric("Browser", 1.04, 555_000), metric("GPU", 39.96, 216_000), metric("Tab", 31.4, 1_172_480)], heap(1024));
    expect(row.procs.map((proc) => proc.kind)).toEqual(["GPU", "Tab", "Browser"]);
    expect(row.procs[0]).toMatchObject({ cpu: 40, mb: 210.9, peakMb: 421.9, wakeups: 120, cpuTotalS: 42 });
    expect(row.main).toMatchObject({ heapUsedMb: 1024, heapLimitMb: 4096, heapUsedPct: 25 });
    expect(row.totals.cpu).toBe(72.4);
  });

  it("warn once per heap line crossed upward, and re-arm below it", () => {
    let armed: ReadonlySet<number> = new Set([0.5, 0.75]);
    let step = heapLinesCrossed(0.6, armed);
    expect(step.crossed).toEqual([0.5]);
    armed = step.armed;
    step = heapLinesCrossed(0.62, armed);
    expect(step.crossed).toEqual([]);
    step = heapLinesCrossed(0.8, step.armed);
    expect(step.crossed).toEqual([0.75]);
    step = heapLinesCrossed(0.3, step.armed);
    expect(step.crossed).toEqual([]);
    expect(heapLinesCrossed(0.55, step.armed).crossed).toEqual([0.5]);
  });

  it("write a row each interval and a last one on stop", () => {
    vi.useFakeTimers();
    try {
      const rows: Array<[string, string]> = [];
      let used = 1000;
      const stop = startProcessMetricsLog({
        appMetrics: () => [metric("GPU", 10, 100_000)],
        mainHeap: () => heap(used),
        write: (level, message) => rows.push([level, message]),
        intervalMs: 1000,
      });
      vi.advanceTimersByTime(1000);
      used = 2500;
      vi.advanceTimersByTime(1000);
      stop();
      expect(rows.filter(([, message]) => message.startsWith("[metrics] {")).length).toBe(3);
      expect(rows.filter(([level]) => level === "warn").map(([, message]) => message)).toEqual([
        "[metrics] main heap passed 50% of its limit: 2500 of 4096 MB",
      ]);
      const first = JSON.parse(rows[0]![1].slice("[metrics] ".length)) as { procs: Array<{ kind: string }> };
      expect(first.procs[0]!.kind).toBe("GPU");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("performance traces", () => {
  const dirs: Array<string> = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("name files by time and keep only the newest", () => {
    expect(traceFileName(new Date("2026-11-06T22:48:41.533Z"))).toBe("trace-2026-11-06T22-48-41Z.json");
    expect(tracesToPrune(["trace-3.json", "notes.txt", "trace-1.json", "trace-2.json"], 2)).toEqual(["trace-1.json"]);
    expect(tracesToPrune(["trace-1.json"], 2)).toEqual([]);
  });

  it("record one capture at a time into a private file", async () => {
    const home = mkdtempSync(join(tmpdir(), "junto-trace-"));
    dirs.push(home);
    const rows: Array<string> = [];
    let release: () => void = () => undefined;
    const started: Array<ReadonlyArray<string>> = [];
    const recorder = makePerfTraceRecorder({
      juntoHome: home,
      now: () => new Date("2026-11-06T22:48:41.000Z"),
      wait: () => new Promise<void>((resolve) => { release = resolve; }),
      write: (_level, message) => rows.push(message),
      tracing: {
        startRecording: async ({ included_categories }) => { started.push(included_categories); },
        stopRecording: async (path) => {
          writeFileSync(path, "{\"traceEvents\":[]}");
          return path;
        },
      },
    });
    const first = recorder.record("a test", 1);
    await vi.waitFor(() => expect(recorder.recording()).toBe(true));
    await vi.waitFor(() => expect(started.length).toBe(1));
    expect(await recorder.record("a second test", 1)).toBeUndefined();
    release();
    const path = await first;
    expect(path).toBe(join(home, "traces", "trace-2026-11-06T22-48-41Z.json"));
    expect(statSync(path!).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, "traces")).mode & 0o777).toBe(0o700);
    expect(started[0]).toContain("disabled-by-default-v8.cpu_profiler");
    expect(started[0]).toContain("viz");
    expect(readdirSync(join(home, "traces"))).toEqual(["trace-2026-11-06T22-48-41Z.json"]);
    expect(rows.some((row) => row.includes("ignored the a second test request"))).toBe(true);
    expect(recorder.recording()).toBe(false);
  });

  it("report a failed capture and free the recorder", async () => {
    const home = mkdtempSync(join(tmpdir(), "junto-trace-"));
    dirs.push(home);
    const rows: Array<string> = [];
    const recorder = makePerfTraceRecorder({
      juntoHome: home,
      wait: async () => undefined,
      write: (level, message) => rows.push(`${level} ${message}`),
      tracing: {
        startRecording: async () => { throw new Error("tracing is busy"); },
        stopRecording: async (path) => path,
      },
    });
    expect(await recorder.record("a test", 1)).toBeUndefined();
    expect(rows).toEqual(["warn [trace] capture failed: tracing is busy"]);
    expect(recorder.recording()).toBe(false);
  });

  it("is offered in the View menu of every build", () => {
    const recordTrace = vi.fn();
    for (const packaged of [true, false]) {
      const view = appMenuTemplate({ productName: "Junto", packaged, sendKey: () => undefined, recordTrace })
        .find((menu) => menu.label === "View");
      const item = (view?.submenu as Array<{ label?: string; click?: () => void }>).find((entry) => entry.label === "Record Performance Trace");
      item?.click?.();
    }
    expect(recordTrace).toHaveBeenCalledTimes(2);
  });
});

describe("long animation frame rows", () => {
  it("name scripts by invoker, function and file", () => {
    expect(scriptKey({
      duration: 1,
      invoker: "TimerHandler:setInterval",
      sourceFunctionName: "scanRows",
      sourceURL: "junto-app://app/assets/index-abc.js?v=1",
      sourceCharPosition: 1234,
    })).toBe("TimerHandler:setInterval scanRows index-abc.js@1234");
    expect(scriptKey({ duration: 1, invokerType: "event-listener", sourceFunctionName: "" })).toBe("event-listener (anonymous)");
  });

  it("sum frames and rank scripts by time", () => {
    const row = framePressureRow([
      { startTime: 0, duration: 80, blockingDuration: 30, renderStart: 60, scripts: [{ duration: 50, invoker: "a", sourceFunctionName: "f" }] },
      { startTime: 100, duration: 120, blockingDuration: 70, renderStart: 200, scripts: [
        { duration: 30, invoker: "a", sourceFunctionName: "f" },
        { duration: 60, invoker: "b", sourceFunctionName: "g" },
      ] },
    ]);
    expect(row).toEqual({
      frames: 2,
      totalMs: 200,
      blockingMs: 100,
      maxMs: 120,
      renderMs: 40,
      top: [
        { script: "a f", ms: 80, n: 2 },
        { script: "b g", ms: 60, n: 1 },
      ],
    });
  });
});
