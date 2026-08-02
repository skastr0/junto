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
// S2 (docs/END_STATE-effect-foundation.md): Promise bridges must use the
// warm Runtime captured at KernelLive construction — never bare
// runPromise (empty Context). That was the claim-tick bug class:
// WorkService call-time ContentService lookups saw None and media claims
// failed as "content service unavailable". Capture avoids importing
// AppRuntime (circular: RootLayer includes KernelLive).

import { createHash } from "node:crypto";
import { Context, Effect, Layer, Runtime, Schema } from "effect";
import type { CanvasDoc, CanvasNode } from "@shared/canvas";
import { actorDeliverySurfaceOf } from "@shared/actor-surface";
import type { AgentSeatStateEvent } from "@shared/agent-seat-state";
import type { ActorRefResolver } from "@shared/attention";
import { identityHints } from "@shared/connections";
import type { ServiceCheck } from "@shared/contracts";
import {
  DEFAULT_STATION_HOST_ID,
  type StationRole,
} from "@shared/station";
import {
  claimedByOf,
  taskBrief,
  taskMediaParts,
  taskReleaseBoundary,
} from "@shared/task";
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
import {
  managedPulseDeliver,
  subscribeManagedPulseReady,
} from "../term/managed-pulse-bridge";
import { WorkRepository } from "../work/repository";
import { subscribeSeatBlocks } from "../work/blocked-seat";
import {
  checkTimers,
  getExecutionByCanvas,
  getNextFire,
  getRuntimeFlagOverrides,
  getWatchers,
  purgeCanvasMemory,
  reconcileLiveCanvasMemory,
  runEvaluationCycle,
  setActorRefResolver,
  setDocs,
  setRuntimeFlag,
  setStationScope,
  __setAutomationGateForTest,
  __setFlagWriterForTest,
  __setPhaseMirrorForTest,
  __setSnapshotsForTest,
  __setTimerSchedulerForTest,
} from "./cycle";
import { setSchedulerEffectDeps } from "./effects";
import type { EtherFlag } from "@shared/canvas";

export class KernelService extends Context.Tag("@vellum/KernelService")<
  KernelService,
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
    readonly start: () => void;
    // Irreversibly stop admitting new kernel work. Existing terminal/agent
    // processes are deliberately untouched; work admitted before the cut may
    // settle, but no later cycle, claim, or seat start may begin.
    readonly suspend: () => void;
    // Synchronous read of the current wire snapshot — used for getKernelState's
    // initial-hydrate answer.
    readonly getSnapshot: () => KernelSnapshot;
    // Pushed on cycle end — never per-watcher.
    readonly subscribe: (listener: (snapshot: KernelSnapshot) => void) => () => void;
  }
>() {}

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

/**
 * One evaluation may run at a time. Any number of overlapping triggers retain
 * exactly one repair pass, so lifecycle bursts cannot race shared kernel
 * memory or grow an unbounded retry backlog.
 */
