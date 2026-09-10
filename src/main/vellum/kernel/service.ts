// KernelService — the Effect Tag + Live layer that runs kernel evaluation
// continuously over EVERY hydrated canvas, window-optional. This module owns
// lifecycle (hydration, doc resync, the 30s safety interval) and binds
// cycle.ts's injectable seams to concrete main-side collaborators
// (CanvasesService, timer scheduler, factory claim delivery).
//
// Region Pulse delivery / arming product path is retired — repository arm/
// debug-pulse methods remain for schema-identity tests only.
//
// cycle.ts/evaluate.ts are the pure loop + evaluator; this file is the only
// thing that binds their `__*ForTest`-named seams to something real. Despite
// the name, those setters ARE the production injection points — cycle.ts
// exposes no separately-named "prod" variant, by design.
//
// V4-KERNEL + V4-PROGRAM (docs/END_STATE-effect-v4-IRON.md §P3/P5 + migration/runtime.md):
// kernel never owns Runtime/Effect promise entry. Domain Effects exit only
// through the host injected at start() from AppRuntime / RemoteRuntime
// (main boot): runPromise for Promise seams, runFork for the factory program.
// Factory control (cycle / claim / deliver / hydrate) is Effect.gen — not an
// async Promise control plane. Importing AppRuntime here is forbidden
// (circular: RootLayer includes KernelLive).

import { createHash } from "node:crypto";
import { Cause, Context, Effect, Layer, Schema } from "effect";
import type { CanvasDoc, CanvasNode } from "@shared/canvas";
import { effectTasksCreateToWorkArgs } from "@shared/node-insert";
import { actorDeliverySurfaceOf } from "@shared/actor-surface";
import type { AgentSeatStateEvent } from "@shared/agent-seat-state";
import type { ActorRefResolver } from "@shared/attention";
import { identityHints } from "@shared/connections";
import type { ServiceCheck } from "@shared/contracts";
import {
  DEFAULT_STATION_HOST_ID,
  type StationRole,
} from "@shared/station";
import { buildFactoryClaimPrompt } from "@shared/factory-claim-prompt";
import { injectionSupervisor } from "../term/injection-supervisor";
import {
  claimedByOf,
  makeUserMessage,
  taskReleaseBoundary,
} from "@shared/task";
import { boardContractOf, taskAdmissionState } from "@shared/rules";
import { ulid } from "ulid";
import type { Task } from "@shared/work-model";
import type { InstallationId } from "@shared/installation-id";
import type { ActorSeatId } from "@shared/actor-seat";
import {
  HostId,
  type HostId as HostIdValue,
} from "@shared/remote-hosts";
import {
  IntentFactBasis,
  type ActorRef,
  type SinkRef,
} from "@shared/work-protocol";
import type {
  KernelSnapshot,
  WatcherRuntimeState,
} from "@shared/ipc";
import { CanvasesService } from "../canvases";
import { SnapshotsService } from "../snapshots";
import { PausePlane } from "../pause-plane";
import { SchedulerRepository } from "../scheduler/repository";
import { deriveActorSeatId } from "../station/actor-seat-compiler";
import { StationFleetTargetRepository } from "../station/fleet-target-repository";
import { StationRepository } from "../station/repository";
import { StationLivePeerRegistry } from "../station/session-registry";
import {
  actorsNeedingWake,
  isClaimableTaskSink,
  selectFactoryClaims,
} from "@shared/factory-tick";
import { seatPaused } from "@shared/pause";
import { WorkService } from "../work/service";
import {
  ensureManagedSeatRunning,
  isManagedSeatRuntimeLocal,
  localManagedSeatReadyForClaim,
  type ManagedSeatRuntimeAuthority,
} from "../term/ensure-managed-seat";
import { seatStateRuntime } from "../term/agent-state";
import { ActorSeatOccupy } from "../term/actor-seat-occupy";
import {
  managedPulseDeliver,
  subscribeManagedPulseReady,
} from "../term/managed-pulse-bridge";
import { WorkRepository } from "../work/repository";
import { subscribeSeatBlocks } from "../work/blocked-seat";
import {
  applyNodeFlag,
  checkTimers,
  clearRuntimeFlag,
  getExecutionByCanvas,
  getNextFire,
  getRuntimeFlagOverrides,
  getWatchers,
  manualSchedulerFire,
  purgeCanvasMemory,
  reconcileLiveCanvasMemory,
  runEvaluationCycle,
  setActorRefResolver,
  setDocs,
  setRuntimeFlag,
  setStationScope,
  __setAutomationGateForTest,
  __setFlagWriterForTest,
  __setSnapshotsForTest,
  __setTimerSchedulerForTest,
  setPageLoadDeps,
} from "./cycle";
import { setSchedulerEffectDeps } from "./effects";
import {
  makeKernelTickScheduler,
  type KernelTickScheduler,
  type LaneFailure,
  type LaneOutcome,
  type LaneOverrun,
  type LaneResume,
  type TickTimerCancel,
} from "./tick";
import { noteSyncSpan } from "../observability/main-thread-budget";
import type { EtherFlag } from "@shared/canvas";
import { mainAuthoringGate } from "../main-authoring-gate";

export class KernelService extends Context.Service<KernelService,
  {
    readonly doctor: Effect.Effect<ServiceCheck>;
    /**
     * Start the local managed seat for one delivery target when it is still
     * lazy. The caller must already have resolved the target through a
     * delivery surface; this method re-reads the authoritative canvas and
     * re-proves station locality before creating a PTY.
     */
    readonly wakeManagedSeat: (
      canvasName: string,
      nodeId: string,
    ) => Promise<boolean>;
    // Begin hydration + the evaluation loop. Idempotent, matching
    // CanvasesService.start()/SnapshotsService.start().
    // Host supplies ManagedRuntime entry (AppRuntime / RemoteRuntime).
    readonly start: (host: KernelHost) => void;
    // Irreversibly stop admitting new kernel work. Existing terminal/agent
    // processes are deliberately untouched; work admitted before the cut may
    // settle, but no later cycle, claim, or seat start may begin.
    readonly suspend: () => void;
    // Synchronous read of the current wire snapshot — used for getKernelState's
    // initial-hydrate answer.
    readonly getSnapshot: () => KernelSnapshot;
    // Pushed on cycle end — never per-watcher.
    readonly subscribe: (listener: (snapshot: KernelSnapshot) => void) => () => void;
    /** Fire one selected scheduler's outbound does edges (operator Fire now / agent relay.trigger). */
    readonly manualFire: (input: {
      readonly canvasName: string;
      readonly sourceNodeId: string;
      readonly kind?: "relay" | "cron" | "gauge";
    }) => Promise<
      | {
          readonly ok: true;
          readonly sourceNodeId: string;
          readonly kind: "relay" | "cron" | "gauge";
          readonly applied: number;
          readonly message: string;
        }
      | { readonly ok: false; readonly message: string }
    >;
    /**
     * Demand a coalesced evaluation pass (page load ok/fail, external sensors).
     * No-op until start(); ignored after suspend.
     */
    readonly requestCycle: () => void;
    /**
     * Bind the live browser page readiness map for page→relay watch.
     * Call after browser composition starts; pass undefined to clear.
     */
    readonly setPageLoadProvider: (
      snapshot:
        | (() => ReadonlyMap<
            string,
            import("@shared/scheduler-effects").PageLoadStatus
          >)
        | undefined,
    ) => void;
  }>()("@vellum/KernelService") {}

