// KernelService — the Effect Tag + Live layer that runs kernel evaluation
// continuously over EVERY hydrated canvas, window-optional. This module owns
// lifecycle (hydration, doc resync, the 30s safety interval), binds cycle.ts's
// injectable seams to concrete main-side collaborators (CanvasesService,
// KernelStateRepository), and persists arming through normalized SQLite rows. See
// kernel-design.md for the full design.
//
// cycle.ts/evaluate.ts are the pure loop + evaluator (ported verbatim from
// the renderer in an earlier batch); this file is the only thing that binds
// their `__*ForTest`-named seams to something real. Despite the name, those
// setters ARE the production injection points — cycle.ts exposes no
// separately-named "prod" variant, by design (kernel-design.md §2, §7).

import { createHash } from "node:crypto";
import { Context, Effect, Layer, Schema } from "effect";
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
import { claimedByOf, taskBrief } from "@shared/task";
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
  ArmRegionResult,
  BindingHint,
  KernelSnapshot,
  PulseRecord,
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
import { KernelStateRepository } from "./repository";
import {
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
  deliverPulse,
  getArmed,
  getExecutionByCanvas,
  getNextFire,
  getPulseLog,
  getWatchers,
  purgeCanvasMemory,
  reconcileLiveCanvasMemory,
  retryPendingPulseDeliveries,
  runEvaluationCycle,
  setActorRefResolver,
  setArmed,
  setDocs,
  setPausedLookup,
  setStationScope,
  __setDeliveryDepsForTest,
  __setFlagWriterForTest,
  __setGlyphFetcherForTest,
  __setPhaseMirrorForTest,
  __setSnapshotsForTest,
  __setTimerSchedulerForTest,
} from "./cycle";

export interface PulseRegionOptions {
  readonly dry?: boolean;
  readonly summary?: string;
}

export class KernelService extends Context.Tag("@vellum/KernelService")<
  KernelService,
  {
    readonly doctor: Effect.Effect<ServiceCheck>;
    // Begin hydration + the evaluation loop. Idempotent, matching
    // CanvasesService.start()/SnapshotsService.start().
    readonly start: () => void;
    // Irreversibly stop admitting new kernel work. Existing terminal/agent
    // processes are deliberately untouched; work admitted before the cut may
    // settle, but no later cycle, claim, seat start, pulse, or arming mutation
    // may begin.
    readonly suspend: () => void;
    // Synchronous read of the current wire snapshot — used for getKernelState's
    // initial-hydrate answer.
    readonly getSnapshot: () => KernelSnapshot;
    readonly armRegion: (canvasName: string, regionId: string, armed: boolean) => Effect.Effect<ArmRegionResult>;
    readonly pulseRegion: (
      canvasName: string,
      regionId: string,
      opts?: PulseRegionOptions,
    ) => Effect.Effect<void>;
    // Pushed on cycle end + on arming/pulse changes — never per-watcher.
    readonly subscribe: (listener: (snapshot: KernelSnapshot) => void) => () => void;
  }
>() {}

const SAFETY_INTERVAL_MS = 30_000;
// Short poll purely for "did the off-cycle delivery queue append a record
// since we last pushed" — deliverPulse's queue (cycle.ts) drains
// fire-and-forget, off the evaluation cycle's critical path, with no
// completion hook exposed. Without this, a watcher-fired (as opposed to
// manual pulseRegion) delivery would only become visible to the renderer at
// the next full cycle (worst case SAFETY_INTERVAL_MS later). Cheap: just an
// array-length comparison, no evaluation work.
const PULSE_LOG_POLL_MS = 3_000;
export const KERNEL_OBSERVATION_PREFIX = "[vellum:kernel-observation] ";

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

const armedStoreKey = (canvasName: string, regionId: string): string => `${canvasName}::${regionId}`;