export const makeCoalescedKernelCycleScheduler = (
  runCycle: () => Promise<void>,
  onError: (error: unknown) => void = (error) =>
    console.error("[kernel] evaluation cycle failed:", error),
): (() => void) => {
  let cycleInFlight = false;
  let cycleQueued = false;

  const scheduleCycle = (): void => {
    if (cycleInFlight) {
      cycleQueued = true;
      return;
    }
    cycleInFlight = true;
    void runCycle()
      .catch(onError)
      .finally(() => {
        cycleInFlight = false;
        if (cycleQueued) {
          cycleQueued = false;
          scheduleCycle();
        }
      });
  };

  return scheduleCycle;
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

type CanvasesShape = Context.Tag.Service<typeof CanvasesService>;
type SnapshotsShape = Context.Tag.Service<typeof SnapshotsService>;
type PauseShape = Context.Tag.Service<typeof PausePlane>;
type SchedulerShape = Context.Tag.Service<typeof SchedulerRepository>;
type FleetTargetsShape = Context.Tag.Service<
  typeof StationFleetTargetRepository
>;
type StationsShape = Context.Tag.Service<typeof StationRepository>;
type LivePeersShape = Context.Tag.Service<typeof StationLivePeerRegistry>;
type WorkShape = Context.Tag.Service<typeof WorkService>;
type WorkRepositoryShape = Context.Tag.Service<typeof WorkRepository>;
type KernelServiceShape = Context.Tag.Service<typeof KernelService>;

/**
 * Warm-Context Promise boundary for kernel async bridges.
 * Built from `yield* Effect.runtime()` inside KernelLive so Work/Content
 * (and every other RootLayer service) remain visible to domain Effects.
 */
type KernelRunPromise = <A, E>(
  effect: Effect.Effect<A, E>,
) => Promise<A>;

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

const refreshStationScope = async (
  stations: StationsShape,
  runPromise: KernelRunPromise,
  commit: () => boolean = () => true,
): Promise<ActiveStationScope> => {
  try {
    const current = await runPromise(
      Effect.all({
        installationId: stations.installationId,
        configuration: stations.configuration,
      }),
    );
    if (current.configuration === undefined) {
      const scope = {
        hostId: DEFAULT_STATION_HOST_ID,
        role: "",
      } satisfies ActiveStationScope;
      if (commit()) setStationScope(scope);
      return scope;
    }
    const scope = {
      installationId: current.installationId,
      hostId: current.configuration.configuration.hostId,
      role: current.configuration.configuration.role,
    } satisfies ActiveStationScope;
    if (commit()) setStationScope(scope);
    return scope;
  } catch {
    // Fail closed: unreadable settings never mint Command Center authority.
    const scope = {
      hostId: DEFAULT_STATION_HOST_ID,
      role: "",
    } satisfies ActiveStationScope;
    if (commit()) setStationScope(scope);
    return scope;
  }
};

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
  ) => Promise<InstallationId | undefined>;
  readonly isLive: (
    hostId: HostIdValue,
    installationId: InstallationId,
  ) => Promise<boolean>;
};

/**
 * Selection admission is deliberately stricter than eventual delivery:
 * Command Center never picks an offline Remote actor and queues future work.
 * The later WorkService reservation still holds a live-session witness across
 * its SQLite transaction, closing the check/use race at the authority seam.
 */
export const actorSeatSelectableNow = async (
  canvasName: string,
  node: CanvasNode,
  actor: ActorRef,
  scope: Exclude<ActiveStationScope, { readonly role: "" }>,
  availability: ActorAvailability,
): Promise<boolean> => {
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
  const decodedHost = Schema.decodeUnknownEither(HostId)(surface.hostId);
  if (decodedHost._tag === "Left") return false;
  try {
    const installationId = await availability.installationForHost(
      decodedHost.right,
    );
    if (
      installationId === undefined ||
      deriveActorSeatId(installationId, surface.bindingId) !== actor.seatId
    ) {
      return false;
    }
    return availability.isLive(decodedHost.right, installationId);
  } catch {
    return false;
  }
};

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