const SAFETY_INTERVAL_MS = 30_000;

const SEAT_GENERATION_WAKE_REASONS = new Set([
  "generation_bound",
  "generation_replaced",
  "binding_reconfigured",
]);

/**
 * Only lifecycle changes that can make durable work progress wake the kernel.
 * Stable working/attention observations are presentation state and must not
 * turn terminal output into an evaluation loop.
 */
export const kernelCycleNeededForSeatEvent = (
  event: AgentSeatStateEvent,
): boolean =>
  event.state === "idle" ||
  event.state === "gone" ||
  (event.state === "unknown" &&
    SEAT_GENERATION_WAKE_REASONS.has(event.reason));

type SeatStateSubscribe = (
  listener: (event: AgentSeatStateEvent) => void,
) => () => void;

export const subscribeKernelSeatWake = (
  subscribe: SeatStateSubscribe,
  scheduleCycle: () => void,
): (() => void) =>
  subscribe((event) => {
    if (kernelCycleNeededForSeatEvent(event)) scheduleCycle();
  });

type PauseSubscribe = (
  listener: (canvasName: string) => void,
) => () => void;

/** Every authoritative play/pause transition invalidates kernel scheduling. */
export const subscribeKernelPauseWake = (
  subscribe: PauseSubscribe,
  scheduleCycle: () => void,
): (() => void) => subscribe(() => scheduleCycle());

/**
 * Keep the kernel's hot Work projection at the exact claim result.
 *
 * WorkService already returns the post-transaction hydrated document. Retain
 * it before the delivery phase so a claim can wake its seat in this cycle
 * instead of waiting for the repository notification/resync repair cycle.
 */
export const retainSuccessfulClaimProjection = (
  documents: Map<string, CanvasDoc>,
  canvasName: string,
  result: { readonly ok: boolean; readonly doc?: CanvasDoc },
): boolean => {
  if (!result.ok || result.doc === undefined) return false;
  documents.set(canvasName, result.doc);
  return true;
};

/** The simulation lane's single key: one repair pass over the whole world. */
export const KERNEL_CYCLE_KEY = "cycle";
/** The housekeeping lane's watchdog key. */
export const KERNEL_SAFETY_KEY = "safety-sweep";

/** Immediate-lane key for one canvas whose authoritative document changed. */
export const kernelResyncKey = (canvasName: string): string =>
  `canvas:${canvasName}`;

/** Inverse of `kernelResyncKey`. Undefined for any other immediate-lane key. */
export const kernelResyncCanvasName = (key: string): string | undefined =>
  key.startsWith("canvas:") ? key.slice("canvas:".length) : undefined;

export type KernelLaneWork = {
  /** One full evaluation pass. The simulation lane's only work. */
  readonly runCycle: Effect.Effect<void, unknown>;
  /** Re-read one canvas whose authority committed. The immediate lane's work. */
  readonly resyncCanvas: (canvasName: string) => Effect.Effect<void, unknown>;
  readonly fork: <A, E>(effect: Effect.Effect<A, E>) => void;
  readonly onError?: (label: string, error: unknown) => void;
};

export type KernelLaneOptions = {
  readonly now?: () => number;
  readonly setTimer?: (delayMs: number, run: () => void) => TickTimerCancel;
  readonly onFailure?: (failure: LaneFailure) => void;
  readonly onOverrun?: (overrun: LaneOverrun) => void;
};

/**
 * The kernel's three lanes.
 *
 * Replaces the old boolean-pair coalescer, which re-ran a full world pass the
 * instant the previous one finished whenever any event had arrived during it
 * — an unbounded loop with no floor and no bound on how long one pass blocks.
 *
 * | lane         | key(s)                | why it sits there                  |
 * |--------------|-----------------------|------------------------------------|
 * | immediate    | one per dirty canvas  | the operator's own commit; a burst  |
 * |              |                       | on one canvas is now ONE re-read    |
 * | simulation   | `cycle`               | claim selection, delivery, wake     |
 * | housekeeping | `safety-sweep`        | the 30s repair watchdog             |
 *
 * The floor is spacing between two slices of the same lane, not latency added
 * to a wake: a lane idle longer than its floor runs on the next turn of the
 * loop, so an isolated event keeps today's latency and only a burst is paced.
 *
 * V4-PROGRAM: the cycle is an Effect; the host forks it (AppRuntime.runFork),
 * and the lane is reopened from Effect.ensuring — never Promise.then/finally
 * on the factory control path.
 */
export const makeKernelLaneScheduler = (
  work: KernelLaneWork,
  options: KernelLaneOptions = {},
): KernelTickScheduler => {
  const onError =
    work.onError ??
    ((label: string, error: unknown) => {
      console.error(`[kernel] ${label} failed:`, error);
    });

  /**
   * Hand an Effect to the host and let its completion reopen the lane. The
   * cause is squashed and reported here rather than raised into the lane's
   * requeue path: a failed pass is repaired by the next authoritative event or
   * the safety sweep, exactly as it was before lanes existed. Quarantining the
   * one key that drives the whole factory would be a far worse failure.
   */
  const forkLane = (
    label: string,
    effect: Effect.Effect<void, unknown>,
    resume: LaneResume,
  ): LaneOutcome => {
    work.fork(
      effect.pipe(
        Effect.catchCause((cause) => {
          onError(label, Cause.squash(cause));
          return Effect.void;
        }),
        Effect.ensuring(Effect.sync(() => resume())),
      ),
    );
    return "suspended";
  };

  const scheduler: KernelTickScheduler = makeKernelTickScheduler({
    lanes: {
      immediate: {
        process: (key, resume) => {
          const canvasName = kernelResyncCanvasName(key);
          if (canvasName === undefined) return "done";
          return forkLane(
            `canvas resync ${canvasName}`,
            work.resyncCanvas(canvasName),
            resume,
          );
        },
      },
      simulation: {
        process: (_key, resume) =>
          forkLane("evaluation cycle", work.runCycle, resume),
      },
      housekeeping: {
        // Repair/watchdog only. It marks the cycle rather than running one, so
        // a sweep that lands while a pass is already in flight coalesces into
        // that pass instead of queueing a second one.
        process: () => {
          scheduler.mark("simulation", KERNEL_CYCLE_KEY);
          return "done";
        },
      },
    },
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.setTimer === undefined ? {} : { setTimer: options.setTimer }),
    ...(options.onFailure === undefined
      ? {}
      : { onFailure: options.onFailure }),
    onOverrun:
      options.onOverrun ??
      ((overrun) => {
        noteSyncSpan(`kernel.tick.${overrun.lane}`, overrun.ms, overrun.key);
      }),
  });

  return scheduler;
};

