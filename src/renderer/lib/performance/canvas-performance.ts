/**
 * Injectable canvas performance telemetry.
 *
 * The renderer never starts a polling loop and never writes to console from
 * this module.  Production calls are cheap no-ops until a recorder is
 * explicitly installed by a development or test harness.  The recorder is
 * deliberately bounded so a long-lived canvas cannot turn diagnostics into a
 * second performance problem.
 */

export type PerformanceClock = () => number;

export type PerformanceSurface = "root" | "canvas";

export type ActivityPopulation = {
  readonly mounted: number;
  readonly animated: number;
  readonly byMode: Readonly<Partial<Record<"wave" | "pulse" | "static", number>>>;
  /** Continuous animation that is intentional product motion. */
  readonly intentionalContinuous: number;
};

export type ProcessSample = {
  readonly atMs: number;
  /** Supporting process CPU samples, not GPU occupancy. */
  readonly rendererCpuPercent?: number;
  readonly gpuHelperCpuPercent?: number;
  readonly windowServerCpuPercent?: number;
  /** Optional platform-specific GPU counter supplied by an external probe. */
  readonly gpuOccupancyPercent?: number;
  readonly source: "probe" | "fixture";
};

export type RouteTrigger =
  | "initial"
  | "geometry"
  | "drag"
  | "viewport"
  | "edge-change"
  | "intentional-animation";

export type PerformanceSnapshot = {
  readonly atMs: number;
  readonly reactRootCommits: number;
  readonly reactCanvasCommits: number;
  readonly reactCommitDurationMs: number;
  readonly reactCommitCountBySurface: Readonly<Record<PerformanceSurface, number>>;
  readonly activityMarkMounts: number;
  readonly activityMarkUnmounts: number;
  readonly activityMarkObservations: number;
  readonly activityMarkAnimatedObservations: number;
  readonly activityPopulation: ActivityPopulation;
  readonly peakActivityPopulation: ActivityPopulation;
  readonly loomEffectExecutions: number;
  readonly loomObstaclePublicationAttempts: number;
  readonly loomObstaclePublications: number;
  readonly loomObstacleEqualPublications: number;
  readonly loomCorridorPublicationAttempts: number;
  readonly loomCorridorPublications: number;
  readonly loomCorridorEqualPublications: number;
  readonly loomReplans: number;
  readonly loomPlanDurationMs: number;
  readonly routeWireInvocations: number;
  readonly routeWireByEdge: Readonly<Record<string, number>>;
  readonly routeWireByTrigger: Readonly<Record<RouteTrigger, number>>;
  readonly viewportBusyTransitions: number;
  readonly viewportPromotionTransitions: number;
  readonly viewportPromotionMs: number;
  readonly intentionalContinuousAnimation: number;
  readonly processSampleCount: number;
};

export type PerformanceWindow = {
  readonly label: string;
  readonly startedAtMs: number;
  readonly endedAtMs: number;
  readonly elapsedMs: number;
  readonly before: PerformanceSnapshot;
  readonly after: PerformanceSnapshot;
  readonly delta: PerformanceDelta;
};

export type PerformanceWindowToken = {
  readonly label: string;
  readonly startedAtMs: number;
  readonly before: PerformanceSnapshot;
};

export type PerformanceDelta = {
  readonly reactRootCommits: number;
  readonly reactCanvasCommits: number;
  readonly reactCommitDurationMs: number;
  readonly activityMarkMounts: number;
  readonly activityMarkUnmounts: number;
  readonly activityMarkObservations: number;
  readonly activityMarkAnimatedObservations: number;
  readonly loomEffectExecutions: number;
  readonly loomObstaclePublicationAttempts: number;
  readonly loomObstaclePublications: number;
  readonly loomObstacleEqualPublications: number;
  readonly loomCorridorPublicationAttempts: number;
  readonly loomCorridorPublications: number;
  readonly loomCorridorEqualPublications: number;
  readonly loomReplans: number;
  readonly loomPlanDurationMs: number;
  readonly routeWireInvocations: number;
  readonly routeWireByEdge: Readonly<Record<string, number>>;
  readonly routeWireByTrigger: Readonly<Record<RouteTrigger, number>>;
  readonly viewportBusyTransitions: number;
  readonly viewportPromotionTransitions: number;
  readonly viewportPromotionMs: number;
  readonly intentionalContinuousAnimation: number;
  readonly processSampleCount: number;
};

