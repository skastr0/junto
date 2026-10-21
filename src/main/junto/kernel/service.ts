// KernelService — the Effect Tag + Live layer that runs kernel evaluation
// continuously over EVERY hydrated canvas, window-optional. This module owns
// lifecycle (hydration, world resync, the 30s safety interval) and binds
// cycle.ts's injectable seams to concrete main-side collaborators
// (ModelService, WorkService).
//
// cycle.ts/evaluate.ts are the pure loop + evaluator; this file is the only
// thing that binds their `__*ForTest`-named seams to something real. Despite
// the name, those setters ARE the production injection points — cycle.ts
// exposes no separately-named "prod" variant, by design.
//
// V4-KERNEL + V4-PROGRAM:
// kernel never owns Runtime/Effect promise entry. Domain Effects exit only
// through the host injected at start() from AppRuntime / RemoteRuntime
// (main boot): runPromise for Promise seams, runFork for the factory program.
// Factory control (cycle / claim / deliver / hydrate) is Effect.gen — not an
// async Promise control plane. Importing AppRuntime here is forbidden
// (circular: RootLayer includes KernelLive).

import type { SeatStartCause } from "../term/seat-start-cause";
import { Cause, Context, Effect, Layer } from "effect";
import { asNodeId } from "@shared/model/base";
import type { AgentSeatStateEvent } from "@shared/agent-seat-state";
import type { ActorRefResolver } from "@shared/attention";
import type { ServiceCheck } from "@shared/contracts";
import type { InstallationId } from "@shared/installation-id";
import type { ActorSeatId } from "@shared/actor-seat";
import type { ActorRef } from "@shared/work-protocol";
import type { KernelSnapshot } from "@shared/ipc";
import { ModelActorRefs } from "../model/actor-refs";
import { ModelService } from "../model/service";
import { PausePlane } from "../pause-plane";
import { MachineRepository } from "../machines/repository";
import { WorkService } from "../work/service";
import {
  ensureManagedSeatRunning,
  isManagedSeatRuntimeLocal,
  type ManagedSeatRuntimeAuthority,
} from "../term/ensure-managed-seat";
import { seatStateRuntime } from "../term/agent-state";
import { ActorSeatOccupy } from "../term/actor-seat-occupy";
import {
  getExecutionByCanvas,
  purgeCanvasMemory,
  runEvaluationCycle,
  setActorRefResolver,
  setWorlds,
  type ExecutionSnapshot,
} from "./cycle";
import type { World } from "./world";
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
      // Why the seat starts: mail by default.
      options?: { readonly cause?: SeatStartCause },
    ) => Promise<boolean>;
    // Begin hydration + the evaluation loop. Idempotent.
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
  }>()("@junto/KernelService") {}

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
 * | simulation   | `cycle`               | the evaluation pass                 |
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

type ModelShape = Context.Service.Shape<typeof ModelService>;
type ActorRefsShape = Context.Service.Shape<typeof ModelActorRefs>;
type PauseShape = Context.Service.Shape<typeof PausePlane>;
type MachinesShape = Context.Service.Shape<typeof MachineRepository>;
type WorkShape = Context.Service.Shape<typeof WorkService>;
type KernelServiceShape = Context.Service.Shape<typeof KernelService>;

/**
 * Host-owned Effect entry for kernel (AppRuntime / RemoteRuntime).
 * Bound once at start() from main boot — never constructed inside kernel.
 *
 * - runPromise: Promise seams (rare host bridges)
 * - runFork: factory program (hydration + coalesced evaluation cycle)
 */
export type KernelHost = {
  readonly runPromise: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
  readonly runFork: <A, E>(effect: Effect.Effect<A, E>) => void;
};

type ActiveMachineScope =
  | { readonly ready: false }
  | { readonly ready: true; readonly machineName: string; readonly installationId: InstallationId };

