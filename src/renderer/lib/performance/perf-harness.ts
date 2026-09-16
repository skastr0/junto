/**
 * The permanent renderer performance harness.
 *
 * `canvas-performance.ts` already carries a full recorder, and the canvas,
 * loom, ActivityMark and viewport call sites already report into it — but
 * nothing ever installed a recorder outside a unit test, so in a running app
 * every one of those calls was a no-op and the snapshot had no reader. This
 * module closes both halves: it installs the recorder when JUNTO_PERF is on
 * and prints one bounded line every 5 seconds.
 *
 * Doctrine, unchanged: with the flag off this is a strict no-op. No recorder
 * is installed, no interval is scheduled, no global is published, and every
 * `canvasPerformance.*` call stays the cheap undefined-check it is today.
 *
 * Reading it live (flag on):
 *     vellumCommandPerf.report()     // force one line now, returns the object
 *     vellumCommandPerf.snapshot()   // cumulative counters since boot
 *     vellumCommandPerf.stop()       // uninstall
 */

import {
  createCanvasPerformanceRecorder,
  installCanvasPerformanceRecorder,
  type CanvasPerformanceRecorder,
  type PerformanceSnapshot,
  type PerformanceWindow,
  type PerformanceWindowToken,
} from "./canvas-performance";
import { PERF_ENABLED } from "./perf-flag";

/** Greppable prefix; one line per interval, JSON after the space. */
export const PERF_LOG_PREFIX = "[vellum-perf]";

export const PERF_REPORT_INTERVAL_MS = 5_000;

/** Route-wire evidence is keyed per edge; only the loudest few are printed. */
const TOP_EDGE_COUNT = 5;

export type ReactProfilerBuild = "profiling" | "standard";

export type PerfReport = {
  /** Milliseconds since the harness armed. */
  readonly upMs: number;
  /** Length of the window this report covers. */
  readonly windowMs: number;
  readonly react: {
    /**
     * `false` means React's production build is running: `<Profiler>` exists
     * but never calls `onRender`, so the commit counts below are structurally
     * zero rather than measured. Never read them as "the canvas was idle".
     */
    readonly instrumented: boolean;
    readonly rootCommits: number;
    readonly canvasCommits: number;
    readonly commitMs: number;
    readonly meanCommitMs: number;
  };
  readonly loom: {
    readonly replans: number;
    readonly planMs: number;
    readonly effects: number;
    readonly obstacleWrites: number;
    readonly obstacleEqualWrites: number;
    readonly corridorWrites: number;
    readonly corridorEqualWrites: number;
  };
  readonly routeWire: {
    readonly calls: number;
    readonly byTrigger: Readonly<Record<string, number>>;
    readonly topEdges: ReadonlyArray<readonly [string, number]>;
  };
  readonly activity: {
    readonly mounted: number;
    readonly animated: number;
    readonly byMode: Readonly<Record<string, number>>;
    readonly intentionalContinuous: number;
    readonly peakAnimated: number;
    readonly mounts: number;
    readonly unmounts: number;
  };
  readonly viewport: {
    readonly busyTransitions: number;
    readonly promotions: number;
    readonly promotionMs: number;
  };
};

export type CanvasPerformanceHarness = {
  readonly enabled: boolean;
  readonly snapshot: () => PerformanceSnapshot | undefined;
  /** Close the open window, emit it, and open the next one. */
  readonly report: () => PerfReport | undefined;
  readonly stop: () => void;
};

const round = (value: number, places = 2): number => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

/** Drop zero entries so an idle line stays short and a busy one stays honest. */
const prune = (record: Readonly<Record<string, number>>): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(record)) if (value !== 0) out[key] = value;
  return out;
};

const topEdges = (
  record: Readonly<Record<string, number>>,
): ReadonlyArray<readonly [string, number]> =>
  Object.entries(record)
    .filter(([, count]) => count !== 0)
    .sort((left, right) => right[1] - left[1])
    .slice(0, TOP_EDGE_COUNT)
    .map(([edgeId, count]) => [edgeId, count] as const);

/**
 * One window becomes one report: deltas for anything that accumulates, live
 * gauges for anything that is a population.
 */