export type CanvasPerformanceRecorder = {
  readonly recordReactCommit: (surface: PerformanceSurface, durationMs: number) => void;
  readonly recordActivityMount: (animated: boolean, mode?: "wave" | "pulse" | "static") => void;
  readonly recordActivityUnmount: (animated?: boolean, mode?: "wave" | "pulse" | "static") => void;
  readonly observeActivityPopulation: (population: ActivityPopulation) => void;
  readonly recordLoomEffect: () => void;
  readonly recordObstaclePublication: (equal: boolean) => void;
  readonly recordCorridorPublication: (equal: boolean) => void;
  readonly recordLoomPlan: (durationMs: number) => void;
  readonly recordRouteWire: (edgeId: string, trigger: RouteTrigger) => void;
  readonly recordViewportBusy: (busy: boolean) => void;
  readonly recordViewportPromotion: (promoted: boolean) => void;
  readonly recordViewportPromotionDuration: (durationMs: number) => void;
  readonly recordIntentionalContinuousAnimation: (count: number) => void;
  readonly recordProcessSample: (sample: Omit<ProcessSample, "atMs"> & { readonly atMs?: number }) => void;
  readonly snapshot: () => PerformanceSnapshot;
  readonly beginWindow: (label: string) => PerformanceWindowToken;
  readonly endWindow: (token: PerformanceWindowToken) => PerformanceWindow;
};

export type PerformanceObservation =
  | { readonly kind: "react-commit"; readonly surface: PerformanceSurface; readonly durationMs: number }
  | { readonly kind: "activity-mount"; readonly animated: boolean; readonly mode?: "wave" | "pulse" | "static" }
  | { readonly kind: "activity-unmount"; readonly animated?: boolean; readonly mode?: "wave" | "pulse" | "static" }
  | { readonly kind: "activity-population"; readonly population: ActivityPopulation }
  | { readonly kind: "loom-effect" }
  | { readonly kind: "obstacle-publication"; readonly equal: boolean }
  | { readonly kind: "corridor-publication"; readonly equal: boolean }
  | { readonly kind: "loom-plan"; readonly durationMs: number }
  | { readonly kind: "route-wire"; readonly edgeId: string; readonly trigger: RouteTrigger }
  | { readonly kind: "viewport-busy"; readonly busy: boolean }
  | { readonly kind: "viewport-promotion"; readonly promoted: boolean }
  | { readonly kind: "viewport-promotion-duration"; readonly durationMs: number }
  | { readonly kind: "intentional-animation"; readonly count: number }
  | { readonly kind: "process-sample"; readonly sample: Omit<ProcessSample, "atMs"> & { readonly atMs?: number } };

export type PerformanceScenarioResult = {
  readonly recorder: CanvasPerformanceRecorder;
  readonly window: PerformanceWindow;
};

type MutablePopulation = {
  mounted: number;
  animated: number;
  byMode: Record<"wave" | "pulse" | "static", number>;
  intentionalContinuous: number;
};

type MutableCounters = {
  reactRootCommits: number;
  reactCanvasCommits: number;
  reactCommitDurationMs: number;
  reactCommitCountBySurface: Record<PerformanceSurface, number>;
  activityMarkMounts: number;
  activityMarkUnmounts: number;
  activityMarkObservations: number;
  activityMarkAnimatedObservations: number;
  activityPopulation: MutablePopulation;
  peakActivityPopulation: MutablePopulation;
  loomEffectExecutions: number;
  loomObstaclePublicationAttempts: number;
  loomObstaclePublications: number;
  loomObstacleEqualPublications: number;
  loomCorridorPublicationAttempts: number;
  loomCorridorPublications: number;
  loomCorridorEqualPublications: number;
  loomReplans: number;
  loomPlanDurationMs: number;
  routeWireInvocations: number;
  routeWireByEdge: Record<string, number>;
  routeWireByTrigger: Record<RouteTrigger, number>;
  viewportBusyTransitions: number;
  viewportPromotionTransitions: number;
  viewportPromotionMs: number;
  intentionalContinuousAnimation: number;
  processSampleCount: number;
  processSamples: ProcessSample[];
};

const ROUTE_TRIGGERS: readonly RouteTrigger[] = [
  "initial",
  "geometry",
  "drag",
  "viewport",
  "edge-change",
  "intentional-animation",
];

