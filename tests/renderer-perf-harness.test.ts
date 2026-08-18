/**
 * The permanent renderer perf harness: flag resolution, the strict off-path
 * no-op, and the shape of the 5-second line.
 *
 * VELLUM_PERF is frozen at module load (a boot-path flag must never re-read
 * storage on a render path), so each on/off case resets the module graph and
 * re-imports — that is the only way to exercise both paths honestly.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const FLAG = "VELLUM_PERF";

type HarnessModule = typeof import("../src/renderer/lib/performance/perf-harness");
type RecorderModule = typeof import("../src/renderer/lib/performance/canvas-performance");
type FlagModule = typeof import("../src/renderer/lib/performance/perf-flag");

const loadModules = async (): Promise<{
  readonly harness: HarnessModule;
  readonly recorder: RecorderModule;
  readonly flag: FlagModule;
}> => {
  vi.resetModules();
  const [harness, recorder, flag] = await Promise.all([
    import("../src/renderer/lib/performance/perf-harness"),
    import("../src/renderer/lib/performance/canvas-performance"),
    import("../src/renderer/lib/performance/perf-flag"),
  ]);
  return { harness, recorder, flag };
};

afterEach(() => {
  delete process.env[FLAG];
  delete (globalThis as { VELLUM_PERF?: unknown }).VELLUM_PERF;
  delete (globalThis as { vellumCommandPerf?: unknown }).vellumCommandPerf;
  vi.unstubAllGlobals();
});

describe("VELLUM_PERF flag", () => {
  it("stays off with no source set", async () => {
    const { flag } = await loadModules();
    expect(flag.PERF_ENABLED).toBe(false);
    expect(flag.resolvePerfFlag()).toBe(false);
  });

  it("accepts the documented truthy spellings and rejects the rest", async () => {
    const { flag } = await loadModules();
    for (const value of ["1", "on", "true", "yes", "Y", " TRUE "]) {
      process.env[FLAG] = value;
      expect(flag.resolvePerfFlag()).toBe(true);
    }
    for (const value of ["0", "off", "false", "", "no"]) {
      process.env[FLAG] = value;
      expect(flag.resolvePerfFlag()).toBe(false);
    }
  });

  it("prefers an injected global over the environment", async () => {
    const { flag } = await loadModules();
    process.env[FLAG] = "0";
    (globalThis as { VELLUM_PERF?: unknown }).VELLUM_PERF = true;
    expect(flag.resolvePerfFlag()).toBe(true);
  });

  it("reads localStorage, the only source that survives a restart", async () => {
    const { flag } = await loadModules();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => (key === FLAG ? "1" : null),
    });
    expect(flag.resolvePerfFlag()).toBe(true);
  });

  it("never throws when storage access is denied", async () => {
    const { flag } = await loadModules();
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("access denied");
      },
    });
    expect(flag.resolvePerfFlag()).toBe(false);
  });
});

describe("harness with the flag off", () => {
  it("installs nothing, schedules nothing, and publishes nothing", async () => {
    const { harness, recorder } = await loadModules();
    const schedule = vi.fn(() => () => undefined);
    const emit = vi.fn();

    const started = harness.startCanvasPerformanceHarness({ schedule, emit });

    expect(started.enabled).toBe(false);
    expect(started.snapshot()).toBeUndefined();
    expect(started.report()).toBeUndefined();
    expect(schedule).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
    expect((globalThis as { vellumCommandPerf?: unknown }).vellumCommandPerf).toBeUndefined();

    // The call sites stay the no-op they are in production: with no recorder
    // installed, a probe recorder created afterwards sees nothing.
    recorder.canvasPerformance.recordReactCommit("canvas", 12);
    recorder.canvasPerformance.recordLoomPlan(4);
    const probe = recorder.createCanvasPerformanceRecorder({ now: () => 0 });
    expect(probe.snapshot().reactCanvasCommits).toBe(0);
    expect(probe.snapshot().loomReplans).toBe(0);
  });
});

describe("harness with the flag on", () => {
  it("installs the recorder so existing call sites record", async () => {
    process.env[FLAG] = "1";
    const { harness, recorder } = await loadModules();
    const started = harness.startCanvasPerformanceHarness({
      schedule: () => () => undefined,
      emit: () => undefined,
    });

    expect(started.enabled).toBe(true);
    recorder.canvasPerformance.recordReactCommit("canvas", 12);
    recorder.canvasPerformance.recordReactCommit("root", 3);
    recorder.canvasPerformance.recordLoomPlan(4);
    recorder.canvasPerformance.recordRouteWire("edge-a", "geometry");

    const snapshot = started.snapshot();
    expect(snapshot?.reactCanvasCommits).toBe(1);
    expect(snapshot?.reactRootCommits).toBe(1);
    expect(snapshot?.loomReplans).toBe(1);
    expect(snapshot?.routeWireInvocations).toBe(1);

    started.stop();
  });

  it("schedules one report every five seconds and emits a parseable line", async () => {
    process.env[FLAG] = "1";
    const { harness, recorder } = await loadModules();
    let scheduled: (() => void) | undefined;
    let intervalMs = 0;
    const lines: string[] = [];
    let clock = 0;

    const started = harness.startCanvasPerformanceHarness({
      now: () => clock,
      schedule: (run, ms) => {
        scheduled = run;
        intervalMs = ms;
        return () => undefined;
      },
      emit: (line) => lines.push(line),
      reactBuild: "profiling",
    });

    expect(intervalMs).toBe(harness.PERF_REPORT_INTERVAL_MS);
    expect(harness.PERF_REPORT_INTERVAL_MS).toBe(5_000);
    expect(lines[0]).toContain("armed reactBuild=profiling");

    recorder.canvasPerformance.recordReactCommit("canvas", 8);
    recorder.canvasPerformance.recordReactCommit("canvas", 4);
    recorder.canvasPerformance.recordActivityMount(true, "wave");
    recorder.canvasPerformance.recordRouteWire("edge-a", "drag");
    recorder.canvasPerformance.recordRouteWire("edge-a", "drag");
    recorder.canvasPerformance.recordRouteWire("edge-b", "viewport");
    clock = 5_000;
    scheduled?.();

    const line = lines.at(-1) ?? "";
    expect(line.startsWith(`${harness.PERF_LOG_PREFIX} `)).toBe(true);
    const report = JSON.parse(line.slice(harness.PERF_LOG_PREFIX.length + 1));
    expect(report.windowMs).toBe(5_000);
    expect(report.react).toEqual({
      instrumented: true,
      rootCommits: 0,
      canvasCommits: 2,
      commitMs: 12,
      meanCommitMs: 6,
    });
    expect(report.routeWire.calls).toBe(3);
    expect(report.routeWire.byTrigger).toEqual({ drag: 2, viewport: 1 });
    expect(report.routeWire.topEdges).toEqual([
      ["edge-a", 2],
      ["edge-b", 1],
    ]);
    expect(report.activity.mounted).toBe(1);
    expect(report.activity.animated).toBe(1);
    expect(report.activity.byMode).toEqual({ wave: 1 });

    started.stop();
  });

  it("reports a window delta, never a running total", async () => {
    process.env[FLAG] = "1";
    const { harness, recorder } = await loadModules();
    let scheduled: (() => void) | undefined;
    const reports: Array<Record<string, never>> = [];
    let clock = 0;

    const started = harness.startCanvasPerformanceHarness({
      now: () => clock,
      schedule: (run) => {
        scheduled = run;
        return () => undefined;
      },
      emit: (_line, report) => {
        if (report) reports.push(report as unknown as Record<string, never>);
      },
    });

    recorder.canvasPerformance.recordLoomPlan(2);
    clock = 5_000;
    scheduled?.();
    clock = 10_000;
    scheduled?.();

    expect(reports).toHaveLength(2);
    expect((reports[0] as unknown as { loom: { replans: number } }).loom.replans).toBe(1);
    expect((reports[1] as unknown as { loom: { replans: number } }).loom.replans).toBe(0);
    // Cumulative state stays available through the runtime reader.
    expect(started.snapshot()?.loomReplans).toBe(1);

    started.stop();
  });

  it("marks React numbers as uninstrumented on a stock production build", async () => {
    process.env[FLAG] = "1";
    const { harness } = await loadModules();
    let scheduled: (() => void) | undefined;
    const lines: string[] = [];

    const started = harness.startCanvasPerformanceHarness({
      now: () => 0,
      schedule: (run) => {
        scheduled = run;
        return () => undefined;
      },
      emit: (line) => lines.push(line),
      reactBuild: "standard",
    });
    scheduled?.();

    const report = JSON.parse((lines.at(-1) ?? "").slice(harness.PERF_LOG_PREFIX.length + 1));
    expect(report.react.instrumented).toBe(false);
    started.stop();
  });

  it("publishes a runtime reader and takes it back on stop", async () => {
    process.env[FLAG] = "1";
    const { harness, recorder } = await loadModules();
    const started = harness.startCanvasPerformanceHarness({
      schedule: () => () => undefined,
      emit: () => undefined,
    });

    const published = (globalThis as { vellumCommandPerf?: { snapshot: () => unknown } })
      .vellumCommandPerf;
    expect(published).toBeDefined();
    expect(published?.snapshot()).toBeDefined();

    started.stop();
    // After stop the recorder is uninstalled: call sites go back to no-ops.
    recorder.canvasPerformance.recordLoomPlan(9);
    expect(started.snapshot()?.loomReplans).toBe(0);
    expect(started.report()).toBeUndefined();
  });
});