// Splits a `${canvasName}::${id}` module-memory key back into its parts.
// Canvas names are restricted to [a-z0-9-] (canvases.ts NAME_PATTERN) and
// node/region ids never contain "::", so the first occurrence is always the
// namespace boundary.
const splitNamespacedKey = (key: string): readonly [canvasName: string, id: string] | undefined => {
  const idx = key.indexOf("::");
  if (idx < 0) return undefined;
  return [key.slice(0, idx), key.slice(idx + 2)];
};

// Durable-intent invariant: an armed key whose canvas or region no longer
// exists in any hydrated document is ORPHANED — the arm-intent stays in the
// store and is surfaced in the snapshot; it is never silently dropped. With
// zero docs hydrated (early startup) no judgment is possible, so none is made.
export const computeOrphanedArming = (
  docs: ReadonlyMap<string, CanvasDoc>,
  armed: Iterable<readonly [string, boolean]>,
): ReadonlyArray<string> => {
  if (docs.size === 0) return [];
  const orphaned: string[] = [];
  for (const [key, value] of armed) {
    if (!value) continue;
    const split = splitNamespacedKey(key);
    if (!split) continue;
    const doc = docs.get(split[0]);
    if (!doc || !doc.nodes.some((node) => node.id === split[1])) orphaned.push(key);
  }
  return orphaned;
};