const MAX_ROUTE_KEYS = 256;
const MAX_PROCESS_SAMPLES = 256;

const emptyPopulation = (): MutablePopulation => ({
  mounted: 0,
  animated: 0,
  byMode: { wave: 0, pulse: 0, static: 0 },
  intentionalContinuous: 0,
});

const clonePopulation = (population: MutablePopulation): MutablePopulation => ({
  mounted: population.mounted,
  animated: population.animated,
  byMode: { ...population.byMode },
  intentionalContinuous: population.intentionalContinuous,
});

const freezePopulation = (population: MutablePopulation): ActivityPopulation => ({
  mounted: population.mounted,
  animated: population.animated,
  byMode: { ...population.byMode },
  intentionalContinuous: population.intentionalContinuous,
});

const emptyCounters = (): MutableCounters => ({
  reactRootCommits: 0,
  reactCanvasCommits: 0,
  reactCommitDurationMs: 0,
  reactCommitCountBySurface: { root: 0, canvas: 0 },
  activityMarkMounts: 0,
  activityMarkUnmounts: 0,
  activityMarkObservations: 0,
  activityMarkAnimatedObservations: 0,
  activityPopulation: emptyPopulation(),
  peakActivityPopulation: emptyPopulation(),
  loomEffectExecutions: 0,
  loomObstaclePublicationAttempts: 0,
  loomObstaclePublications: 0,
  loomObstacleEqualPublications: 0,
  loomCorridorPublicationAttempts: 0,
  loomCorridorPublications: 0,
  loomCorridorEqualPublications: 0,
  loomReplans: 0,
  loomPlanDurationMs: 0,
  routeWireInvocations: 0,
  routeWireByEdge: {},
  routeWireByTrigger: {
    initial: 0,
    geometry: 0,
    drag: 0,
    viewport: 0,
    "edge-change": 0,
    "intentional-animation": 0,
  },
  viewportBusyTransitions: 0,
  viewportPromotionTransitions: 0,
  viewportPromotionMs: 0,
  intentionalContinuousAnimation: 0,
  processSampleCount: 0,
  processSamples: [],
});

const cloneRecord = <T extends Record<string, number>>(record: T): Readonly<T> => ({ ...record });

const subtractRecord = <T extends Record<string, number>>(
  after: Readonly<T>,
  before: Readonly<T>,
): Readonly<T> => {
  const result: Record<string, number> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const delta = (after[key] ?? 0) - (before[key] ?? 0);
    if (delta !== 0) result[key] = delta;
  }
  return result as T;
};

const subtract = (after: PerformanceSnapshot, before: PerformanceSnapshot): PerformanceDelta => ({
  reactRootCommits: after.reactRootCommits - before.reactRootCommits,
  reactCanvasCommits: after.reactCanvasCommits - before.reactCanvasCommits,
  reactCommitDurationMs: after.reactCommitDurationMs - before.reactCommitDurationMs,
  activityMarkMounts: after.activityMarkMounts - before.activityMarkMounts,
  activityMarkUnmounts: after.activityMarkUnmounts - before.activityMarkUnmounts,
  activityMarkObservations: after.activityMarkObservations - before.activityMarkObservations,
  activityMarkAnimatedObservations:
    after.activityMarkAnimatedObservations - before.activityMarkAnimatedObservations,
  loomEffectExecutions: after.loomEffectExecutions - before.loomEffectExecutions,
  loomObstaclePublicationAttempts:
    after.loomObstaclePublicationAttempts - before.loomObstaclePublicationAttempts,
  loomObstaclePublications: after.loomObstaclePublications - before.loomObstaclePublications,
  loomObstacleEqualPublications:
    after.loomObstacleEqualPublications - before.loomObstacleEqualPublications,
  loomCorridorPublicationAttempts:
    after.loomCorridorPublicationAttempts - before.loomCorridorPublicationAttempts,
  loomCorridorPublications: after.loomCorridorPublications - before.loomCorridorPublications,
  loomCorridorEqualPublications:
    after.loomCorridorEqualPublications - before.loomCorridorEqualPublications,
  loomReplans: after.loomReplans - before.loomReplans,
  loomPlanDurationMs: after.loomPlanDurationMs - before.loomPlanDurationMs,
  routeWireInvocations: after.routeWireInvocations - before.routeWireInvocations,
  routeWireByEdge: subtractRecord(after.routeWireByEdge, before.routeWireByEdge),
  routeWireByTrigger: subtractRecord(after.routeWireByTrigger, before.routeWireByTrigger),
  viewportBusyTransitions: after.viewportBusyTransitions - before.viewportBusyTransitions,
  viewportPromotionTransitions:
    after.viewportPromotionTransitions - before.viewportPromotionTransitions,
  viewportPromotionMs: after.viewportPromotionMs - before.viewportPromotionMs,
  intentionalContinuousAnimation:
    after.intentionalContinuousAnimation - before.intentionalContinuousAnimation,
  processSampleCount: after.processSampleCount - before.processSampleCount,
});