/** Stable receipt for the session compaction that precedes one task prompt. */
export const managedTaskCompactionDeliveryId = (
  sink: SinkRef,
  taskId: string,
  actorSeatId: ActorSeatId,
  claimBoundaryMessageId: string,
): string =>
  `delivery_${createHash("sha256")
    .update(
      JSON.stringify([
        "vellum/managed-task-compaction/v1",
        sink.canvasName,
        sink.nodeId,
        taskId,
        actorSeatId,
        claimBoundaryMessageId,
      ]),
      "utf8",
    )
    .digest("hex")}`;

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
  runPromise: KernelRunPromise,
): KernelServiceShape => {
  const docs = new Map<string, CanvasDoc>();
  const snapshotListeners = new Set<(snapshot: KernelSnapshot) => void>();

  // Suspension is monotonic. The generation closes async check/use gaps: every
  // operation captures the current value at admission and checks it again at
  // later mutation boundaries. There is intentionally no resume path — a
  // newly licensed process starts a fresh KernelService.
  let suspended = false;
  let lifecycleGeneration = 0;
  const activeGeneration = (): number => lifecycleGeneration;
  const generationIsActive = (generation: number): boolean =>
    !suspended && generation === lifecycleGeneration;
  let lifecycleCleanups: Array<() => void> = [];
  let safetyInterval: ReturnType<typeof setInterval> | undefined;
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
      runPromise(scheduler.claimInterval(input)),
    reconcileHome: (homeStation, activeTimerKeys) =>
      runPromise(
        scheduler.reconcileHome(homeStation, activeTimerKeys),
      ),
    readIntervalState: (homeStation, timerKey) =>
      runPromise(scheduler.readIntervalState(homeStation, timerKey)),
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
    return setRuntimeFlag(canvasName, nodeId, flag, enabled)
      ? { ok: true }
      : { ok: false, message: "canvas or node is not in the live projection" };
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
    enqueueTask: async ({ canvasName, sinkNodeId, brief, reason }) => {
      if (!canAutomateCanvas(canvasName)) {
        return { ok: false, message: "canvas paused or station role unset" };
      }
      const trimmedBrief = brief.trim();
      const result = await runPromise(
        work.workTaskCreate(
          canvasName,
          sinkNodeId,
          brief,
          {
            title: trimmedBrief,
            // Scheduler effects author only a brief; treat it as the required description.
            details: trimmedBrief,
          },
          reason ?? "scheduler",
          undefined,
          undefined,
          undefined,
        ),
      );
      if (!result.ok) {
        return { ok: false, message: result.message };
      }
      return { ok: true };
    },
    setFlag: setNodeFlag,
  });

  // flagOnUnsatisfied writes only when automation gate allows (CC + playing).
  __setFlagWriterForTest({
    setFlag: (canvasName, nodeId, flag, enabled) => {
      void setNodeFlag(canvasName, nodeId, flag as EtherFlag, enabled);
    },
  });
  // Edge phase mirror remains projection-only (no authorial writeback).
  __setPhaseMirrorForTest(undefined);

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
  ): void => {
    for (const [canvasName, doc] of docs) {
      if (!generationIsActive(generation)) return;
      const state = pause.stateFor(canvasName);
      if (!state.playing) continue;

      const seatPausedHere = (nodeId: string): boolean =>
        seatPaused(state, doc, nodeId);
      const wanted = actorsNeedingWake(doc, canvasName, registry.resolve, {
        seatPaused: seatPausedHere,
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
        ensureManagedSeatRunning(canvasName, doc, node, authority);
      }
    }
  };

  const runCycle = async (): Promise<void> => {
    const generation = activeGeneration();
    if (!generationIsActive(generation)) return;
    const scope = await refreshStationScope(
      stations,
      runPromise,
      () => generationIsActive(generation),
    );
    if (!generationIsActive(generation)) return;
    cachedStationRole =
      scope.role === "command-center" || scope.role === "remote"
        ? scope.role
        : "";
    const registry =
      scope.role === ""
        ? activeActorRegistry([])
        : activeActorRegistry(
            await runPromise(canvases.activeActorRefs()),
          );
    if (!generationIsActive(generation)) return;
    setActorRefResolver(registry.resolve);
    const currentSnapshots = await runPromise(snapshots.current);
    if (!generationIsActive(generation)) return;
    __setSnapshotsForTest(currentSnapshots);
    startManagedSeats(scope, registry, generation);
    if (!generationIsActive(generation)) return;
    await Promise.all([runEvaluationCycle(), checkTimers()]);
    if (!generationIsActive(generation)) return;
    await runClaimTicks(scope, registry, generation);
    if (!generationIsActive(generation)) return;
    await deliverWorkingClaims(scope, registry, generation);
    if (!generationIsActive(generation)) return;
    // Sweep stale watcher/timer runtime entries for nodes removed on a still-
    // existing canvas (whole-canvas deletes are handled by purgeCanvasMemory
    // on resync). Runs after evaluation so this cycle's fresh entries stand.
    reconcileLiveCanvasMemory();
    emitSnapshot();
  };

  // The document projection plans claims; WorkService is the only mutation
  // authority. A Command Center may arbitrate an edged actor on any Station.
  // A Remote may only arbitrate its local actors (for Station-local queues).
  const runClaimTicks = async (
    scope: ActiveStationScope,
    registry: ActiveActorRegistry,
    generation: number,
  ): Promise<void> => {
    if (scope.role === "" || !generationIsActive(generation)) return;
    const uniqueActors = new Map<
      ActorSeatId,
      { readonly canvasName: string; readonly node: CanvasNode; readonly actor: ActorRef }
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
    await Promise.all(
      [...uniqueActors].map(async ([seatId, candidate]) => {
        if (!generationIsActive(generation)) return;
        const selectable = await actorSeatSelectableNow(
          candidate.canvasName,
          candidate.node,
          candidate.actor,
          scope,
          {
            isLocalSeatReady: localManagedSeatReadyForClaim,
            installationForHost: async (hostId) =>
              (
                await runPromise(fleetTargets.get(hostId))
              )?.stationInstallationId,
            isLive: (hostId, installationId) =>
              runPromise(livePeers.isLive(hostId, installationId)),
          },
        );
        if (selectable && generationIsActive(generation)) {
          selectableActorSeatIds.add(seatId);
        }
      }),
    );
    if (!generationIsActive(generation)) return;

    const busyActorSeatIds = new Set<ActorSeatId>();
    const pendingCommands = await runPromise(
      workRepository.pendingCommands,
    );
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
        const result = await runPromise(
          work.workTaskClaim(
            selection.sink.canvasName,
            selection.sink.nodeId,
            selection.task.itemId,
            selection.actor,
          ),
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
  };

  // A claim is the start of work. The durable task row is the assignment;
  // this is only its local managed-seat wake-up. Failed idle-gated writes are
  // retried when that seat becomes deliverable; the safety cycle is repair.
  const deliverWorkingClaims = async (
    scope: ActiveStationScope,
    registry: ActiveActorRegistry,
    generation: number,
  ): Promise<void> => {
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
          if (actor === undefined || seatPaused(state, doc, actor.id)) continue;
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
          const compactionDeliveryId = managedTaskCompactionDeliveryId(
            sinkRef,
            task.id,
            actorSeatId,
            claimBoundaryMessageId,
          );
          const deliveryId = managedTaskDeliveryId(
            sinkRef,
            task.id,
            actorSeatId,
            claimBoundaryMessageId,
          );
          if (
            await runPromise(
              workRepository.hasAcceptedDelivery(sinkRef, deliveryId),
            )
          ) {
            continue;
          }
          if (!generationIsActive(generation)) return;
          ensureManagedSeatRunning(canvasName, doc, actor, authority);
          if (
            !await runPromise(
              workRepository.hasAcceptedDelivery(
                sinkRef,
                compactionDeliveryId,
              ),
            )
          ) {
            // A task boundary gets its own harness turn. Never concatenate
            // `/compact` with the claim brief: slash commands are interpreted
            // only as standalone prompts, and the seat must become idle again
            // before the next durable delivery is admitted.
            const compacted = await managedPulseDeliver(
              surface.bindingId,
              "/compact",
            );
            if (!compacted) continue;
            const intentWitness = await runPromise(
              canvases.activeIntentWitness(),
            );
            const basis = Schema.decodeUnknownSync(IntentFactBasis)({
              kind:
                scope.role === "command-center"
                  ? "authorial-intent"
                  : "projected-intent",
              generation: intentWitness.generation,
              contentSha256: intentWitness.contentSha256,
            });
            await runPromise(
              workRepository.acceptDelivery({
                sink: sinkRef,
                basis,
                receipt: {
                  deliveryId: compactionDeliveryId,
                  deliveredItem: {
                    kind: "task",
                    itemId: task.id,
                    sink: sinkRef,
                  },
                  actor: actorRef,
                  acceptedAt: new Date().toISOString(),
                },
              }),
            );
            continue;
          }
          // Final prompt-send admission. If suspension occurs while the
          // transport is accepting this already-admitted prompt, its receipt
          // is still allowed to settle below.
          if (!generationIsActive(generation)) return;
          const media = taskMediaParts(task);
          const mediaNote =
            media.length === 0
              ? []
              : [
                  "",
                  `This task includes ${media.length} first-class media attachment${media.length === 1 ? "" : "s"} (${media.map((part) => part.mediaType ?? "raw").join(", ")}) on history[0] as raw parts.`,
                  "Inspect them via `vellum tasks list` (bytesBase64 + mediaType travel with the projected claim — no host path).",
                ];
          const criteria = task.finishCriteria;
          const criteriaNote =
            criteria === undefined
              ? []
              : [
                  "",
                  "Finish criteria (hard gate on complete):",
                  ...(criteria.description
                    ? [`- description: ${criteria.description}`]
                    : []),
                  ...(criteria.artifacts
                    ? [
                        `- artifacts required on node "${criteria.artifacts.nodeId}"` +
                          (criteria.artifacts.instruction
                            ? ` — ${criteria.artifacts.instruction}`
                            : "") +
                          (criteria.artifacts.names &&
                          criteria.artifacts.names.length > 0
                            ? ` (exact names: ${criteria.artifacts.names.join(", ")})`
                            : ""),
                        "  Publish with task linkage, then complete with completionEvidence.artifacts: [{ artifactId, nodeId }].",
                      ]
                    : []),
                  ...(criteria.git
                    ? [
                        `- git: at least ${criteria.git.minCommits} commit(s)`,
                        '  Complete with completionEvidence.git.commits: ["<sha>", ...].',
                      ]
                    : []),
                  "Full task JSON (incl. finishCriteria) is on `vellum tasks list`.",
                ];
          const accepted = await managedPulseDeliver(
            surface.bindingId,
            [
              `[factory claim] task ${task.id}: ${taskBrief(task)}`,
              "",
              "You claimed this task from the factory pull queue.",
              "Run `vellum onboard`, do the work, and update it with `vellum tasks update`.",
              "If blocked on a human, use `vellum escalate`.",
              ...mediaNote,
              ...criteriaNote,
            ].join("\n"),
          );
          if (!accepted) continue;

          // Record only after the managed transport accepted the prompt. This
          // durably suppresses restart replay. The send→receipt crash window
          // remains intentionally at-least-once until that transport accepts
          // an idempotency key; pre-writing would instead risk silent loss.
          const intentWitness = await runPromise(
            canvases.activeIntentWitness(),
          );
          const basis = Schema.decodeUnknownSync(IntentFactBasis)({
            kind:
              scope.role === "command-center"
                ? "authorial-intent"
                : "projected-intent",
            generation: intentWitness.generation,
            contentSha256: intentWitness.contentSha256,
          });
          await runPromise(
            workRepository.acceptDelivery({
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
            }),
          );
        }
      }
    }
  };

  const scheduleCoalescedCycle =
    makeCoalescedKernelCycleScheduler(runCycle);
  const scheduleCycle = (): void => {
    if (!suspended) scheduleCoalescedCycle();
  };
  wakeAfterReclaimGrace = scheduleCycle;

  /**
   * Delivery is another legitimate demand signal for a lazy actor. Board
   * wakes and mailbox messages do not create a task claim, so they cannot
   * rely on the claim pre-pass to start the seat first. Keep the startup
   * authority here beside the task path, and re-read the document/ref surface
   * so a stale renderer projection cannot mint a process.
   */
  const wakeManagedSeat = async (
    canvasName: string,
    nodeId: string,
  ): Promise<boolean> => {
    const generation = activeGeneration();
    if (!generationIsActive(generation)) return false;

    const read = await runPromise(
      Effect.either(canvases.read(canvasName)),
    );
    if (!generationIsActive(generation) || read._tag === "Left") return false;
    const doc = read.right.doc;
    const node = doc.nodes.find((candidate) => candidate.id === nodeId);
    if (node === undefined) return false;

    const scope = await refreshStationScope(
      stations,
      runPromise,
      () => generationIsActive(generation),
    );
    if (!generationIsActive(generation) || scope.role === "") return false;

    const actorRefs = await runPromise(
      Effect.either(canvases.activeActorRefs()),
    );
    if (!generationIsActive(generation) || actorRefs._tag === "Left") return false;
    const registry = activeActorRegistry(actorRefs.right);
    const authority = runtimeAuthority(scope, registry, canvasName, node);
    if (
      authority === undefined ||
      !isManagedSeatRuntimeLocal(canvasName, node, authority)
    ) {
      return false;
    }
    if (
      !pause.stateFor(canvasName).playing ||
      seatPaused(pause.stateFor(canvasName), doc, node.id)
    ) {
      return false;
    }

    return ensureManagedSeatRunning(canvasName, doc, node, authority);
  };

  // --- doc hydration + mid-cycle resync ---------------------------------------

  const hydrateDoc = async (
    name: string,
    generation: number,
  ): Promise<void> => {
    if (!generationIsActive(generation)) return;
    const result = await runPromise(Effect.either(canvases.read(name)));
    if (result._tag === "Right" && generationIsActive(generation)) {
      docs.set(name, result.right.doc);
    }
    // else: a broken/mid-write canvas is skipped this pass — one bad doc
    // never stalls hydration of the rest.
  };

  // Bounded concurrency — a station can accumulate many canvases; hydration
  // must not fan out one unbounded Promise.all across all of them at once.
  const MAX_CONCURRENT_HYDRATIONS = 4;

  const hydrateAllDocs = async (generation: number): Promise<void> => {
    if (!generationIsActive(generation)) return;
    const summaries = await runPromise(canvases.list);
    if (!generationIsActive(generation)) return;
    for (let i = 0; i < summaries.length; i += MAX_CONCURRENT_HYDRATIONS) {
      if (!generationIsActive(generation)) return;
      const batch = summaries.slice(i, i + MAX_CONCURRENT_HYDRATIONS);
      await Promise.all(
        batch.map((summary) => hydrateDoc(summary.name, generation)),
      );
    }
    if (generationIsActive(generation)) setDocs(docs);
  };

  // App-owned create/write/mutate -> reread into the map; delete -> drop +
  // purge its namespaced in-memory state. subscribeChanges only reports a
  // name, not the kind of change, so list() is the source of truth for
  // "still there". Every authority commit notifies this path.
  const resyncCanvas = async (name: string): Promise<void> => {
    const generation = activeGeneration();
    if (!generationIsActive(generation)) return;
    const summaries = await runPromise(canvases.list);
    if (!generationIsActive(generation)) return;
    if (!summaries.some((summary) => summary.name === name)) {
      docs.delete(name);
      purgeCanvasMemory(name);
      scheduleCycle();
      return;
    }

    const result = await runPromise(Effect.either(canvases.read(name)));
    if (result._tag === "Right" && generationIsActive(generation)) {
      docs.set(name, result.right.doc);
      void runPromise(refreshWithIdentityHints());
      scheduleCycle();
    }
    // else: transient read/decode failure (e.g. mid-write) — keep the
    // previously hydrated doc; the next app-owned change notification retries.
  };

  // Enrichment hints derive from identity resolution over every hydrated doc
  // against the CURRENT snapshot (shared/connections.ts). Cold start: the
  // first poll fetches base lists unhinted, the next resolves against them —
  // convergence within two cycles, by design.
  const refreshWithIdentityHints = () =>
    Effect.flatMap(snapshots.current, (state) => snapshots.refresh(identityHints(docs.values(), state)));

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

    start: () => {
      if (started || suspended) return;
      started = true;
      const generation = activeGeneration();
      void (async () => {
        await runPromise(pause.start);
        if (!generationIsActive(generation)) return;
        await hydrateAllDocs(generation);
        if (!generationIsActive(generation)) return;
        void runPromise(refreshWithIdentityHints());

        lifecycleCleanups = [
          canvases.subscribeChanges((name) => void resyncCanvas(name)),
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

        // No await exists between the generation check and installing these
        // handles, so suspend() cannot interleave and leave a late timer alive.
        if (!generationIsActive(generation)) {
          clearLifecycleScheduling();
          return;
        }

        // Repair/watchdog only. Ordinary document, snapshot, and seat
        // lifecycle progress schedules a cycle at the authoritative event.
        safetyInterval = setInterval(
          scheduleCycle,
          SAFETY_INTERVAL_MS,
        );

        scheduleCycle();
      })().catch((err) => console.error("[kernel] start() failed:", err));
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
    // Full ambient Context (CC AppRuntime / Remote RootLayer parents). Do not
    // use Effect.runtime<never>() — bridges must retain the warm graph so
    // Work/Content (and every other product service) stay visible. Cast only
    // satisfies Runtime.runPromise's R parameter; the captured Context object
    // still holds every service present at layer build.
    const runtime = yield* Effect.runtime();
    const runPromise: KernelRunPromise = <A, E>(effect: Effect.Effect<A, E>) =>
      Runtime.runPromise(runtime as Runtime.Runtime<never>)(
        effect as Effect.Effect<A, E, never>,
      );
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
      runPromise,
    );
  }),
);