// Splits a `${canvasName}::${id}` module-memory key back into its parts.
// Canvas names are restricted to [a-z0-9-] (canvases.ts NAME_PATTERN) and
// node/region ids never contain "::", so the first occurrence is always the
// namespace boundary.
const splitNamespacedKey = (key: string): readonly [canvasName: string, id: string] | undefined => {
  const idx = key.indexOf("::");
  if (idx < 0) return undefined;
  return [key.slice(0, idx), key.slice(idx + 2)];
};

type CanvasesShape = Context.Service.Shape<typeof CanvasesService>;
type SnapshotsShape = Context.Service.Shape<typeof SnapshotsService>;
type PauseShape = Context.Service.Shape<typeof PausePlane>;
type SchedulerShape = Context.Service.Shape<typeof SchedulerRepository>;
type FleetTargetsShape = Context.Service.Shape<
  typeof StationFleetTargetRepository
>;
type StationsShape = Context.Service.Shape<typeof StationRepository>;
type LivePeersShape = Context.Service.Shape<typeof StationLivePeerRegistry>;
type WorkShape = Context.Service.Shape<typeof WorkService>;
type WorkRepositoryShape = Context.Service.Shape<typeof WorkRepository>;
type KernelServiceShape = Context.Service.Shape<typeof KernelService>;

/**
 * Host-owned Effect entry for kernel (AppRuntime / RemoteRuntime).
 * Bound once at start() from main boot — never constructed inside kernel.
 *
 * - runPromise: Promise seams (timer scheduler inject, rare host bridges)
 * - runFork: factory program (hydration + coalesced evaluation cycle)
 */
export type KernelHost = {
  readonly runPromise: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
  readonly runFork: <A, E>(effect: Effect.Effect<A, E>) => void;
};

/** @deprecated Prefer KernelHost — kept for call-site migration clarity only. */
export type KernelHostRun = KernelHost["runPromise"];

type ActiveStationScope =
  | {
      readonly role: "";
      readonly hostId: typeof DEFAULT_STATION_HOST_ID;
    }
  | {
      readonly role: StationRole;
      readonly hostId: string;
      readonly installationId: InstallationId;
    };

const refreshStationScope = (
  stations: StationsShape,
  commit: () => boolean = () => true,
): Effect.Effect<ActiveStationScope> =>
  Effect.gen(function* () {
    const current = yield* Effect.result(
      Effect.all({
        installationId: stations.installationId,
        configuration: stations.configuration,
      }),
    );
    if (current._tag === "Failure") {
      // Fail closed: unreadable settings never mint Command Center authority.
      const scope = {
        hostId: DEFAULT_STATION_HOST_ID,
        role: "",
      } satisfies ActiveStationScope;
      if (commit()) setStationScope(scope);
      return scope;
    }
    if (current.success.configuration === undefined) {
      const scope = {
        hostId: DEFAULT_STATION_HOST_ID,
        role: "",
      } satisfies ActiveStationScope;
      if (commit()) setStationScope(scope);
      return scope;
    }
    const scope = {
      installationId: current.success.installationId,
      hostId: current.success.configuration.configuration.hostId,
      role: current.success.configuration.configuration.role,
    } satisfies ActiveStationScope;
    if (commit()) setStationScope(scope);
    return scope;
  });

const actorRefKey = (canvasName: string, nodeId: string): string =>
  `${canvasName}\u0000${nodeId}`;

const actorSeatCanvasKey = (
  seatId: ActorSeatId,
  canvasName: string,
): string => `${seatId}\u0000${canvasName}`;

type ActiveActorRegistry = {
  readonly resolve: ActorRefResolver;
  readonly actorOnCanvas: (
    seatId: ActorSeatId,
    canvasName: string,
  ) => ActorRef | undefined;
};

/**
 * Convert the compiler-owned portfolio identity surface into fail-closed
 * runtime lookups. Any duplicate reference is ambiguous and therefore absent.
 */
export const activeActorRegistry = (
  actorRefs: ReadonlyArray<ActorRef>,
): ActiveActorRegistry => {
  const byReference = new Map<string, ActorRef | null>();
  const bySeatCanvas = new Map<string, ActorRef | null>();
  const insert = (
    map: Map<string, ActorRef | null>,
    key: string,
    actor: ActorRef,
  ): void => {
    map.set(key, map.has(key) ? null : actor);
  };
  for (const actor of actorRefs) {
    insert(
      byReference,
      actorRefKey(actor.canvasName, actor.nodeId),
      actor,
    );
    insert(
      bySeatCanvas,
      actorSeatCanvasKey(actor.seatId, actor.canvasName),
      actor,
    );
  }
  return {
    resolve: ({ canvasName, nodeId }) =>
      byReference.get(actorRefKey(canvasName, nodeId)) ?? undefined,
    actorOnCanvas: (seatId, canvasName) =>
      bySeatCanvas.get(actorSeatCanvasKey(seatId, canvasName)) ?? undefined,
  };
};

const runtimeAuthority = (
  scope: ActiveStationScope,
  registry: ActiveActorRegistry,
  canvasName: string,
  node: CanvasNode,
): ManagedSeatRuntimeAuthority | undefined => {
  if (scope.role === "") return undefined;
  const actor = registry.resolve({ canvasName, nodeId: node.id });
  return actor === undefined
    ? undefined
    : {
        actor,
        installationId: scope.installationId,
        hostId: scope.hostId,
      };
};

type ActorAvailability = {
  readonly isLocalSeatReady: (bindingId: string) => boolean;
  readonly installationForHost: (
    hostId: HostIdValue,
  ) => Effect.Effect<InstallationId | undefined, unknown>;
  readonly isLive: (
    hostId: HostIdValue,
    installationId: InstallationId,
  ) => Effect.Effect<boolean, unknown>;
};

/**
 * Selection admission is deliberately stricter than eventual delivery:
 * Command Center never picks an offline Remote actor and queues future work.
 * The later WorkService reservation still holds a live-session witness across
 * its SQLite transaction, closing the check/use race at the authority seam.
 */
export const actorSeatSelectableNow = (
  canvasName: string,
  node: CanvasNode,
  actor: ActorRef,
  scope: Exclude<ActiveStationScope, { readonly role: "" }>,
  availability: ActorAvailability,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const localAuthority = {
      actor,
      installationId: scope.installationId,
      hostId: scope.hostId,
    } satisfies ManagedSeatRuntimeAuthority;
    if (isManagedSeatRuntimeLocal(canvasName, node, localAuthority)) {
      const surface = actorDeliverySurfaceOf(node);
      return (
        surface?._tag === "managedAgent" &&
        availability.isLocalSeatReady(surface.bindingId)
      );
    }
    if (scope.role !== "command-center") return false;

    const surface = actorDeliverySurfaceOf(node);
    if (surface?._tag !== "managedAgent") return false;
    const decodedHost = Schema.decodeUnknownResult(HostId)(surface.hostId);
    if (decodedHost._tag === "Failure") return false;
    const installationResult = yield* Effect.result(
      availability.installationForHost(decodedHost.success),
    );
    if (installationResult._tag === "Failure") return false;
    const installationId = installationResult.success;
    if (
      installationId === undefined ||
      deriveActorSeatId(installationId, surface.bindingId) !== actor.seatId
    ) {
      return false;
    }
    const liveResult = yield* Effect.result(
      availability.isLive(decodedHost.success, installationId),
    );
    return liveResult._tag === "Success" && liveResult.success;
  });