const defaultClock: PerformanceClock = () =>
  typeof globalThis.performance?.now === "function" ? globalThis.performance.now() : Date.now();

/** Create a recorder; pass a deterministic clock in unit tests. */
export const createCanvasPerformanceRecorder = (options?: {
  readonly now?: PerformanceClock;
  readonly maxProcessSamples?: number;
  readonly maxRouteKeys?: number;
}): CanvasPerformanceRecorder => {
  const now = options?.now ?? defaultClock;
  const maxProcessSamples = options?.maxProcessSamples ?? MAX_PROCESS_SAMPLES;
  const maxRouteKeys = options?.maxRouteKeys ?? MAX_ROUTE_KEYS;
  const counters = emptyCounters();

  const updatePeak = (): void => {
    counters.peakActivityPopulation = {
      mounted: Math.max(counters.peakActivityPopulation.mounted, counters.activityPopulation.mounted),
      animated: Math.max(counters.peakActivityPopulation.animated, counters.activityPopulation.animated),
      byMode: {
        wave: Math.max(counters.peakActivityPopulation.byMode.wave, counters.activityPopulation.byMode.wave),
        pulse: Math.max(counters.peakActivityPopulation.byMode.pulse, counters.activityPopulation.byMode.pulse),
        static: Math.max(counters.peakActivityPopulation.byMode.static, counters.activityPopulation.byMode.static),
      },
      intentionalContinuous: Math.max(
        counters.peakActivityPopulation.intentionalContinuous,
        counters.activityPopulation.intentionalContinuous,
      ),
    };
  };

  const snapshot = (): PerformanceSnapshot => ({
    atMs: now(),
    reactRootCommits: counters.reactRootCommits,
    reactCanvasCommits: counters.reactCanvasCommits,
    reactCommitDurationMs: counters.reactCommitDurationMs,
    reactCommitCountBySurface: cloneRecord(counters.reactCommitCountBySurface),
    activityMarkMounts: counters.activityMarkMounts,
    activityMarkUnmounts: counters.activityMarkUnmounts,
    activityMarkObservations: counters.activityMarkObservations,
    activityMarkAnimatedObservations: counters.activityMarkAnimatedObservations,
    activityPopulation: freezePopulation(counters.activityPopulation),
    peakActivityPopulation: freezePopulation(counters.peakActivityPopulation),
    loomEffectExecutions: counters.loomEffectExecutions,
    loomObstaclePublicationAttempts: counters.loomObstaclePublicationAttempts,
    loomObstaclePublications: counters.loomObstaclePublications,
    loomObstacleEqualPublications: counters.loomObstacleEqualPublications,
    loomCorridorPublicationAttempts: counters.loomCorridorPublicationAttempts,
    loomCorridorPublications: counters.loomCorridorPublications,
    loomCorridorEqualPublications: counters.loomCorridorEqualPublications,
    loomReplans: counters.loomReplans,
    loomPlanDurationMs: counters.loomPlanDurationMs,
    routeWireInvocations: counters.routeWireInvocations,
    routeWireByEdge: cloneRecord(counters.routeWireByEdge),
    routeWireByTrigger: cloneRecord(counters.routeWireByTrigger),
    viewportBusyTransitions: counters.viewportBusyTransitions,
    viewportPromotionTransitions: counters.viewportPromotionTransitions,
    viewportPromotionMs: counters.viewportPromotionMs,
    intentionalContinuousAnimation: counters.intentionalContinuousAnimation,
    processSampleCount: counters.processSampleCount,
  });

  const recorder: CanvasPerformanceRecorder = {
    recordReactCommit: (surface, durationMs) => {
      const duration = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0;
      counters.reactCommitDurationMs += duration;
      counters.reactCommitCountBySurface[surface] += 1;
      if (surface === "root") counters.reactRootCommits += 1;
      else counters.reactCanvasCommits += 1;
    },
    recordActivityMount: (animated, mode) => {
      counters.activityMarkMounts += 1;
      if (animated) counters.activityMarkAnimatedObservations += 1;
      counters.activityPopulation.mounted += 1;
      if (animated) counters.activityPopulation.animated += 1;
      if (mode) counters.activityPopulation.byMode[mode] += 1;
      updatePeak();
    },
    recordActivityUnmount: (animated = false, mode) => {
      counters.activityMarkUnmounts += 1;
      counters.activityPopulation.mounted = Math.max(0, counters.activityPopulation.mounted - 1);
      if (animated) counters.activityPopulation.animated = Math.max(0, counters.activityPopulation.animated - 1);
      if (mode) counters.activityPopulation.byMode[mode] = Math.max(0, counters.activityPopulation.byMode[mode] - 1);
    },
    observeActivityPopulation: (population) => {
      counters.activityMarkObservations += 1;
      if (population.animated > 0) counters.activityMarkAnimatedObservations += population.animated;
      counters.activityPopulation = {
        mounted: Math.max(0, Math.trunc(population.mounted)),
        animated: Math.max(0, Math.trunc(population.animated)),
        byMode: {
          wave: Math.max(0, Math.trunc(population.byMode.wave ?? 0)),
          pulse: Math.max(0, Math.trunc(population.byMode.pulse ?? 0)),
          static: Math.max(0, Math.trunc(population.byMode.static ?? 0)),
        },
        intentionalContinuous: Math.max(0, Math.trunc(population.intentionalContinuous)),
      };
      updatePeak();
    },
    recordLoomEffect: () => {
      counters.loomEffectExecutions += 1;
    },
    recordObstaclePublication: (equal) => {
      counters.loomObstaclePublicationAttempts += 1;
      if (equal) counters.loomObstacleEqualPublications += 1;
      else counters.loomObstaclePublications += 1;
    },
    recordCorridorPublication: (equal) => {
      counters.loomCorridorPublicationAttempts += 1;
      if (equal) counters.loomCorridorEqualPublications += 1;
      else counters.loomCorridorPublications += 1;
    },
    recordLoomPlan: (durationMs) => {
      counters.loomReplans += 1;
      counters.loomPlanDurationMs += Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0;
    },
    recordRouteWire: (edgeId, trigger) => {
      counters.routeWireInvocations += 1;
      counters.routeWireByTrigger[trigger] += 1;
      if (Object.prototype.hasOwnProperty.call(counters.routeWireByEdge, edgeId) || Object.keys(counters.routeWireByEdge).length < maxRouteKeys) {
        counters.routeWireByEdge[edgeId] = (counters.routeWireByEdge[edgeId] ?? 0) + 1;
      }
    },
    recordViewportBusy: (_busy) => {
      counters.viewportBusyTransitions += 1;
    },
    recordViewportPromotion: (_promoted) => {
      counters.viewportPromotionTransitions += 1;
    },
    recordViewportPromotionDuration: (durationMs) => {
      counters.viewportPromotionMs += Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0;
    },
    recordIntentionalContinuousAnimation: (count) => {
      const bounded = Math.max(0, Math.trunc(count));
      counters.intentionalContinuousAnimation += bounded;
      counters.activityPopulation.intentionalContinuous = bounded;
      updatePeak();
    },
    recordProcessSample: (sample) => {
      if (counters.processSamples.length >= maxProcessSamples) counters.processSamples.shift();
      counters.processSamples.push({ ...sample, atMs: sample.atMs ?? now() });
      counters.processSampleCount += 1;
    },
    snapshot,
    beginWindow: (label) => ({ startedAtMs: now(), before: snapshot(), label }),
    endWindow: (token) => {
      const after = snapshot();
      return {
        label: token.label,
        startedAtMs: token.startedAtMs,
        endedAtMs: after.atMs,
        elapsedMs: Math.max(0, after.atMs - token.startedAtMs),
        before: token.before,
        after,
        delta: subtract(after, token.before),
      };
    },
  };

  return recorder;
};