type CanvasesShape = Context.Tag.Service<typeof CanvasesService>;
type SnapshotsShape = Context.Tag.Service<typeof SnapshotsService>;
type KernelStateShape = Context.Tag.Service<typeof KernelStateRepository>;
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
  commit: () => boolean = () => true,
): Promise<ActiveStationScope> => {
  try {
    const current = await Effect.runPromise(
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
): string =>
  `delivery_${createHash("sha256")
    .update(
      JSON.stringify([
        "vellum/managed-task-delivery/v1",
        sink.canvasName,
        sink.nodeId,
        taskId,
        actorSeatId,
      ]),
      "utf8",
    )
    .digest("hex")}`;

const makeKernelService = (
  canvases: CanvasesShape,
  snapshots: SnapshotsShape,
  kernelState: KernelStateShape,
  pause: PauseShape,
  scheduler: SchedulerShape,
  fleetTargets: FleetTargetsShape,
  stations: StationsShape,
  livePeers: LivePeersShape,
  work: WorkShape,
  workRepository: WorkRepositoryShape,
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
  let pulseLogPollInterval: ReturnType<typeof setInterval> | undefined;

  const clearLifecycleScheduling = (): void => {
    if (safetyInterval !== undefined) {
      clearInterval(safetyInterval);
      safetyInterval = undefined;
    }
    if (pulseLogPollInterval !== undefined) {
      clearInterval(pulseLogPollInterval);
      pulseLogPollInterval = undefined;
    }
    for (const cleanup of lifecycleCleanups.splice(0)) {
      try {
        cleanup();
      } catch {
        // Suspension is fail-closed. One broken observer cleanup must not
        // prevent the remaining listeners from being detached.
      }
    }
  };

  // Pulse deliveries consult the pause plane per source seat; a canvas with
  // no tracked doc falls back to the canvas-level switch (fail closed).
  setPausedLookup((canvasName, sourceNodeId) => {
    const state = pause.stateFor(canvasName);
    if (!state.playing) return true;
    const doc = docs.get(canvasName);
    return doc ? seatPaused(state, doc, sourceNodeId) : true;
  });

  let started = false;
  let armingFault: string | undefined;
  let lastPulseLogLength = 0;

  const composeSnapshot = (): KernelSnapshot => {
    const canvasesOut: Record<
      string,
      {
        watchers: Record<string, WatcherRuntimeState>;
        armed: Record<string, boolean>;
        nextFire: Record<string, number>;
        execution?: import("./cycle").ExecutionSnapshot;
      }
    > = {};
    const entryFor = (name: string) => (canvasesOut[name] ??= { watchers: {}, armed: {}, nextFire: {} });
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
    for (const [key, value] of getArmed()) {
      if (!value) continue;
      const split = splitNamespacedKey(key);
      if (!split) continue;
      // An armed key whose canvas is not hydrated (deleted in-session, but the
      // arm-intent is deliberately preserved in memory — cycle.ts's
      // purgeCanvasMemory no longer drops it) must NOT conjure a phantom
      // healthy canvas entry here. It surfaces via orphanedArming instead.
      if (!docs.has(split[0])) continue;
      entryFor(split[0]).armed[split[1]] = value;
    }
    const orphanedArming = computeOrphanedArming(docs, getArmed());
    return {
      canvases: canvasesOut,
      pulseLog: getPulseLog() as ReadonlyArray<PulseRecord>,
      ...(armingFault !== undefined ? { fault: armingFault } : {}),
      ...(orphanedArming.length > 0 ? { orphanedArming } : {}),
    };
  };

  const emitSnapshot = (): void => {
    const snapshot = composeSnapshot();
    lastPulseLogLength = snapshot.pulseLog.length;
    for (const listener of snapshotListeners) listener(snapshot);
    // Durable debug state shares the app-owned SQLite connection. It is useful
    // after restart, but external processes must never open the live database.
    void Effect.runPromise(
      kernelState.replaceDebugPulseRing(snapshot.pulseLog),
    ).catch(() => undefined);
    // The packaged headless probe observes the main process over its bounded
    // stdout transport. This keeps the database single-owner even while the
    // probe waits for a pulse.
    if (process.env.VELLUM_KERNEL_OBSERVATIONS === "1") {
      console.log(
        `${KERNEL_OBSERVATION_PREFIX}${JSON.stringify({
          pulseLog: snapshot.pulseLog.slice(-20),
        })}`,
      );
    }
  };

  // Glyph rows for watchers/criteria: tests inject via __setGlyphFetcherForTest.
  // No production private-source fetch — leave unset (undefined → unavailable).
  __setGlyphFetcherForTest(undefined);

  // --- delivery: managed terminal seats, the one delivery path ----------------
  __setDeliveryDepsForTest({
    sendManagedTerminal: (bindingId, message) =>
      suspended
        ? Promise.resolve(false)
        : managedPulseDeliver(bindingId, message),
  });

  __setTimerSchedulerForTest({
    claimInterval: (input) =>
      Effect.runPromise(scheduler.claimInterval(input)),
    reconcileHome: (homeStation, activeTimerKeys) =>
      Effect.runPromise(
        scheduler.reconcileHome(homeStation, activeTimerKeys),
      ),
  });

  // Derived flags and edge phases are runtime projection only. They never
  // write back into the authorial canvas, especially on a Remote.
  __setFlagWriterForTest(undefined);
  __setPhaseMirrorForTest(undefined);

  // --- evaluation cycle --------------------------------------------------------

  // Seat creation must precede watcher/timer evaluation, but it is not itself
  // a factory claim tick. A newly-created seat can still be `starting` (and its
  // managed drive not ready), so cycle.ts retains zero-acceptance scheduled
  // pulses and this pre-pass offers them again on a later cycle.
  const startManagedSeats = (
    scope: ActiveStationScope,
    registry: ActiveActorRegistry,
    generation: number,
  ): void => {
    for (const [canvasName, doc] of docs) {
      if (!generationIsActive(generation)) return;
      const state = pause.stateFor(canvasName);
      if (!state.playing) continue;
      for (const node of doc.nodes) {
        if (!generationIsActive(generation)) return;
        if (seatPaused(state, doc, node.id)) continue;
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
      () => generationIsActive(generation),
    );
    if (!generationIsActive(generation)) return;
    const registry =
      scope.role === ""
        ? activeActorRegistry([])
        : activeActorRegistry(
            await Effect.runPromise(canvases.activeActorRefs()),
          );
    if (!generationIsActive(generation)) return;
    setActorRefResolver(registry.resolve);
    const currentSnapshots = await Effect.runPromise(snapshots.current);
    if (!generationIsActive(generation)) return;
    __setSnapshotsForTest(currentSnapshots);
    startManagedSeats(scope, registry, generation);
    if (!generationIsActive(generation)) return;
    retryPendingPulseDeliveries();
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
                await Effect.runPromise(fleetTargets.get(hostId))
              )?.stationInstallationId,
            isLive: (hostId, installationId) =>
              Effect.runPromise(livePeers.isLive(hostId, installationId)),
          },
        );
        if (selectable && generationIsActive(generation)) {
          selectableActorSeatIds.add(seatId);
        }
      }),
    );
    if (!generationIsActive(generation)) return;

    const busyActorSeatIds = new Set<ActorSeatId>();
    const pendingCommands = await Effect.runPromise(
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
          busyActorSeatIds,
        },
      );
      for (const selection of selections) {
        // This is the durable claim mutation boundary. A claim already
        // admitted here may settle after suspension; no later selection may
        // enter WorkService.
        if (!generationIsActive(generation)) return;
        const result = await Effect.runPromise(
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
          const deliveryId = managedTaskDeliveryId(
            sinkRef,
            task.id,
            actorSeatId,
          );
          if (
            await Effect.runPromise(
              workRepository.hasAcceptedDelivery(sinkRef, deliveryId),
            )
          ) {
            continue;
          }
          if (!generationIsActive(generation)) return;
          ensureManagedSeatRunning(canvasName, doc, actor, authority);
          // Final prompt-send admission. If suspension occurs while the
          // transport is accepting this already-admitted prompt, its receipt
          // is still allowed to settle below.
          if (!generationIsActive(generation)) return;
          const accepted = await managedPulseDeliver(
            surface.bindingId,
            [
              `[factory claim] task ${task.id}: ${taskBrief(task)}`,
              "",
              "You claimed this task from the factory pull queue.",
              "Run `vellum onboard`, do the work, and update it with `vellum tasks update`.",
              "If blocked on a human, use `vellum escalate`.",
            ].join("\n"),
          );
          if (!accepted) continue;

          // Record only after the managed transport accepted the prompt. This
          // durably suppresses restart replay. The send→receipt crash window
          // remains intentionally at-least-once until that transport accepts
          // an idempotency key; pre-writing would instead risk silent loss.
          const intentWitness = await Effect.runPromise(
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
          await Effect.runPromise(
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

  // --- doc hydration + mid-cycle resync ---------------------------------------

  const hydrateDoc = async (
    name: string,
    generation: number,
  ): Promise<void> => {
    if (!generationIsActive(generation)) return;
    const result = await Effect.runPromise(Effect.either(canvases.read(name)));
    if (result._tag === "Right" && generationIsActive(generation)) {
      docs.set(name, result.right.doc);
    }
    // else: a broken/mid-write canvas is skipped this pass — one bad doc
    // never stalls hydration of the rest.
  };

  // Bounded, like cycle.ts's own MAX_CONCURRENT_GLYPH_FETCHES batching — a
  // station can accumulate many canvases; hydration must not fan out one
  // unbounded Promise.all across all of them at once.
  const MAX_CONCURRENT_HYDRATIONS = 4;

  const hydrateAllDocs = async (generation: number): Promise<void> => {
    if (!generationIsActive(generation)) return;
    const summaries = await Effect.runPromise(canvases.list);
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
    const summaries = await Effect.runPromise(canvases.list);
    if (!generationIsActive(generation)) return;
    if (!summaries.some((summary) => summary.name === name)) {
      docs.delete(name);
      purgeCanvasMemory(name);
      scheduleCycle();
      return;
    }

    const result = await Effect.runPromise(Effect.either(canvases.read(name)));
    if (result._tag === "Right" && generationIsActive(generation)) {
      docs.set(name, result.right.doc);
      void Effect.runPromise(refreshWithIdentityHints());
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

  // --- arming: normalized SQLite rows, cycle.ts's in-memory map is the hot read

  // Durable-intent invariant: state that cannot be READ must not boot the
  // kernel silently disarmed — that is a silent disarm wearing an error's
  // clothes. On load failure the fault is surfaced in every snapshot, armed
  // regions are explicitly NOT resumed, and writes are refused. The kernel
  // itself keeps running.
  const hydrateArming = async (generation: number): Promise<void> => {
    if (!generationIsActive(generation)) return;
    const result = await Effect.runPromise(
      Effect.either(kernelState.listArmedRegions),
    );
    if (!generationIsActive(generation)) return;
    if (result._tag === "Left") {
      armingFault =
        `arming state unreadable (${result.left.message}) — armed regions were NOT resumed and arming ` +
        `changes will fail until the SQLite state is repaired; nothing was overwritten`;
      console.error(`[kernel] ${armingFault}`);
      return;
    }
    for (const armed of result.right) {
      if (!generationIsActive(generation)) return;
      setArmed(armedStoreKey(armed.canvasName, armed.regionId), true);
    }
  };

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

    start: () => {
      if (started || suspended) return;
      started = true;
      const generation = activeGeneration();
      void (async () => {
        await Effect.runPromise(pause.start);
        if (!generationIsActive(generation)) return;
        await hydrateArming(generation);
        if (!generationIsActive(generation)) return;
        await hydrateAllDocs(generation);
        if (!generationIsActive(generation)) return;
        void Effect.runPromise(refreshWithIdentityHints());

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
        pulseLogPollInterval = setInterval(() => {
          if (suspended) return;
          const length = getPulseLog().length;
          if (length !== lastPulseLogLength) emitSnapshot();
        }, PULSE_LOG_POLL_MS);

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

    armRegion: (canvasName, regionId, armedValue) =>
      Effect.gen(function* () {
        const generation = activeGeneration();
        if (!generationIsActive(generation)) {
          return {
            ok: false,
            error: "kernel suspended — no new arming changes are admitted",
          } as const;
        }
        // Fail fast under a boot-time arming fault: SQLite state could not be
        // read, so armed regions were NOT resumed and no write may proceed
        // (the corrupt rows must not be clobbered). The caller surfaces this.
        if (armingFault !== undefined) {
          return { ok: false, error: armingFault } as const;
        }
        const key = armedStoreKey(canvasName, regionId);
        // Persist FIRST (memory untouched on failure), then mutate memory.
        const stored = yield* Effect.either(
          kernelState.setRegionArmed(canvasName, regionId, armedValue),
        );
        if (stored._tag === "Left") {
          return {
            ok: false,
            error: `arming not saved (${stored.left.message}) — nothing changed; the region stays as it was`,
          } as const;
        }
        // The durable mutation was admitted before the suspension cut. Let
        // that in-flight operation settle into its matching hot-read state so
        // memory cannot diverge from SQLite.
        setArmed(key, armedValue);
        emitSnapshot();
        return { ok: true } as const;
      }),

    pulseRegion: (canvasName, regionId, opts) =>
      Effect.gen(function* () {
        const generation = activeGeneration();
        if (!generationIsActive(generation)) return;
        yield* Effect.promise(() =>
          deliverPulse({
            canvasName,
            sourceNodeId: regionId,
            kind: "manual",
            regionId,
            summary: opts?.summary ?? "manual pulse",
            forceDry: opts?.dry,
          }),
        );
        // Snapshot emission is observational; a pulse admitted before the cut
        // may finish and report its terminal record afterward.
        emitSnapshot();
      }),

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
    const kernelState = yield* KernelStateRepository;
    const pause = yield* PausePlane;
    const scheduler = yield* SchedulerRepository;
    const fleetTargets = yield* StationFleetTargetRepository;
    const stations = yield* StationRepository;
    const livePeers = yield* StationLivePeerRegistry;
    const work = yield* WorkService;
    const workRepository = yield* WorkRepository;
    return makeKernelService(
      canvases,
      snapshots,
      kernelState,
      pause,
      scheduler,
      fleetTargets,
      stations,
      livePeers,
      work,
      workRepository,
    );
  }),
);
