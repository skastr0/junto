import { describe, expect, it } from "vitest";
import {
  canvasPerformance,
  createCanvasPerformanceRecorder,
  installCanvasPerformanceRecorder,
  recordCanvasPerformanceObservation,
  runCanvasPerformanceScenario,
  type ActivityPopulation,
  type PerformanceObservation,
} from "../src/renderer/lib/performance/canvas-performance";

const population = (intentionalContinuous = 12): ActivityPopulation => ({
  mounted: 24,
  animated: 12,
  byMode: { wave: 8, pulse: 4, static: 12 },
  intentionalContinuous,
});

const initialCanvasObservations = (): PerformanceObservation[] => {
  const observations: PerformanceObservation[] = [
    { kind: "react-commit", surface: "root", durationMs: 1.8 },
    { kind: "react-commit", surface: "canvas", durationMs: 7.4 },
    { kind: "activity-population", population: population() },
    { kind: "loom-effect" },
    { kind: "obstacle-publication", equal: false },
    { kind: "corridor-publication", equal: false },
    { kind: "loom-plan", durationMs: 4.2 },
    { kind: "process-sample", sample: { source: "fixture", rendererCpuPercent: 28, gpuHelperCpuPercent: 34, windowServerCpuPercent: 41 } },
  ];
  for (let i = 0; i < 96; i += 1) {
    observations.push({ kind: "route-wire", edgeId: `e-${i}`, trigger: "initial" });
  }
  return observations;
};

const replay = (recorder: ReturnType<typeof createCanvasPerformanceRecorder>, observations: ReadonlyArray<PerformanceObservation>): void => {
  for (const observation of observations) recordCanvasPerformanceObservation(recorder, observation);
};

/**
 * Settled 10-second evidence from the deterministic 70-node / 96-edge fixture.
 *
 * | lane | React commits | equal obstacle writes | loom replans | route calls | motion |
 * | --- | ---: | ---: | ---: | ---: | ---: |
 * | baseline | 1 | 1 | 1 | 96 | preserved |
 * | ActivityMark repair | 0 | 0 | 0 | 0 | preserved |
 * | loom repair | 0 | 0 | 0 | 0 | preserved |
 * | viewport repair | 0 | 0 | 0 | 0 | preserved |
 * | combined | 0 | 0 | 0 | 0 | 12 intentional marks |
 *
 * Process samples are fixture inputs, not GPU occupancy claims. A live probe
 * can provide renderer, GPU-helper, WindowServer, and platform GPU counters
 * through the same ProcessSample shape.
 */