type InstallableRecorder = CanvasPerformanceRecorder | undefined;
let activeRecorder: InstallableRecorder;

/**
 * Install a recorder for a development/test run. Returns an idempotent cleanup
 * function so E2E fixtures and unit tests cannot leak telemetry between runs.
 */
export const installCanvasPerformanceRecorder = (recorder: CanvasPerformanceRecorder): (() => void) => {
  const previous = activeRecorder;
  activeRecorder = recorder;
  let cleaned = false;
  return () => {
    if (cleaned) return;
    cleaned = true;
    if (activeRecorder === recorder) activeRecorder = previous;
  };
};

export const recordCanvasPerformanceObservation = (
  recorder: CanvasPerformanceRecorder,
  observation: PerformanceObservation,
): void => {
  switch (observation.kind) {
    case "react-commit":
      recorder.recordReactCommit(observation.surface, observation.durationMs);
      return;
    case "activity-mount":
      recorder.recordActivityMount(observation.animated, observation.mode);
      return;
    case "activity-unmount":
      recorder.recordActivityUnmount(observation.animated, observation.mode);
      return;
    case "activity-population":
      recorder.observeActivityPopulation(observation.population);
      return;
    case "loom-effect":
      recorder.recordLoomEffect();
      return;
    case "obstacle-publication":
      recorder.recordObstaclePublication(observation.equal);
      return;
    case "corridor-publication":
      recorder.recordCorridorPublication(observation.equal);
      return;
    case "loom-plan":
      recorder.recordLoomPlan(observation.durationMs);
      return;
    case "route-wire":
      recorder.recordRouteWire(observation.edgeId, observation.trigger);
      return;
    case "viewport-busy":
      recorder.recordViewportBusy(observation.busy);
      return;
    case "viewport-promotion":
      recorder.recordViewportPromotion(observation.promoted);
      return;
    case "viewport-promotion-duration":
      recorder.recordViewportPromotionDuration(observation.durationMs);
      return;
    case "intentional-animation":
      recorder.recordIntentionalContinuousAnimation(observation.count);
      return;
    case "process-sample":
      recorder.recordProcessSample(observation.sample);
      return;
  }
};