/** Stable restart-safe identity for one managed task-start prompt. */
export const managedTaskDeliveryId = (
  sink: SinkRef,
  taskId: string,
  actorSeatId: ActorSeatId,
  claimBoundaryMessageId: string,
): string =>
  `delivery_${createHash("sha256")
    .update(
      JSON.stringify([
        "vellum/managed-task-delivery/v1",
        sink.canvasName,
        sink.nodeId,
        taskId,
        actorSeatId,
        claimBoundaryMessageId,
      ]),
      "utf8",
    )
    .digest("hex")}`;

// Claim delivery never gates on a prior `/compact` harness turn. Optional
// post-complete compaction is a separate product surface if reintroduced —
// not a claim-path receipt (see buildFactoryClaimPrompt + factory physics test).

const makeKernelService = (
  canvases: CanvasesShape,
  snapshots: SnapshotsShape,
  pause: PauseShape,
  scheduler: SchedulerShape,
  fleetTargets: FleetTargetsShape,
  stations: StationsShape,
  livePeers: LivePeersShape,
  work: WorkShape,
  workRepository: WorkRepositoryShape,
  actorSeatOccupy: Context.Service.Shape<typeof ActorSeatOccupy>,
): KernelServiceShape => {
  const docs = new Map<string, CanvasDoc>();
  const snapshotListeners = new Set<(snapshot: KernelSnapshot) => void>();

  // Host runners bound on first start() from AppRuntime / RemoteRuntime.
  let host: KernelHost | undefined;
  const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => {
    if (host === undefined) {
      return Promise.reject(
        new Error(
          "[kernel] host Effect runner unbound — start(host) from main boot only",
        ),
      );
    }
    return host.runPromise(effect);
  };
  const fork = <A, E>(effect: Effect.Effect<A, E>): void => {
    if (host === undefined) {
      console.error(
        "[kernel] host Effect fork unbound — start(host) from main boot only",
      );
      return;
    }
    host.runFork(effect);
  };

  // Suspension is monotonic. The generation closes async check/use gaps: every
  // operation captures the current value at admission and checks it again at
  // later mutation boundaries. There is intentionally no resume path — a
  // new process starts a fresh KernelService.
  let suspended = false;
  let lifecycleGeneration = 0;
  const activeGeneration = (): number => lifecycleGeneration;
  const generationIsActive = (generation: number): boolean =>
    !suspended && generation === lifecycleGeneration;
  let lifecycleCleanups: Array<() => void> = [];
  let safetyInterval: ReturnType<typeof setInterval> | undefined;
  // The three lanes. Built once below, beside the cycle they drive; stopped by
  // clearLifecycleScheduling, which has no resume path.
  let kernelTick: KernelTickScheduler | undefined;
  const reclaimCooldowns = new Map<
    string,
    {
      readonly expiresAt: number;
      readonly timer: ReturnType<typeof setTimeout>;
    }
  >();
  let wakeAfterReclaimGrace = (): void => {};

  const reclaimCooldownKey = (
    canvasName: string,
    sinkNodeId: string,
    taskId: string,
    boundaryMessageId: string,
  ): string =>
    `${canvasName}\0${sinkNodeId}\0${taskId}\0${boundaryMessageId}`;

  const MANAGED_TASK_RECLAIM_GRACE_MS = 5_000;

  const claimEligibleAfterRelease = (
    canvasName: string,
    sinkNodeId: string,
    task: Task,
    actorSeatId: ActorSeatId,
  ): boolean => {
    const release = taskReleaseBoundary(task);
    if (release === undefined || release.actorSeatId !== actorSeatId) {
      return true;
    }
    const key = reclaimCooldownKey(
      canvasName,
      sinkNodeId,
      task.id,
      release.messageId,
    );
    const now = Date.now();
    const existing = reclaimCooldowns.get(key);
    if (existing !== undefined) {
      if (now < existing.expiresAt) return false;
      return true;
    }
    const expiresAt = now + MANAGED_TASK_RECLAIM_GRACE_MS;
    const timer = setTimeout(() => {
      wakeAfterReclaimGrace();
    }, MANAGED_TASK_RECLAIM_GRACE_MS);
    timer.unref?.();
    reclaimCooldowns.set(key, { expiresAt, timer });
    return false;
  };

  const clearLifecycleScheduling = (): void => {
    if (safetyInterval !== undefined) {
      clearInterval(safetyInterval);
      safetyInterval = undefined;
    }
    // Suspension is monotonic: no later slice may start, whatever is queued.
    kernelTick?.stop();
    for (const cooldown of reclaimCooldowns.values()) {
      clearTimeout(cooldown.timer);
    }
    reclaimCooldowns.clear();
    for (const cleanup of lifecycleCleanups.splice(0)) {
      try {
        cleanup();
      } catch {
        // Suspension is fail-closed. One broken observer cleanup must not
        // prevent the remaining listeners from being detached.
      }
    }
  };

  let started = false;

  const composeSnapshot = (): KernelSnapshot => {
    const canvasesOut: Record<
      string,
      {
        watchers: Record<string, WatcherRuntimeState>;
        nextFire: Record<string, number>;
        flagOverrides: ReturnType<typeof getRuntimeFlagOverrides>;
        execution?: import("./cycle").ExecutionSnapshot;
      }
    > = {};
    const entryFor = (name: string) =>
      (canvasesOut[name] ??= {
        watchers: {},
        nextFire: {},
        flagOverrides: getRuntimeFlagOverrides(name),
      });
    for (const name of docs.keys()) {
      const entry = entryFor(name);
      const execution = getExecutionByCanvas().get(name);
      if (execution) entry.execution = execution;
    }
    for (const [key, value] of getWatchers()) {
      const split = splitNamespacedKey(key);
      if (!split) continue;
      entryFor(split[0]).watchers[split[1]] = value;
    }
    for (const [key, value] of getNextFire()) {
      const split = splitNamespacedKey(key);
      if (!split) continue;
      entryFor(split[0]).nextFire[split[1]] = value;
    }
    return { canvases: canvasesOut };
  };

  const emitSnapshot = (): void => {
    const snapshot = composeSnapshot();
    for (const listener of snapshotListeners) {
      try {
        listener(snapshot);
      } catch (error) {
        console.error("[kernel] snapshot listener failed:", error);
      }
    }
  };

  // Cron durable due + nextFire. Factory claims use managedPulseDeliver
  // separately — not region-pulse delivery deps.
  __setTimerSchedulerForTest({
    claimInterval: (input) =>
      run(scheduler.claimInterval(input)),
    claimExpression: (input) =>
      run(scheduler.claimExpression(input)),
    reconcileHome: (homeStation, activeTimerKeys) =>
      run(
        scheduler.reconcileHome(homeStation, activeTimerKeys),
      ),
    readIntervalState: (homeStation, timerKey) =>
      run(scheduler.readIntervalState(homeStation, timerKey)),
  });

  // Process-local effect receipts (at-most-once within this runtime).
  const effectReceipts = new Set<string>();

  /** Station role configured (not unset) + canvas playing → may consume fires. */
  const canAutomateCanvas = (canvasName: string): boolean => {
    // stationRole from cycle scope is mirrored here via live stations each cycle;
    // use pause + a role snapshot refreshed in runCycle.
    if (cachedStationRole === "") return false;
    return pause.stateFor(canvasName).playing;
  };

  const canApplyFlagEffects = (): boolean => cachedStationRole === "command-center";

  let cachedStationRole: "" | "command-center" | "remote" = "";

  /**
   * Durable document flags (same truth as renderer toggleFlag).
   * Command Center + playing only; Remote refuses authorial mutate.
   * Also projects process-local runtime flags for same-tick kernel eval, then
   * clears that override so the document remains sole product truth after write.
   */
  const setNodeFlag = async (
    canvasName: string,
    nodeId: string,
    flag: EtherFlag,
    enabled: boolean,
  ): Promise<{ readonly ok: boolean; readonly message?: string }> => {
    if (!pause.stateFor(canvasName).playing) {
      return { ok: false, message: "canvas paused" };
    }
    if (cachedStationRole !== "command-center") {
      return {
        ok: false,
        message: "flag effects require Command Center",
      };
    }
    const live = docs.get(canvasName);
    if (live === undefined || !live.nodes.some((node) => node.id === nodeId)) {
      return {
        ok: false,
        message: "canvas or node is not in the live projection",
      };
    }
    try {
      // Same-tick eval: project before durable commit settles / resyncs.
      setRuntimeFlag(canvasName, nodeId, flag, enabled);
      await mainAuthoringGate.run("kernel.flag-mirror", () =>
        run(
          canvases.mutate(canvasName, (doc) =>
            applyNodeFlag(doc, nodeId, flag, enabled),
          ),
        ),
      );
      // Hot map shares identity with cycle after hydrate — keep it current.
      const current = docs.get(canvasName);
      if (current !== undefined) {
        docs.set(canvasName, applyNodeFlag(current, nodeId, flag, enabled));
      }
      // Document is product truth; drop the process-local ghost override.
      clearRuntimeFlag(canvasName, nodeId, flag);
      return { ok: true };
    } catch (error) {
      clearRuntimeFlag(canvasName, nodeId, flag);
      const message =
        error instanceof Error ? error.message : String(error);
      console.error(
        `[kernel] setFlag failed for ${canvasName}/${nodeId}: ${message}`,
      );
      return { ok: false, message };
    }
  };

  __setAutomationGateForTest({
    canAutomateCanvas,
    canApplyFlagEffects,
  });

  setSchedulerEffectDeps({
    canAutomateCanvas,
    canApplyFlagEffects,
    hasReceipt: (fireKey, edgeId) => effectReceipts.has(`${fireKey}::${edgeId}`),
    recordReceipt: (fireKey, edgeId) => {
      effectReceipts.add(`${fireKey}::${edgeId}`);
    },
    enqueueTask: async ({ canvasName, sinkNodeId, payload }) => {
      if (!canAutomateCanvas(canvasName)) {
        return { ok: false, message: "canvas paused or station role unset" };
      }
      const args = effectTasksCreateToWorkArgs(payload);
      const result = await run(
        work.workTaskCreate(
          canvasName,
          sinkNodeId,
          args.brief,
          args.metadata,
          args.reason ?? "scheduler",
          undefined,
          args.dependsOn,
          args.finishCriteria,
        ),
      );
      if (!result.ok) {
        return { ok: false, message: result.message };
      }
      return { ok: true };
    },
    setFlag: setNodeFlag,
    injectPrompt: async ({ canvasName, agentNodeId, text }) => {
      if (!canAutomateCanvas(canvasName)) {
        return { ok: false, message: "canvas paused or station role unset" };
      }
      if (cachedStationRole !== "command-center") {
        return { ok: false, message: "inject_prompt requires Command Center" };
      }
      const result = await run(
        work.workSystemMailboxNotify(
          canvasName,
          agentNodeId,
          makeUserMessage({
            messageId: ulid(),
            text,
            contextId: canvasName,
            metadata: { factoryScheduler: true, injectPrompt: true },
          }),
        ),
      );
      if (!result.ok) {
        return { ok: false, message: result.message };
      }
      return { ok: true };
    },
  });

  // flagOnUnsatisfied writes only when automation gate allows (CC + playing).
  __setFlagWriterForTest({
    setFlag: (canvasName, nodeId, flag, enabled) => {
      void setNodeFlag(canvasName, nodeId, flag as EtherFlag, enabled);
    },
  });

  // --- evaluation cycle --------------------------------------------------------

  /**
   * A managed actor is lazy: until something wants it, it is only a node on
   * the canvas. Starting every authored seat on boot (and again on every node
   * add) charged the whole region's process cost up front, which is the tax
   * this pre-pass exists to avoid.
   *
   * Waking is therefore demand-driven: `actorsNeedingWake` names exactly the
   * actors that open work would fall to and that no live seat can absorb.
   *
   * Explicit operator activation (double-click → terminal open) remains the
   * other start authority, and it does not route through here.
   */
  const startManagedSeats = (
    scope: ActiveStationScope,
    registry: ActiveActorRegistry,
    generation: number,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      for (const [canvasName, doc] of docs) {
        if (!generationIsActive(generation)) return;
        const state = pause.stateFor(canvasName);
        if (!state.playing) continue;

        const seatPausedHere = (nodeId: string): boolean =>
          seatPaused(state, doc, nodeId);
        const wanted = actorsNeedingWake(doc, canvasName, registry.resolve, {
          seatPaused: seatPausedHere,
          claimEligible: (task, actor, sink) =>
            taskAdmissionState(
              task,
              boardContractOf(doc.nodes.find((node) => node.id === sink.id)),
              Date.now(),
            ) === "claimable" &&
            claimEligibleAfterRelease(
              canvasName,
              sink.id,
              task,
              actor.seatId,
            ),
          // Awake covers both "already live here" and "not this station's seat
          // to start" — a Remote's actor is started by its own installation.
          isAwake: (node) => {
            const authority = runtimeAuthority(scope, registry, canvasName, node);
            if (authority === undefined) return true;
            if (!isManagedSeatRuntimeLocal(canvasName, node, authority)) {
              return true;
            }
            const surface = actorDeliverySurfaceOf(node);
            return (
              surface?._tag === "managedAgent" &&
              localManagedSeatReadyForClaim(surface.bindingId)
            );
          },
        });
        if (wanted.size === 0) continue;

        for (const node of doc.nodes) {
          if (!generationIsActive(generation)) return;
          if (!wanted.has(node.id)) continue;
          if (seatPausedHere(node.id)) continue;
          const authority = runtimeAuthority(
            scope,
            registry,
            canvasName,
            node,
          );
          if (authority === undefined) continue;
          yield* ensureManagedSeatRunning(
            canvasName,
            doc,
            node,
            authority,
            actorSeatOccupy,
          );
        }
      }
    });

  // V4-PROGRAM: factory control path is Effect, not async Promise chains.
  const runClaimTicks = (
    scope: ActiveStationScope,
    registry: ActiveActorRegistry,
    generation: number,
  ): Effect.Effect<void, unknown> =>
    Effect.gen(function* () {
      if (scope.role === "" || !generationIsActive(generation)) return;
      const uniqueActors = new Map<
        ActorSeatId,
        {
          readonly canvasName: string;
          readonly node: CanvasNode;
          readonly actor: ActorRef;
        }
      >();
      for (const [canvasName, doc] of docs) {
        for (const node of doc.nodes) {
          const actor = registry.resolve({ canvasName, nodeId: node.id });
          if (actor !== undefined && !uniqueActors.has(actor.seatId)) {
            uniqueActors.set(actor.seatId, { canvasName, node, actor });
          }
        }
      }
      const selectableActorSeatIds = new Set<ActorSeatId>();
      yield* Effect.forEach(
        [...uniqueActors],
        ([seatId, candidate]) =>
          Effect.gen(function* () {
            if (!generationIsActive(generation)) return;
            const selectable = yield* actorSeatSelectableNow(
              candidate.canvasName,
              candidate.node,
              candidate.actor,
              scope,
              {
                isLocalSeatReady: localManagedSeatReadyForClaim,
                installationForHost: (hostId) =>
                  Effect.map(
                    fleetTargets.get(hostId),
                    (row) => row?.stationInstallationId,
                  ),
                isLive: (hostId, installationId) =>
                  livePeers.isLive(hostId, installationId),
              },
            );
            if (selectable && generationIsActive(generation)) {
              selectableActorSeatIds.add(seatId);
            }
          }),
        { concurrency: "unbounded" },
      );
      if (!generationIsActive(generation)) return;

      const busyActorSeatIds = new Set<ActorSeatId>();
      const pendingCommands = yield* workRepository.pendingCommands;
      if (!generationIsActive(generation)) return;
      for (const pending of pendingCommands) {
        if (
          pending.resolution === undefined &&
          pending.command.body.operation === "task.claim"
        ) {
          // The task remains submitted until the Remote adopts it, but the
          // durable claim attempt already reserves the actor. Treating only
          // material task rows as busy would let the deterministic selector
          // choose this seat forever and starve the next eligible actor.
          busyActorSeatIds.add(pending.command.body.actor.seatId);
        }
      }
      for (const doc of docs.values()) {
        for (const node of doc.nodes) {
          if (!isClaimableTaskSink(node)) continue;
          for (const task of node.ether?.tasks?.items ?? []) {
            if (
              task.state !== "working" &&
              task.state !== "input-required" &&
              task.state !== "auth-required"
            ) {
              continue;
            }
            const actorSeatId = claimedByOf(task);
            if (actorSeatId !== undefined) busyActorSeatIds.add(actorSeatId);
          }
        }
      }

      for (const [canvasName, doc] of docs) {
        if (!generationIsActive(generation)) return;
        const state = pause.stateFor(canvasName);
        if (!state.playing) continue;
        const selections = selectFactoryClaims(
          doc,
          canvasName,
          registry.resolve,
          {
            seatPaused: (nodeId) => seatPaused(state, doc, nodeId),
            actorEligible: (actor) => {
              const actorRef = registry.resolve({
                canvasName,
                nodeId: actor.id,
              });
              return (
                actorRef !== undefined &&
                selectableActorSeatIds.has(actorRef.seatId)
              );
            },
            claimEligible: (task, actor, sink) =>
              // The auto-claim loop skips tasks still waiting, tasks awaiting
              // approval, and every task on a board set to Me.
              taskAdmissionState(
                task,
                boardContractOf(doc.nodes.find((n) => n.id === sink.id)),
                Date.now(),
              ) === "claimable" &&
              claimEligibleAfterRelease(
                canvasName,
                sink.id,
                task,
                actor.seatId,
              ),
            busyActorSeatIds,
          },
        );
        for (const selection of selections) {
          // This is the durable claim mutation boundary. A claim already
          // admitted here may settle after suspension; no later selection may
          // enter WorkService.
          if (!generationIsActive(generation)) return;
          const result = yield* work.workTaskClaim(
            selection.sink.canvasName,
            selection.sink.nodeId,
            selection.task.itemId,
            selection.actor,
          );
          if (
            !result.ok &&
            result.code !== "claim_contention" &&
            result.code !== "illegal_transition"
          ) {
            console.error(
              `[kernel] claim tick failed for ${selection.sink.canvasName}/${selection.sink.nodeId}/${selection.task.itemId}: ${result.message}`,
            );
          }
          if (result.ok) {
            retainSuccessfulClaimProjection(
              docs,
              selection.sink.canvasName,
              result,
            );
            busyActorSeatIds.add(selection.actor.seatId);
          }
        }
      }
    });

  // A claim is the start of work. The durable task row records that claim;
  // this is only its local managed-seat wake-up. Failed idle-gated writes are
  // retried when that seat becomes deliverable; the safety cycle is repair.
  const deliverWorkingClaims = (
    scope: ActiveStationScope,
    registry: ActiveActorRegistry,
    generation: number,
  ): Effect.Effect<void, unknown> =>
    Effect.gen(function* () {
      if (scope.role === "" || !generationIsActive(generation)) return;
      for (const [canvasName, doc] of docs) {
        if (!generationIsActive(generation)) return;
        const state = pause.stateFor(canvasName);
        if (!state.playing) continue;
        for (const sink of doc.nodes) {
          if (!generationIsActive(generation)) return;
          if (!isClaimableTaskSink(sink)) continue;
          for (const task of sink.ether?.tasks?.items ?? []) {
            if (!generationIsActive(generation)) return;
            if (task.state !== "working") continue;
            const actorSeatId = claimedByOf(task);
            if (actorSeatId === undefined) continue;
            const actorRef = registry.actorOnCanvas(actorSeatId, canvasName);
            if (actorRef === undefined) continue;
            const actor = doc.nodes.find(
              (node) => node.id === actorRef.nodeId,
            );
            if (actor === undefined || seatPaused(state, doc, actor.id)) {
              continue;
            }
            const authority = runtimeAuthority(
              scope,
              registry,
              canvasName,
              actor,
            );
            if (
              authority === undefined ||
              !isManagedSeatRuntimeLocal(canvasName, actor, authority)
            ) {
              continue;
            }
            const surface = actorDeliverySurfaceOf(actor);
            if (surface?._tag !== "managedAgent") continue;
            const sinkRef = { canvasName, nodeId: sink.id } satisfies SinkRef;
            const claimBoundaryMessageId =
              task.history.at(-1)?.messageId ?? task.id;
            const deliveryId = managedTaskDeliveryId(
              sinkRef,
              task.id,
              actorSeatId,
              claimBoundaryMessageId,
            );
            const alreadyAccepted = yield* workRepository.hasAcceptedDelivery(
              sinkRef,
              deliveryId,
            );
            if (alreadyAccepted) continue;
            if (!generationIsActive(generation)) return;
            const running = yield* ensureManagedSeatRunning(
              canvasName,
              doc,
              actor,
              authority,
              actorSeatOccupy,
            );
            // Claim brief only — never a prior `/compact` gate. Compact is not
            // part of claim delivery; the seat receives one complete CLI briefing.
            if (!running || !generationIsActive(generation)) continue;
            const accepted = yield* Effect.promise(() =>
              managedPulseDeliver(
                surface.bindingId,
                buildFactoryClaimPrompt({
                  boardId: sink.id,
                  task,
                  doc,
                }),
              ),
            );
            if (!accepted) continue;
            // Claim acceptance re-grounds the seat (the briefing teaches the CLI):
            // the supervisor counts it as factory proof.
            injectionSupervisor.noteClaimAccepted(surface.bindingId);

            // Record only after the managed transport accepted the prompt. This
            // durably suppresses restart replay. The send→receipt crash window
            // remains intentionally at-least-once until that transport accepts
            // an idempotency key; pre-writing would instead risk silent loss.
            const intentWitness = yield* canvases.activeIntentWitness();
            const basis = Schema.decodeUnknownSync(IntentFactBasis)({
              kind:
                scope.role === "command-center"
                  ? "authorial-intent"
                  : "projected-intent",
              generation: intentWitness.generation,
              contentSha256: intentWitness.contentSha256,
            });
            yield* workRepository.acceptDelivery({
              sink: sinkRef,
              basis,
              receipt: {
                deliveryId,
                deliveredItem: {
                  kind: "task",
                  itemId: task.id,
                  sink: sinkRef,
                },
                actor: actorRef,
                acceptedAt: new Date().toISOString(),
              },
            });
          }
        }
      }
    });

  const runCycle: Effect.Effect<void, unknown> = Effect.gen(function* () {
    const generation = activeGeneration();
    if (!generationIsActive(generation)) return;
    const scope = yield* refreshStationScope(stations, () =>
      generationIsActive(generation),
    );
    if (!generationIsActive(generation)) return;
    cachedStationRole =
      scope.role === "command-center" || scope.role === "remote"
        ? scope.role
        : "";
    const registry =
      scope.role === ""
        ? activeActorRegistry([])
        : activeActorRegistry(yield* canvases.activeActorRefs());
    if (!generationIsActive(generation)) return;
    setActorRefResolver(registry.resolve);
    const currentSnapshots = yield* snapshots.current;
    if (!generationIsActive(generation)) return;
    __setSnapshotsForTest(currentSnapshots);
    yield* startManagedSeats(scope, registry, generation);
    if (!generationIsActive(generation)) return;
    // Evaluation + timers remain Promise-shaped pure-cycle modules; wrap once
    // at the Effect boundary (not factory control plane ownership).
    yield* Effect.all(
      [
        Effect.promise(() => runEvaluationCycle()),
        Effect.promise(() => checkTimers()),
      ],
      { concurrency: 2 },
    );
    if (!generationIsActive(generation)) return;
    yield* runClaimTicks(scope, registry, generation);
    if (!generationIsActive(generation)) return;
    yield* deliverWorkingClaims(scope, registry, generation);
    if (!generationIsActive(generation)) return;
    // Sweep stale watcher/timer runtime entries for nodes removed on a still-
    // existing canvas (whole-canvas deletes are handled by purgeCanvasMemory
    // on resync). Runs after evaluation so this cycle's fresh entries stand.
    reconcileLiveCanvasMemory();
    emitSnapshot();
  });

  // `resyncCanvas` is declared below and only ever CALLED from a lane slice,
  // long after this closure is built.
  kernelTick = makeKernelLaneScheduler({
    runCycle,
    resyncCanvas: (canvasName) => resyncCanvas(canvasName),
    fork,
  });
  const scheduleCycle = (): void => {
    if (!suspended) kernelTick?.mark("simulation", KERNEL_CYCLE_KEY);
  };
  const scheduleResync = (canvasName: string): void => {
    if (!suspended) kernelTick?.mark("immediate", kernelResyncKey(canvasName));
  };
  wakeAfterReclaimGrace = scheduleCycle;

  /**
   * Delivery is another legitimate demand signal for a lazy actor. Board
   * wakes and mailbox messages do not create a task claim, so they cannot
   * rely on the claim pre-pass to start the seat first. Keep the startup
   * authority here beside the task path, and re-read the document/ref surface
   * so a stale renderer projection cannot mint a process.
   */
  // IPC / external surface stays Promise; body is Effect forked via host.
  const wakeManagedSeatProgram = (
    canvasName: string,
    nodeId: string,
  ): Effect.Effect<boolean, unknown> =>
    Effect.gen(function* () {
      const generation = activeGeneration();
      if (!generationIsActive(generation)) return false;

      // Every refusal below names itself: a silent false here previously left
      // mail pending forever with no operator-visible trace anywhere.
      const refuse = (reason: string): false => {
        console.error(`[wake] refused ${canvasName}/${nodeId}: ${reason}`);
        return false;
      };
      // Node-scoped: every question below this line is structural — the seat
      // surface on one node, its compiled actor reference, its containing
      // region's pause state, and the topology the spawn intent compiles from
      // edges. None of them reads a Work lane, so none of them may pay for the
      // whole factory's tasks, messages, requests, artifacts, board and pad.
      const read = yield* Effect.result(
        canvases.readNodeStructure(canvasName, nodeId, "kernel.wakeManagedSeat"),
      );
      if (!generationIsActive(generation)) return false;
      if (read._tag === "Failure") return refuse("canvas read failed");
      if (read.success === undefined) {
        return refuse("node is not on the canvas");
      }
      const doc = read.success.structure;
      const node = read.success.node;

      const scope = yield* refreshStationScope(stations, () =>
        generationIsActive(generation),
      );
      if (!generationIsActive(generation)) return false;
      if (scope.role === "") return refuse("station scope unavailable");

      const actorRefs = yield* Effect.result(canvases.activeActorRefs());
      if (!generationIsActive(generation)) return false;
      if (actorRefs._tag === "Failure") {
        return refuse("active actor portfolio unavailable");
      }
      const registry = activeActorRegistry(actorRefs.success);
      const authority = runtimeAuthority(scope, registry, canvasName, node);
      if (authority === undefined) {
        return refuse("actor reference is not in the compiled portfolio");
      }
      if (!isManagedSeatRuntimeLocal(canvasName, node, authority)) {
        return refuse("seat is not local to this installation");
      }
      if (!pause.stateFor(canvasName).playing) {
        return refuse("canvas is not playing");
      }
      if (seatPaused(pause.stateFor(canvasName), doc, node.id)) {
        return refuse("seat is paused");
      }

      return yield* ensureManagedSeatRunning(
        canvasName,
        doc,
        node,
        authority,
        actorSeatOccupy,
      );
    });

  const wakeManagedSeat = (
    canvasName: string,
    nodeId: string,
  ): Promise<boolean> => run(wakeManagedSeatProgram(canvasName, nodeId));

  // --- doc hydration + mid-cycle resync ---------------------------------------

  const hydrateDoc = (
    name: string,
    generation: number,
  ): Effect.Effect<void, unknown> =>
    Effect.gen(function* () {
      if (!generationIsActive(generation)) return;
      const result = yield* Effect.result(
        canvases.read(name, "kernel.hydrateDoc"),
      );
      if (result._tag === "Success" && generationIsActive(generation)) {
        docs.set(name, result.success.doc);
      }
      // else: a broken/mid-write canvas is skipped this pass — one bad doc
      // never stalls hydration of the rest.
    });

  // Bounded concurrency — a station can accumulate many canvases; hydration
  // must not fan out one unbounded Promise.all across all of them at once.
  const MAX_CONCURRENT_HYDRATIONS = 4;

  const hydrateAllDocs = (
    generation: number,
  ): Effect.Effect<void, unknown> =>
    Effect.gen(function* () {
      if (!generationIsActive(generation)) return;
      const summaries = yield* canvases.list;
      if (!generationIsActive(generation)) return;
      for (let i = 0; i < summaries.length; i += MAX_CONCURRENT_HYDRATIONS) {
        if (!generationIsActive(generation)) return;
        const batch = summaries.slice(i, i + MAX_CONCURRENT_HYDRATIONS);
        yield* Effect.forEach(
          batch,
          (summary) => hydrateDoc(summary.name, generation),
          { concurrency: MAX_CONCURRENT_HYDRATIONS },
        );
      }
      if (generationIsActive(generation)) setDocs(docs);
    });

  // App-owned create/write/mutate -> reread into the map; delete -> drop +
  // purge its namespaced in-memory state. subscribeChanges only reports a
  // name, not the kind of change, so list() is the source of truth for
  // "still there". Every authority commit notifies this path.
  const resyncCanvas = (name: string): Effect.Effect<void, unknown> =>
    Effect.gen(function* () {
      const generation = activeGeneration();
      if (!generationIsActive(generation)) return;
      const summaries = yield* canvases.list;
      if (!generationIsActive(generation)) return;
      if (!summaries.some((summary) => summary.name === name)) {
        docs.delete(name);
        purgeCanvasMemory(name);
        scheduleCycle();
        return;
      }

      const result = yield* Effect.result(
        canvases.read(name, "kernel.resyncDoc"),
      );
      if (result._tag === "Success" && generationIsActive(generation)) {
        docs.set(name, result.success.doc);
        fork(refreshWithIdentityHints());
        scheduleCycle();
      }
      // else: transient read/decode failure (e.g. mid-write) — keep the
      // previously hydrated doc; the next app-owned change notification retries.
    });

  // Enrichment hints derive from identity resolution over every hydrated doc
  // against the CURRENT snapshot (shared/connections.ts). Cold start: the
  // first poll fetches base lists unhinted, the next resolves against them —
  // convergence within two cycles, by design.
  const refreshWithIdentityHints = () =>
    Effect.flatMap(snapshots.current, (state) =>
      snapshots.refresh(identityHints(docs.values(), state)),
    );

  const startProgram = (
    generation: number,
  ): Effect.Effect<void, unknown> =>
    Effect.gen(function* () {
      yield* pause.start;
      if (!generationIsActive(generation)) return;
      yield* hydrateAllDocs(generation);
      if (!generationIsActive(generation)) return;
      fork(refreshWithIdentityHints());

      lifecycleCleanups = [
        // Immediate lane, keyed by canvas: a burst of commits on one canvas
        // now costs ONE re-read instead of one fork per notification.
        canvases.subscribeChanges((name) => {
          scheduleResync(name);
        }),
        snapshots.subscribe(() => scheduleCycle()),
        livePeers.subscribe(() => scheduleCycle()),
        // Play/pause is an authoritative runtime transition. Resume must
        // claim immediately; pause must promptly cause the next cycle to
        // observe the closed gate instead of waiting for the 30s watchdog.
        subscribeKernelPauseWake(pause.subscribe, scheduleCycle),
        subscribeSeatBlocks(() => scheduleCycle()),
        subscribeKernelSeatWake(
          (listener) => seatStateRuntime.subscribe(listener),
          scheduleCycle,
        ),
        // A transport-specific startup guard (currently Grok's verified
        // post-spawn window) publishes readiness without retaining a prompt.
        // The fresh cycle re-checks durable Work, intent, edges, and locality.
        subscribeManagedPulseReady(() => scheduleCycle()),
      ];

      // No Effect yield between the generation check and installing these
      // handles, so suspend() cannot interleave and leave a late timer alive.
      if (!generationIsActive(generation)) {
        clearLifecycleScheduling();
        return;
      }

      // Repair/watchdog only. Ordinary document, snapshot, and seat
      // lifecycle progress schedules a cycle at the authoritative event. The
      // sweep runs on the housekeeping lane, which the driver keeps served
      // even while the immediate lane is hot.
      safetyInterval = setInterval(() => {
        if (!suspended) kernelTick?.mark("housekeeping", KERNEL_SAFETY_KEY);
      }, SAFETY_INTERVAL_MS);

      scheduleCycle();
    });

  return KernelService.of({
    // Effect.sync, not Effect.succeed: the report reads docs.size at CALL
    // time, not at layer-build time (when it is always 0, before any
    // hydration) — a live count, not a frozen one.
    doctor: Effect.sync(() => ({
      id: "kernel",
      label: "Kernel",
      status: "ok" as const,
      detail: `${docs.size} canvas(es) hydrated`,
    })),

    wakeManagedSeat,

    start: (nextHost: KernelHost) => {
      if (started || suspended) return;
      host = nextHost;
      started = true;
      const generation = activeGeneration();
      // V4-PROGRAM: factory program entry is AppRuntime/RemoteRuntime.runFork
      // — never an async IIFE control plane.
      fork(
        startProgram(generation).pipe(
          Effect.catchCause((cause) => {
            console.error(
              "[kernel] start() failed:",
              Cause.squash(cause),
            );
            return Effect.void;
          }),
        ),
      );
    },

    suspend: () => {
      if (suspended) return;
      suspended = true;
      lifecycleGeneration += 1;
      clearLifecycleScheduling();
    },

    getSnapshot: () => composeSnapshot(),

    subscribe: (listener) => {
      snapshotListeners.add(listener);
      return () => snapshotListeners.delete(listener);
    },

    manualFire: (input) => manualSchedulerFire(input),

    requestCycle: () => {
      scheduleCycle();
    },

    setPageLoadProvider: (snapshot) => {
      setPageLoadDeps(
        snapshot === undefined ? undefined : { snapshot },
      );
    },
  });
};

export const KernelLive = Layer.effect(
  KernelService,
  Effect.gen(function* () {
    const canvases = yield* CanvasesService;
    const snapshots = yield* SnapshotsService;
    const pause = yield* PausePlane;
    const scheduler = yield* SchedulerRepository;
    const fleetTargets = yield* StationFleetTargetRepository;
    const stations = yield* StationRepository;
    const livePeers = yield* StationLivePeerRegistry;
    const work = yield* WorkService;
    const workRepository = yield* WorkRepository;
    const actorSeatOccupy = yield* ActorSeatOccupy;
    // No Runtime capture (V4-KERNEL / V4-PROGRAM / migration/runtime.md).
    // Domain Effects exit only after start(host) binds AppRuntime / RemoteRuntime.
    return makeKernelService(
      canvases,
      snapshots,
      pause,
      scheduler,
      fleetTargets,
      stations,
      livePeers,
      work,
      workRepository,
      actorSeatOccupy,
    );
  }),
);