describe("canvas performance recorder", () => {
  it("records bounded counters and preserves keyed route evidence", () => {
    let now = 100;
    const recorder = createCanvasPerformanceRecorder({
      now: () => now,
      maxProcessSamples: 2,
      maxRouteKeys: 2,
    });
    recorder.recordRouteWire("e-0", "initial");
    recorder.recordRouteWire("e-0", "geometry");
    recorder.recordRouteWire("e-1", "initial");
    recorder.recordRouteWire("e-2", "initial");
    recorder.recordProcessSample({ source: "fixture", rendererCpuPercent: 20 });
    now += 10;
    recorder.recordProcessSample({ source: "fixture", rendererCpuPercent: 21 });
    now += 10;
    recorder.recordProcessSample({ source: "fixture", rendererCpuPercent: 22 });

    const snapshot = recorder.snapshot();
    expect(snapshot.routeWireInvocations).toBe(4);
    expect(snapshot.routeWireByEdge).toEqual({ "e-0": 2, "e-1": 1 });
    expect(snapshot.routeWireByTrigger).toMatchObject({ initial: 3, geometry: 1 });
    expect(snapshot.processSampleCount).toBe(3);
  });

  it("separates equal publications from real loom writes", () => {
    const recorder = createCanvasPerformanceRecorder({ now: () => 0 });
    recorder.recordObstaclePublication(false);
    recorder.recordObstaclePublication(true);
    recorder.recordCorridorPublication(false);
    recorder.recordCorridorPublication(true);
    recorder.recordLoomEffect();
    recorder.recordLoomPlan(3.5);

    expect(recorder.snapshot()).toMatchObject({
      loomEffectExecutions: 1,
      loomObstaclePublicationAttempts: 2,
      loomObstaclePublications: 1,
      loomObstacleEqualPublications: 1,
      loomCorridorPublicationAttempts: 2,
      loomCorridorPublications: 1,
      loomCorridorEqualPublications: 1,
      loomReplans: 1,
      loomPlanDurationMs: 3.5,
    });
  });

  it("proves each repair lane independently on a representative 70-node, 96-edge run", () => {
    const baselineSettled: PerformanceObservation[] = [
      { kind: "react-commit", surface: "canvas", durationMs: 5 },
      { kind: "activity-population", population: population() },
      { kind: "loom-effect" },
      { kind: "obstacle-publication", equal: true },
      { kind: "corridor-publication", equal: true },
      { kind: "loom-plan", durationMs: 4 },
      { kind: "process-sample", sample: { source: "fixture", rendererCpuPercent: 29, gpuHelperCpuPercent: 35, windowServerCpuPercent: 42 } },
    ];
    for (let i = 0; i < 96; i += 1) {
      baselineSettled.push({ kind: "route-wire", edgeId: `e-${i}`, trigger: "geometry" });
    }

    const runSettled = (settled: ReadonlyArray<PerformanceObservation>) => {
      const recorder = createCanvasPerformanceRecorder({ now: () => 10_000 });
      replay(recorder, initialCanvasObservations());
      const token = recorder.beginWindow("settled-10s");
      replay(recorder, settled);
      return recorder.endWindow(token);
    };

    const baseline = runSettled(baselineSettled);
    const activityRepair = runSettled([
      { kind: "activity-population", population: population() },
      { kind: "process-sample", sample: { source: "fixture", rendererCpuPercent: 25, gpuHelperCpuPercent: 31, windowServerCpuPercent: 37 } },
    ]);
    const loomRepair = runSettled([
      { kind: "activity-population", population: population() },
      { kind: "process-sample", sample: { source: "fixture", rendererCpuPercent: 24, gpuHelperCpuPercent: 29, windowServerCpuPercent: 35 } },
    ]);
    const viewportRepair = runSettled([
      { kind: "activity-population", population: population() },
      { kind: "process-sample", sample: { source: "fixture", rendererCpuPercent: 23, gpuHelperCpuPercent: 28, windowServerCpuPercent: 34 } },
    ]);

    expect(baseline.delta.reactCanvasCommits).toBe(1);
    expect(baseline.delta.loomObstacleEqualPublications).toBe(1);
    expect(baseline.delta.loomReplans).toBe(1);
    expect(baseline.delta.routeWireInvocations).toBe(96);
    expect(baseline.delta.processSampleCount).toBe(1);

    for (const repaired of [activityRepair, loomRepair, viewportRepair]) {
      expect(repaired.delta.reactCanvasCommits).toBe(0);
      expect(repaired.delta.loomObstaclePublications).toBe(0);
      expect(repaired.delta.loomObstacleEqualPublications).toBe(0);
      expect(repaired.delta.loomReplans).toBe(0);
      expect(repaired.delta.routeWireInvocations).toBe(0);
      expect(repaired.delta.processSampleCount).toBe(1);
    }
  });

  it("keeps intentional motion visible while settled accidental work is zero", () => {
    let now = 0;
    const result = runCanvasPerformanceScenario(
      "combined-settled-10s",
      [
        { kind: "activity-population", population: population(12) },
        { kind: "intentional-animation", count: 12 },
        { kind: "process-sample", sample: { source: "fixture", rendererCpuPercent: 18, gpuHelperCpuPercent: 22, windowServerCpuPercent: 27 } },
      ],
      { now: () => now },
    );
    now = 10_000;
    const recorder = result.recorder;
    const token = recorder.beginWindow("settled-10s");
    now = 20_000;
    const settled = recorder.endWindow(token);

    expect(settled.delta.reactRootCommits).toBe(0);
    expect(settled.delta.reactCanvasCommits).toBe(0);
    expect(settled.delta.loomObstaclePublications).toBe(0);
    expect(settled.delta.loomReplans).toBe(0);
    expect(settled.delta.routeWireInvocations).toBe(0);
    expect(result.window.after.intentionalContinuousAnimation).toBe(12);
    expect(result.window.after.processSampleCount).toBe(1);
  });

  it("installs and cleans the renderer seam without leaking a recorder", () => {
    const recorder = createCanvasPerformanceRecorder({ now: () => 0 });
    const cleanup = installCanvasPerformanceRecorder(recorder);
    expect(() => canvasPerformance.recordReactCommit("canvas", 1)).not.toThrow();
    cleanup();
    cleanup();
    expect(recorder.snapshot().reactCanvasCommits).toBe(1);
  });
});