/** Replay an injectable observation stream and return one bounded evidence window. */
export const runCanvasPerformanceScenario = (
  label: string,
  observations: ReadonlyArray<PerformanceObservation>,
  options?: { readonly now?: PerformanceClock },
): PerformanceScenarioResult => {
  const recorder = createCanvasPerformanceRecorder(options);
  const token = recorder.beginWindow(label);
  for (const observation of observations) recordCanvasPerformanceObservation(recorder, observation);
  return { recorder, window: recorder.endWindow(token) };
};

export const canvasPerformance = {
  recordReactCommit: (surface: PerformanceSurface, durationMs: number): void => activeRecorder?.recordReactCommit(surface, durationMs),
  recordActivityMount: (animated: boolean, mode?: "wave" | "pulse" | "static"): void => activeRecorder?.recordActivityMount(animated, mode),
  recordActivityUnmount: (animated?: boolean, mode?: "wave" | "pulse" | "static"): void => activeRecorder?.recordActivityUnmount(animated, mode),
  observeActivityPopulation: (population: ActivityPopulation): void => activeRecorder?.observeActivityPopulation(population),
  recordLoomEffect: (): void => activeRecorder?.recordLoomEffect(),
  recordObstaclePublication: (equal: boolean): void => activeRecorder?.recordObstaclePublication(equal),
  recordCorridorPublication: (equal: boolean): void => activeRecorder?.recordCorridorPublication(equal),
  recordLoomPlan: (durationMs: number): void => activeRecorder?.recordLoomPlan(durationMs),
  recordRouteWire: (edgeId: string, trigger: RouteTrigger): void => activeRecorder?.recordRouteWire(edgeId, trigger),
  recordViewportBusy: (busy: boolean): void => activeRecorder?.recordViewportBusy(busy),
  recordViewportPromotion: (promoted: boolean): void => activeRecorder?.recordViewportPromotion(promoted),
  recordViewportPromotionDuration: (durationMs: number): void => activeRecorder?.recordViewportPromotionDuration(durationMs),
  recordIntentionalContinuousAnimation: (count: number): void => activeRecorder?.recordIntentionalContinuousAnimation(count),
  recordProcessSample: (sample: Omit<ProcessSample, "atMs"> & { readonly atMs?: number }): void => activeRecorder?.recordProcessSample(sample),
};

export const performanceDelta = subtract;