const refreshMachineScope = (
  machines: MachinesShape,
  commit: () => boolean = () => true,
): Effect.Effect<ActiveMachineScope> => Effect.gen(function* () {
  const current = yield* Effect.result(Effect.all({
    installationId: machines.installationId,
    machineName: machines.machineName,
  }));
  const scope: ActiveMachineScope = current._tag === "Failure"
    ? { ready: false }
    : { ready: true, ...current.success };
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
  scope: ActiveMachineScope,
  registry: ActiveActorRegistry,
  canvasName: string,
  node: { readonly id: string },
): ManagedSeatRuntimeAuthority | undefined => {
  if (!scope.ready) return undefined;
  const actor = registry.resolve({ canvasName, nodeId: node.id });
  return actor === undefined
    ? undefined
    : {
        actor,
        installationId: scope.installationId,
        hostId: scope.machineName,
      };
};

const makeKernelService = (
  model: ModelShape,
  actorRefs: ActorRefsShape,
  pause: PauseShape,
  machines: MachinesShape,
  work: WorkShape,
  actorSeatOccupy: Context.Service.Shape<typeof ActorSeatOccupy>,
): KernelServiceShape => {
  // What the cycle reads: each canvas as the model holds it, and beside it
  // the work the work service answers for it.
  const worlds = new Map<string, World>();
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
  const clearLifecycleScheduling = (): void => {
    if (safetyInterval !== undefined) {
      clearInterval(safetyInterval);
      safetyInterval = undefined;
    }
    // Suspension is monotonic: no later slice may start, whatever is queued.
    kernelTick?.stop();
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
    const canvasesOut: Record<string, { execution?: ExecutionSnapshot }> = {};
    for (const name of worlds.keys()) {
      const execution = getExecutionByCanvas().get(name);
      canvasesOut[name] = execution === undefined ? {} : { execution };
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

  // --- evaluation cycle --------------------------------------------------------

  const runCycle: Effect.Effect<void, unknown> = Effect.gen(function* () {
    const generation = activeGeneration();
    if (!generationIsActive(generation)) return;
    const scope = yield* refreshMachineScope(machines, () =>
      generationIsActive(generation),
    );
    if (!generationIsActive(generation)) return;
    const registry =
      !scope.ready
        ? activeActorRegistry([])
        : activeActorRegistry(yield* actorRefs.read());
    if (!generationIsActive(generation)) return;
    setActorRefResolver(registry.resolve);
    runEvaluationCycle();
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
    cause: SeatStartCause,
  ): Effect.Effect<boolean, unknown> =>
    Effect.gen(function* () {
      // Every refusal names itself: a silent false here previously left mail
      // pending forever with no operator-visible trace anywhere.
      const refuse = (reason: string): false => {
        console.error(`[wake] refused ${canvasName}/${nodeId}: ${reason}`);
        return false;
      };
      const generation = activeGeneration();
      if (!generationIsActive(generation)) {
        return refuse("the kernel is not running (suspended, or not started)");
      }
      // Node-scoped: every question below this line is structural — the seat
      // on one node, its compiled actor reference and its canvas's pause
      // state. None of them reads a Work lane. The model answers from the
      // canvas it holds, so a stale kernel world cannot mint a process.
      const read = yield* Effect.result(model.canvas(canvasName));
      if (!generationIsActive(generation)) return false;
      if (read._tag === "Failure") return refuse("canvas read failed");
      const node = read.success.nodes.get(asNodeId(nodeId));
      if (node === undefined) {
        return refuse("node is not on the canvas");
      }

      const scope = yield* refreshMachineScope(machines, () =>
        generationIsActive(generation),
      );
      if (!generationIsActive(generation)) return false;
      if (!scope.ready) return refuse("machine identity unavailable");

      const refs = yield* Effect.result(actorRefs.read());
      if (!generationIsActive(generation)) return false;
      if (refs._tag === "Failure") {
        return refuse("active actor portfolio unavailable");
      }
      const registry = activeActorRegistry(refs.success);
      const authority = runtimeAuthority(scope, registry, canvasName, node);
      if (authority === undefined) {
        return refuse("actor reference is not in the compiled portfolio");
      }
      const seat = node.kind === "agent" ? node : undefined;
      if (
        seat === undefined ||
        !isManagedSeatRuntimeLocal(canvasName, seat, authority)
      ) {
        return refuse("seat is not local to this installation");
      }
      if (!pause.stateFor(canvasName).playing) {
        return refuse("canvas is not playing");
      }

      return yield* ensureManagedSeatRunning(
        canvasName,
        seat,
        authority,
        actorSeatOccupy,
        cause,
      );
    });

  const wakeManagedSeat = (
    canvasName: string,
    nodeId: string,
    options?: { readonly cause?: SeatStartCause },
  ): Promise<boolean> =>
    Promise.resolve()
      .then(() => {
        // Said once per wake, so a log with no wake line means nobody asked.
        console.info(`[wake] asked ${canvasName}/${nodeId}`);
        return run(wakeManagedSeatProgram(canvasName, nodeId, options?.cause ?? "mail"));
      })
      .then(
        (started) => {
          if (started) console.info(`[wake] started ${canvasName}/${nodeId}`);
          return started;
        },
        (error: unknown) => {
          // The callers of a wake treat a throw as "not woken" and say
          // nothing; this is the one place the reason can be written down.
          console.error(
            `[wake] failed ${canvasName}/${nodeId}: ${error instanceof Error ? error.message : String(error)}`,
          );
          return false;
        },
      );

  // --- world hydration + mid-cycle resync -------------------------------------

  const hydrateWorld = (
    name: string,
    generation: number,
  ): Effect.Effect<void, unknown> =>
    Effect.gen(function* () {
      if (!generationIsActive(generation)) return;
      const result = yield* Effect.result(
        Effect.all({
          canvas: model.canvas(name),
          work: work.readKernelWork(name),
        }),
      );
      if (result._tag === "Success" && generationIsActive(generation)) {
        worlds.set(name, result.success);
      }
      // else: a canvas that cannot be read is skipped this pass — one bad
      // canvas never stalls hydration of the rest.
    });

  // Bounded concurrency — a station can accumulate many canvases; hydration
  // must not fan out one unbounded Promise.all across all of them at once.
  const MAX_CONCURRENT_HYDRATIONS = 4;

  const hydrateAllWorlds = (
    generation: number,
  ): Effect.Effect<void, unknown> =>
    Effect.gen(function* () {
      if (!generationIsActive(generation)) return;
      const names = yield* model.listCanvases();
      if (!generationIsActive(generation)) return;
      yield* Effect.forEach(
        names,
        (name) => hydrateWorld(name, generation),
        { concurrency: MAX_CONCURRENT_HYDRATIONS },
      );
      if (generationIsActive(generation)) setWorlds(worlds);
    });

  // A change to a canvas or to its work -> read both again; a canvas that is
  // gone -> drop it and purge its namespaced in-memory state. The model's list
  // is the source of truth for "still there".
  const resyncCanvas = (name: string): Effect.Effect<void, unknown> =>
    Effect.gen(function* () {
      const generation = activeGeneration();
      if (!generationIsActive(generation)) return;
      const names = yield* model.listCanvases();
      if (!generationIsActive(generation)) return;
      if (!names.some((held) => held === name)) {
        worlds.delete(name);
        purgeCanvasMemory(name);
        scheduleCycle();
        return;
      }

      const before = worlds.get(name);
      yield* hydrateWorld(name, generation);
      if (worlds.get(name) !== before && generationIsActive(generation)) {
        scheduleCycle();
      }
      // else: transient read failure — keep the world already held; the next
      // change notification retries.
    });

  const startProgram = (
    generation: number,
  ): Effect.Effect<void, unknown> =>
    Effect.gen(function* () {
      yield* pause.start;
      if (!generationIsActive(generation)) return;
      yield* hydrateAllWorlds(generation);
      if (!generationIsActive(generation)) return;

      lifecycleCleanups = [
        // Immediate lane, keyed by canvas: a burst of commits on one canvas
        // now costs ONE re-read instead of one fork per notification.
        model.subscribeChanges((event) => {
          scheduleResync(event.canvas);
        }),
        model.subscribeCanvasesChanges((event) => {
          scheduleResync(event.canvas);
        }),
        // Task, request, board and artifact rows; mail never resyncs the kernel.
        work.subscribeWorkChanges((canvasName) => {
          if (canvasName !== undefined) scheduleResync(canvasName);
          else for (const name of worlds.keys()) scheduleResync(name);
        }),
        // Play/pause is an authoritative runtime transition. Resume must
        // claim immediately; pause must promptly cause the next cycle to
        // observe the closed gate instead of waiting for the 30s watchdog.
        subscribeKernelPauseWake(pause.subscribe, scheduleCycle),
        subscribeKernelSeatWake(
          (listener) => seatStateRuntime.subscribe(listener),
          scheduleCycle,
        ),
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
    // Effect.sync, not Effect.succeed: the report reads worlds.size at CALL
    // time, not at layer-build time (when it is always 0, before any
    // hydration) — a live count, not a frozen one.
    doctor: Effect.sync(() => ({
      id: "kernel",
      label: "Kernel",
      status: "ok" as const,
      detail: `${worlds.size} canvas(es) hydrated`,
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

  });
};

export const KernelLive = Layer.effect(
  KernelService,
  Effect.gen(function* () {
    const model = yield* ModelService;
    const actorRefs = yield* ModelActorRefs;
    const pause = yield* PausePlane;
    const machines = yield* MachineRepository;
    const work = yield* WorkService;
    const actorSeatOccupy = yield* ActorSeatOccupy;
    // No Runtime capture (V4-KERNEL / V4-PROGRAM / migration/runtime.md).
    // Domain Effects exit only after start(host) binds AppRuntime / RemoteRuntime.
    return makeKernelService(
      model,
      actorRefs,
      pause,
      machines,
      work,
      actorSeatOccupy,
    );
  }),
);