export const buildPerfReport = (
  window: PerformanceWindow,
  options: { readonly upMs: number; readonly reactBuild: ReactProfilerBuild },
): PerfReport => {
  const { delta, after } = window;
  const commits = delta.reactRootCommits + delta.reactCanvasCommits;
  return {
    upMs: round(options.upMs, 0),
    windowMs: round(window.elapsedMs, 0),
    react: {
      instrumented: options.reactBuild === "profiling",
      rootCommits: delta.reactRootCommits,
      canvasCommits: delta.reactCanvasCommits,
      commitMs: round(delta.reactCommitDurationMs),
      meanCommitMs: commits === 0 ? 0 : round(delta.reactCommitDurationMs / commits),
    },
    loom: {
      replans: delta.loomReplans,
      planMs: round(delta.loomPlanDurationMs),
      effects: delta.loomEffectExecutions,
      obstacleWrites: delta.loomObstaclePublications,
      obstacleEqualWrites: delta.loomObstacleEqualPublications,
      corridorWrites: delta.loomCorridorPublications,
      corridorEqualWrites: delta.loomCorridorEqualPublications,
    },
    routeWire: {
      calls: delta.routeWireInvocations,
      byTrigger: prune(delta.routeWireByTrigger),
      topEdges: topEdges(delta.routeWireByEdge),
    },
    activity: {
      mounted: after.activityPopulation.mounted,
      animated: after.activityPopulation.animated,
      byMode: prune(after.activityPopulation.byMode as Record<string, number>),
      intentionalContinuous: after.activityPopulation.intentionalContinuous,
      peakAnimated: after.peakActivityPopulation.animated,
      mounts: delta.activityMarkMounts,
      unmounts: delta.activityMarkUnmounts,
    },
    viewport: {
      busyTransitions: delta.viewportBusyTransitions,
      promotions: delta.viewportPromotionTransitions,
      promotionMs: round(delta.viewportPromotionMs),
    },
  };
};

export const formatPerfReport = (report: PerfReport): string =>
  `${PERF_LOG_PREFIX} ${JSON.stringify(report)}`;

const inertHarness: CanvasPerformanceHarness = {
  enabled: false,
  snapshot: () => undefined,
  report: () => undefined,
  stop: () => undefined,
};

export type HarnessOptions = {
  /**
   * Which react-dom build mounted the tree. React's production build compiles
   * `Profiler.onRender` out entirely, so the harness reports whether its React
   * numbers are measured or structurally absent instead of implying idleness.
   */
  readonly reactBuild?: ReactProfilerBuild;
  readonly intervalMs?: number;
  /** `report` is absent on the one-off arming line. */
  readonly emit?: (line: string, report?: PerfReport) => void;
  readonly recorder?: CanvasPerformanceRecorder;
  readonly now?: () => number;
  /** Test seam: default schedules on the host timer. */
  readonly schedule?: (run: () => void, intervalMs: number) => () => void;
};

const defaultSchedule = (run: () => void, intervalMs: number): (() => void) => {
  const id = setInterval(run, intervalMs);
  return () => clearInterval(id);
};

const defaultEmit = (line: string): void => {
  // The main process mirrors every renderer console message into the
  // observability ring (src/main/index.ts console-message bridge), so info is
  // both a devtools line and a durable in-app log row.
  console.info(line);
};

/**
 * Arm the harness. Returns an inert handle unless JUNTO_PERF resolved on, so
 * the caller never needs its own flag check.
 */
export const startCanvasPerformanceHarness = (
  options: HarnessOptions = {},
): CanvasPerformanceHarness => {
  if (!PERF_ENABLED) return inertHarness;

  const now = options.now ?? (() => (typeof performance?.now === "function" ? performance.now() : Date.now()));
  const intervalMs = options.intervalMs ?? PERF_REPORT_INTERVAL_MS;
  const reactBuild = options.reactBuild ?? "standard";
  const emit = options.emit ?? defaultEmit;
  const recorder = options.recorder ?? createCanvasPerformanceRecorder({ now });
  const uninstall = installCanvasPerformanceRecorder(recorder);
  const startedAtMs = now();

  let token: PerformanceWindowToken = recorder.beginWindow("interval");
  let stopped = false;

  const report = (): PerfReport | undefined => {
    if (stopped) return undefined;
    const closed = recorder.endWindow(token);
    token = recorder.beginWindow("interval");
    const built = buildPerfReport(closed, { upMs: now() - startedAtMs, reactBuild });
    emit(formatPerfReport(built), built);
    return built;
  };

  const cancel = (options.schedule ?? defaultSchedule)(() => {
    report();
  }, intervalMs);

  const harness: CanvasPerformanceHarness = {
    enabled: true,
    snapshot: () => recorder.snapshot(),
    report,
    stop: () => {
      if (stopped) return;
      stopped = true;
      cancel();
      uninstall();
    },
  };

  // The runtime reader the module never had. Publishing it is part of being
  // armed; the off path publishes nothing.
  (globalThis as { vellumCommandPerf?: CanvasPerformanceHarness }).vellumCommandPerf = harness;
  emit(`${PERF_LOG_PREFIX} armed reactBuild=${reactBuild} intervalMs=${intervalMs}`);
  return harness;
};
