import {
  Clock,
  Context,
  Deferred,
  Duration,
  Effect,
  FiberMap,
  Layer,
  Option,
  Queue,
  Random,
  Ref,
  Schema,
} from "effect";
import {
  InstallationId,
  StationHostId,
  type ReportRequest,
  type StationReadiness,
} from "@shared/station-api";
import {
  HostId,
  type HostId as HostIdValue,
} from "@shared/remote-hosts";
import { stationControlOk } from "@shared/station-api-envelope";
import type { StationProtocolObservation } from "@shared/station-status";
import {
  CanvasesService,
} from "../canvases";
import {
  parseHostSshRoute,
} from "../ssh/domain";
import {
  resolveRemotePackagedPlatform,
} from "../ssh/read-commands";
import {
  SshTransport,
} from "../ssh/service";
import { StationContextTagIds } from "./context-services";
import {
  findHostById,
  subscribeHostsSnapshot,
} from "../hosts/snapshot";
import {
  WorkRepository,
} from "../work/repository";
import {
  StationApiService,
} from "./api";
import {
  stationControlErrorEnvelope,
} from "./dispatcher";
import {
  StationFleetTargetRepository,
  type StationFleetTarget,
  type StationFleetTargetRepositoryError,
} from "./fleet-target-repository";
import {
  admitEnrolledOpenSshStationPeer,
} from "./openssh-peer-exchange";
import {
  StationPeerExchange,
  type StationPeerExchangeError,
  type StationPeerRoute,
} from "./peer-exchange";
import {
  type StationPeerProtocolBinding,
  type StationPeerSessionClosedError,
} from "./peer-session";
import {
  StationPropagation,
  type StationPropagationError,
  type StationPropagationReceipt,
  type StationPropagationTarget,
} from "./propagation";
import {
  StationLivePeerRegistry,
  type StationLivePeerUnavailable,
} from "./session-registry";

export const STATION_FLEET_RECONNECT_MIN_MS = 250;
export const STATION_FLEET_RECONNECT_MAX_MS = 30_000;
export const STATION_FLEET_STABLE_SESSION_MS = 30_000;
export const STATION_FLEET_SYNCHRONIZE_TIMEOUT_MS = 15_000;
export const STATION_FLEET_MAX_WAITERS_PER_TARGET = 64;

const READY: StationReadiness = {
  database: true,
  workControl: true,
  simulation: true,
  session: true,
};

export class StationPeerRouteResolutionError extends Schema.TaggedError<StationPeerRouteResolutionError>()(
  "StationPeerRouteResolutionError",
  {
    hostId: HostId,
    stationInstallationId: InstallationId,
    reason: Schema.Literal(
      "missing-route",
      "invalid-route",
      "platform-unavailable",
    ),
    message: Schema.String,
  },
) {}

export class StationFleetPeerUnavailable extends Schema.TaggedError<StationFleetPeerUnavailable>()(
  "StationFleetPeerUnavailable",
  {
    hostId: HostId,
    stationInstallationId: Schema.optionalWith(InstallationId, {
      exact: true,
    }),
    reason: Schema.Literal(
      "not-enrolled",
      "not-running",
      "route-unavailable",
      "connection-failed",
      "update-required",
      "synchronization-failed",
      "deadline",
      "stopped",
    ),
    causeTag: Schema.optionalWith(Schema.String, { exact: true }),
    message: Schema.String,
  },
) {}

export type StationFleetPeerPhase =
  | "connecting"
  | "synchronizing"
  | "ready"
  | "update-required"
  | "backoff"
  | "stopped";

export type StationFleetPeerStatus = {
  readonly hostId: HostIdValue;
  readonly stationInstallationId: StationFleetTarget["stationInstallationId"];
  readonly phase: StationFleetPeerPhase;
  readonly sessionOpen: boolean;
  readonly attempt: number;
  readonly updatedAt: string;
  readonly nextRetryAt?: string;
  readonly protocol?: StationProtocolObservation;
  readonly lastReceipt?: StationPropagationReceipt;
  readonly lastFailure?: StationFleetPeerUnavailable;
};

export type StationFleetPropagationResult =
  | {
      readonly ok: true;
      readonly hostId: HostIdValue;
      readonly stationInstallationId:
        StationFleetTarget["stationInstallationId"];
      readonly receipt: StationPropagationReceipt;
      readonly status: StationFleetPeerStatus;
    }
  | {
      readonly ok: false;
      readonly hostId: HostIdValue;
      readonly stationInstallationId?:
        StationFleetTarget["stationInstallationId"];
      readonly error: StationFleetPeerUnavailable;
      readonly status?: StationFleetPeerStatus;
    };

/**
 * Transport admission port. The supervisor understands enrolled peer
 * identity only; OpenSSH endpoint/platform mechanics remain in this adapter.
 */
// S4-station: single canonical Context.Tag (effect@3.21). V4 → Context.Service.
export class StationPeerRouteResolver extends Context.Tag(
  StationContextTagIds.peerRouteResolver,
)<
  StationPeerRouteResolver,
  {
    readonly resolve: (
      target: StationPropagationTarget,
    ) => Effect.Effect<
      StationPeerRoute,
      StationPeerRouteResolutionError
    >;
  }
>() {}

const routeResolutionError = (
  target: StationPropagationTarget,
  reason: StationPeerRouteResolutionError["reason"],
  message: string,
): StationPeerRouteResolutionError =>
  StationPeerRouteResolutionError.make({
    hostId: target.hostId,
    stationInstallationId: target.stationInstallationId,
    reason,
    message,
  });

export const OpenSshStationPeerRouteResolverLive = Layer.effect(
  StationPeerRouteResolver,
  Effect.map(SshTransport, (ssh) =>
    StationPeerRouteResolver.of({
      resolve: (target) =>
        Effect.gen(function* () {
          const host = findHostById(target.hostId);
          if (host?.kind !== "remote" || host.sshEndpoint === undefined) {
            return yield* routeResolutionError(
              target,
              "missing-route",
              "Station host has no enrolled SSH route",
            );
          }
          const endpoint = yield* parseHostSshRoute(host).pipe(
            Effect.mapError(() =>
              routeResolutionError(
                target,
                "invalid-route",
                "Station SSH route is invalid",
              )
            ),
          );
          const platform = yield* resolveRemotePackagedPlatform(
            ssh,
            endpoint,
          ).pipe(
            Effect.mapError(() =>
              routeResolutionError(
                target,
                "platform-unavailable",
                "Station packaged platform is unavailable",
              )
            ),
          );
          return admitEnrolledOpenSshStationPeer({
            peerInstallationId: target.stationInstallationId,
            endpoint,
            platform,
          });
        }).pipe(Effect.withSpan("station.fleet.resolve-route")),
    }),
  ),
);

// S4-station: single canonical Context.Tag (effect@3.21). V4 → Context.Service.
export class StationFleetPropagation extends Context.Tag(
  StationContextTagIds.fleetPropagation,
)<
  StationFleetPropagation,
  {
    /** Start one scoped child per current enrolled fleet target. */
    readonly start: () => Effect.Effect<
      void,
      StationFleetTargetRepositoryError
    >;
    /**
     * Synchronously and monotonically close outbound admission. Callers then
     * run `stop` to interrupt and await the exact worker/session teardown.
     */
    readonly beginShutdown: () => void;
    /** Fire-and-coalesce invalidation onto existing scoped workers. */
    readonly request: (
      hostId?: HostIdValue,
    ) => Effect.Effect<void>;
    /**
     * Await one bounded reconciliation on selected existing workers. This
     * never opens a second connection or falls back to one-shot Station RPC.
     */
    readonly synchronize: (
      hostId?: HostIdValue,
    ) => Effect.Effect<
      ReadonlyArray<StationFleetPropagationResult>,
      StationFleetTargetRepositoryError
    >;
    readonly status: (
      hostId: HostIdValue,
    ) => Effect.Effect<StationFleetPeerStatus | undefined>;
    readonly statuses: Effect.Effect<
      ReadonlyArray<StationFleetPeerStatus>
    >;
    /** Interrupt all target scopes and reject outstanding waiters. */
    readonly stop: Effect.Effect<void>;
  }
>() {}

type AttemptError =
  | StationPeerRouteResolutionError
  | StationPeerExchangeError
  | StationPropagationError
  | StationLivePeerUnavailable
  | StationPeerSessionClosedError;

type WorkerWaiter = Deferred.Deferred<StationFleetPropagationResult>;

interface WorkerControl {
  readonly target: StationFleetTarget;
  readonly propagationTarget: StationPropagationTarget;
  readonly wake: Queue.Queue<void>;
  readonly waiters: Ref.Ref<ReadonlyArray<WorkerWaiter>>;
}

type Lifecycle = "idle" | "running" | "stopped";

const causeTag = (error: unknown): string | undefined =>
  typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    typeof error._tag === "string"
    ? error._tag
    : undefined;

const unavailable = (
  hostId: HostIdValue,
  stationInstallationId:
    | StationFleetTarget["stationInstallationId"]
    | undefined,
  reason: StationFleetPeerUnavailable["reason"],
  message: string,
  error?: unknown,
): StationFleetPeerUnavailable =>
  StationFleetPeerUnavailable.make({
    hostId,
    ...(stationInstallationId === undefined
      ? {}
      : { stationInstallationId }),
    reason,
    ...(causeTag(error) === undefined
      ? {}
      : { causeTag: causeTag(error) }),
    message,
  });

const unavailableFromAttempt = (
  target: StationFleetTarget,
  error: AttemptError,
): StationFleetPeerUnavailable => {
  if (error instanceof StationPeerRouteResolutionError) {
    return unavailable(
      target.hostId,
      target.stationInstallationId,
      "route-unavailable",
      error.message,
      error,
    );
  }
  if (
    error._tag === "StationPeerExchangeError" &&
    error.reason === "protocol-incompatible"
  ) {
    return unavailable(
      target.hostId,
      target.stationInstallationId,
      "update-required",
      "Remote is running locally — Station protocol update required",
      error,
    );
  }
  if (
    error._tag === "StationPeerExchangeError" ||
    error._tag === "StationPeerSessionClosedError" ||
    error._tag === "StationLivePeerUnavailable"
  ) {
    return unavailable(
      target.hostId,
      target.stationInstallationId,
      "connection-failed",
      "persistent Station session is unavailable",
      error,
    );
  }
  return unavailable(
    target.hostId,
    target.stationInstallationId,
    "synchronization-failed",
    "Station synchronization failed",
    error,
  );
};

const protocolObservationFromBinding = (
  binding: StationPeerProtocolBinding,
): StationProtocolObservation =>
  ({
    compatibility: binding.compatibility,
    negotiatedProtocol: binding.negotiatedProtocol,
    local: binding.local,
    peer: binding.peer,
  });

const protocolObservationFromAttempt = (
  error: AttemptError,
): StationProtocolObservation | undefined =>
  error._tag === "StationPeerExchangeError" &&
    error.reason === "protocol-incompatible" &&
    error.localProtocol !== undefined &&
    error.peerProtocol !== undefined
    ? {
        compatibility: "update-required",
        local: error.localProtocol,
        peer: error.peerProtocol,
      }
    : undefined;

/**
 * Transport loss is retried autonomously. Configuration, identity, protocol,
 * and explicit non-retryable peer failures park until a product invalidation
 * or an operator synchronization request wakes the target.
 */
const retryWithoutInvalidation = (error: AttemptError): boolean => {
  switch (error._tag) {
    case "StationPeerRouteResolutionError":
      return false;
    case "StationPeerExchangeError":
      return error.reason === "connect-failed";
    case "StationPeerSessionClosedError":
      return true;
    case "StationPeerRejectedError":
      return error.retryable;
    case "StationPeerSessionProtocolError":
      return false;
    case "StationLivePeerUnavailable":
      return (
        error.reason === "session-closed" ||
        error.reason === "unavailable"
      );
    case "StationPropagationInvariantError":
      return (
        error.reason === "database-unavailable" ||
        error.reason === "work-control-unavailable" ||
        error.reason === "simulation-unavailable" ||
        error.reason === "session-unavailable" ||
        error.reason === "report-round-limit"
      );
    case "StationApiInvariantError":
      return false;
    default:
      return true;
  }
};

const toPropagationTarget = (
  target: StationFleetTarget,
): StationPropagationTarget => ({
  stationInstallationId: target.stationInstallationId,
  hostId: Schema.decodeUnknownSync(StationHostId)(target.hostId),
});

const retryDelay = (
  failureCount: number,
): Effect.Effect<number> =>
  Random.next.pipe(
    Effect.map((random) => {
      const exponential = Math.min(
        STATION_FLEET_RECONNECT_MAX_MS,
        STATION_FLEET_RECONNECT_MIN_MS *
          2 ** Math.min(failureCount, 16),
      );
      const jitter = 0.8 + random * 0.4;
      return Math.max(
        STATION_FLEET_RECONNECT_MIN_MS,
        Math.min(
          STATION_FLEET_RECONNECT_MAX_MS,
          Math.round(exponential * jitter),
        ),
      );
    }),
  );

const nowIso = Clock.currentTimeMillis.pipe(
  Effect.map((now) => new Date(now).toISOString()),
);

export const StationFleetPropagationLive = Layer.scoped(
  StationFleetPropagation,
  Effect.gen(function* () {
    const targets = yield* StationFleetTargetRepository;
    const propagation = yield* StationPropagation;
    const routeResolver = yield* StationPeerRouteResolver;
    const exchange = yield* StationPeerExchange;
    const livePeers = yield* StationLivePeerRegistry;
    const api = yield* StationApiService;
    const canvases = yield* CanvasesService;
    const work = yield* WorkRepository;

    const fibers = yield* FiberMap.make<HostIdValue, void, never>();
    const lifecycle = yield* Ref.make<Lifecycle>("idle");
    const peerStatuses = yield* Ref.make<
      ReadonlyMap<HostIdValue, StationFleetPeerStatus>
    >(new Map());
    const reconcileLock = yield* Effect.makeSemaphore(1);
    const invalidations = yield* Queue.dropping<void>(1);
    const workers = new Map<HostIdValue, WorkerControl>();
    const pendingInvalidationHosts = new Set<HostIdValue>();
    let pendingInvalidateAll = false;
    // Synchronous process-lifetime cut used by license revocation and normal
    // shutdown. Effect Ref remains the observable lifecycle; this boolean
    // prevents continuations already suspended at an async boundary from
    // opening or writing another Station session before worker interruption
    // finishes.
    let admissionClosed = false;

    const readStatuses = Ref.get(peerStatuses).pipe(
      Effect.map((current) =>
        [...current.values()].sort((left, right) =>
          left.hostId.localeCompare(right.hostId)
        )
      ),
    );

    const readStatus = (hostId: HostIdValue) =>
      Ref.get(peerStatuses).pipe(
        Effect.map((current) => current.get(hostId)),
      );

    const setStatus = (
      target: StationFleetTarget,
      update: Omit<
        StationFleetPeerStatus,
        "hostId" | "stationInstallationId" | "updatedAt"
      >,
    ): Effect.Effect<StationFleetPeerStatus> =>
      Effect.gen(function* () {
        const updatedAt = yield* nowIso;
        const status: StationFleetPeerStatus = {
          hostId: target.hostId,
          stationInstallationId: target.stationInstallationId,
          updatedAt,
          ...update,
        };
        yield* Ref.update(peerStatuses, (current) => {
          const next = new Map(current);
          next.set(target.hostId, status);
          return next;
        });
        return status;
      });

    const markTargetStopped = (
      target: StationFleetTarget,
      message: string,
    ): Effect.Effect<{
      readonly failure: StationFleetPeerUnavailable;
      readonly status: StationFleetPeerStatus;
    }> =>
      Effect.gen(function* () {
        const failure = unavailable(
          target.hostId,
          target.stationInstallationId,
          "stopped",
          message,
        );
        const previous = yield* readStatus(target.hostId);
        const status = yield* setStatus(target, {
          phase: "stopped",
          sessionOpen: false,
          attempt: 0,
          ...(previous?.protocol === undefined
            ? {}
            : { protocol: previous.protocol }),
          lastFailure: failure,
        });
        return { failure, status };
      });

    const successResult = (
      target: StationFleetTarget,
      receipt: StationPropagationReceipt,
      status: StationFleetPeerStatus,
    ): StationFleetPropagationResult => ({
      ok: true,
      hostId: target.hostId,
      stationInstallationId: target.stationInstallationId,
      receipt,
      status,
    });

    const failureResult = (
      target: StationFleetTarget,
      error: StationFleetPeerUnavailable,
      status?: StationFleetPeerStatus,
    ): StationFleetPropagationResult => ({
      ok: false,
      hostId: target.hostId,
      stationInstallationId: target.stationInstallationId,
      error,
      ...(status === undefined ? {} : { status }),
    });

    const completeWaiters = (
      control: WorkerControl,
      result: StationFleetPropagationResult,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const waiters = yield* Ref.getAndSet(control.waiters, []);
        yield* Effect.forEach(
          waiters,
          (waiter) => Deferred.succeed(waiter, result),
          { discard: true },
        );
      });

    const synchronizeSession = (
      control: WorkerControl,
      session: Parameters<
        Context.Tag.Service<typeof StationLivePeerRegistry>["activate"]
      >[2],
      attempt: number,
    ): Effect.Effect<StationPropagationReceipt, StationPropagationError> =>
      Effect.gen(function* () {
        const previous = yield* readStatus(control.target.hostId);
        yield* setStatus(control.target, {
          phase: "synchronizing",
          sessionOpen: true,
          attempt,
          protocol: protocolObservationFromBinding(session.protocol),
          ...(previous?.lastReceipt === undefined
            ? {}
            : { lastReceipt: previous.lastReceipt }),
        });
        const receipt = yield* propagation.synchronize(
          control.propagationTarget,
          session,
        );
        return receipt;
      });

    const markSynchronized = (
      control: WorkerControl,
      receipt: StationPropagationReceipt,
      attempt: number,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const previous = yield* readStatus(control.target.hostId);
        const status = yield* setStatus(control.target, {
          phase: "ready",
          sessionOpen: true,
          attempt,
          ...(previous?.protocol === undefined
            ? {}
            : { protocol: previous.protocol }),
          lastReceipt: receipt,
        });
        yield* completeWaiters(
          control,
          successResult(control.target, receipt, status),
        );
      });

    const worker = (
      control: WorkerControl,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        let failureCount = 0;
        let attempt = 0;

        while (!admissionClosed) {
          attempt += 1;
          let synchronizedAt: number | undefined;
          const beforeConnect = yield* readStatus(
            control.target.hostId,
          );
          yield* setStatus(control.target, {
            phase: "connecting",
            sessionOpen: false,
            attempt,
            ...(beforeConnect?.protocol === undefined
              ? {}
              : { protocol: beforeConnect.protocol }),
            ...(beforeConnect?.lastReceipt === undefined
              ? {}
              : { lastReceipt: beforeConnect.lastReceipt }),
          });

          const attempted = yield* Effect.scoped(
            Effect.gen(function* () {
              if (admissionClosed) return;
              const route = yield* routeResolver.resolve(
                control.propagationTarget,
              );
              if (admissionClosed) return;
              const onRemoteReport = (request: ReportRequest) =>
                api.handle(
                  request,
                  READY,
                  {
                    _tag: "enrolled-remote",
                    installationId:
                      control.target.stationInstallationId,
                  },
                ).pipe(
                  Effect.tap((response) =>
                    Effect.sync(() => {
                      if (
                        request.batch.hasMore ||
                        (
                          response.op === "report" &&
                          response.batch.hasMore
                        )
                      ) {
                        control.wake.unsafeOffer(undefined);
                      }
                    })
                  ),
                  Effect.map(stationControlOk),
                  Effect.catchAll((error) =>
                    Effect.succeed(
                      stationControlErrorEnvelope(error),
                    )
                  ),
                );
              const session = yield* exchange.open(
                route,
                onRemoteReport,
              );
              if (admissionClosed) return;
              const receipt = yield* synchronizeSession(
                control,
                session,
                attempt,
              );
              if (admissionClosed) return;
              yield* livePeers.activate(
                control.target.hostId,
                control.target.stationInstallationId,
                session,
              );
              synchronizedAt = yield* Clock.currentTimeMillis;
              yield* markSynchronized(
                control,
                receipt,
                attempt,
              );

              while (!admissionClosed) {
                yield* Effect.raceFirst(
                  Queue.take(control.wake),
                  session.awaitClosed.pipe(
                    Effect.flatMap(Effect.fail),
                  ),
                );
                if (admissionClosed) return receipt;
                const nextReceipt = yield* synchronizeSession(
                  control,
                  session,
                  attempt,
                );
                yield* markSynchronized(
                  control,
                  nextReceipt,
                  attempt,
                );
              }

              return receipt;
            }),
          ).pipe(Effect.either);

          if (admissionClosed) return;
          if (attempted._tag === "Right") continue;

          const failure = unavailableFromAttempt(
            control.target,
            attempted.left,
          );
          const currentTime = yield* Clock.currentTimeMillis;
          if (
            synchronizedAt !== undefined &&
            currentTime - synchronizedAt >=
              STATION_FLEET_STABLE_SESSION_MS
          ) {
            failureCount = 0;
          }
          const retryable = retryWithoutInvalidation(attempted.left);
          const delay = retryable
            ? yield* retryDelay(failureCount)
            : undefined;
          failureCount = retryable ? failureCount + 1 : 0;
          const beforeBackoff = yield* readStatus(
            control.target.hostId,
          );
          const incompatibleProtocol = protocolObservationFromAttempt(
            attempted.left,
          );
          const status = yield* setStatus(control.target, {
            phase: failure.reason === "update-required"
              ? "update-required"
              : "backoff",
            sessionOpen: false,
            attempt,
            ...(incompatibleProtocol !== undefined
              ? { protocol: incompatibleProtocol }
              : beforeBackoff?.protocol === undefined
                ? {}
                : { protocol: beforeBackoff.protocol }),
            ...(delay === undefined
              ? {}
              : {
                  nextRetryAt: new Date(
                    currentTime + delay,
                  ).toISOString(),
                }),
            ...(beforeBackoff?.lastReceipt === undefined
              ? {}
              : { lastReceipt: beforeBackoff.lastReceipt }),
            lastFailure: failure,
          });
          yield* completeWaiters(
            control,
            failureResult(control.target, failure, status),
          );

          if (delay === undefined) {
            yield* Queue.take(control.wake);
          } else {
            yield* Effect.raceFirst(
              Effect.sleep(Duration.millis(delay)),
              Queue.take(control.wake),
            );
          }
        }
      });

    const removeWorker = (
      hostId: HostIdValue,
      control: WorkerControl,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        workers.delete(hostId);
        yield* FiberMap.remove(fibers, hostId);
        yield* Queue.shutdown(control.wake);
        const stopped = unavailable(
          hostId,
          control.target.stationInstallationId,
          "stopped",
          "Station fleet target is no longer supervised",
        );
        const previous = yield* readStatus(control.target.hostId);
        const status = yield* setStatus(control.target, {
          phase: "stopped",
          sessionOpen: false,
          attempt: 0,
          ...(previous?.protocol === undefined
            ? {}
            : { protocol: previous.protocol }),
          lastFailure: stopped,
        });
        yield* completeWaiters(
          control,
          failureResult(control.target, stopped, status),
        );
        yield* Ref.update(peerStatuses, (current) => {
          const next = new Map(current);
          next.delete(hostId);
          return next;
        });
      });

    const ensureWorker = (
      target: StationFleetTarget,
    ): Effect.Effect<WorkerControl | undefined> =>
      Effect.gen(function* () {
        if (admissionClosed) return undefined;
        const existing = workers.get(target.hostId);
        if (existing !== undefined) {
          if (!(yield* FiberMap.has(fibers, target.hostId))) {
            if (admissionClosed) return undefined;
            yield* FiberMap.run(
              fibers,
              target.hostId,
              worker(existing),
              { onlyIfMissing: true },
            );
          }
          return existing;
        }

        const control: WorkerControl = {
          target,
          propagationTarget: toPropagationTarget(target),
          wake: yield* Queue.dropping<void>(1),
          waiters: yield* Ref.make<ReadonlyArray<WorkerWaiter>>([]),
        };
        if (admissionClosed) {
          yield* Queue.shutdown(control.wake);
          return undefined;
        }
        workers.set(target.hostId, control);
        yield* FiberMap.run(
          fibers,
          target.hostId,
          worker(control),
          { onlyIfMissing: true },
        );
        return control;
      });

    const reconcile = reconcileLock.withPermits(1)(
      Effect.gen(function* () {
        if (
          admissionClosed ||
          (yield* Ref.get(lifecycle)) !== "running"
        ) return;
        const fleet = yield* targets.list;
        if (
          admissionClosed ||
          (yield* Ref.get(lifecycle)) !== "running"
        ) {
          // Preserve the observable stopped status for targets discovered by
          // a reconciliation that was already admitted when the cut landed.
          // No worker or outbound session is created on this branch.
          yield* Effect.forEach(
            fleet,
            (target) =>
              markTargetStopped(
                target,
                "Station fleet supervisor stopped",
              ),
            { discard: true },
          );
          return;
        }
        const current = new Map(
          fleet.map((target) => [target.hostId, target] as const),
        );

        for (const [hostId, control] of workers) {
          if (!current.has(hostId)) {
            yield* removeWorker(hostId, control);
          }
        }
        for (const target of fleet) {
          if (
            admissionClosed ||
            (yield* Ref.get(lifecycle)) !== "running"
          ) return;
          yield* ensureWorker(target);
        }
      }),
    );

    const wakeSelected = (
      hostId?: HostIdValue,
    ): Effect.Effect<void> =>
      Effect.sync(() => {
        if (admissionClosed) return;
        if (hostId === undefined) {
          for (const control of workers.values()) {
            control.wake.unsafeOffer(undefined);
          }
          return;
        }
        workers.get(hostId)?.wake.unsafeOffer(undefined);
      });

    const coordinator = Effect.forever(
      Queue.take(invalidations).pipe(
        Effect.flatMap(() =>
          Effect.sync(() => {
            const all = pendingInvalidateAll;
            const hosts = [...pendingInvalidationHosts];
            pendingInvalidateAll = false;
            pendingInvalidationHosts.clear();
            return { all, hosts };
          })
        ),
        Effect.flatMap(({ all, hosts }) =>
          reconcile.pipe(
            Effect.zipRight(
              all
                ? wakeSelected()
                : Effect.forEach(
                    hosts,
                    wakeSelected,
                    { discard: true },
                  ),
            ),
          )
        ),
        Effect.catchAll((error) =>
          Effect.logWarning(
            "Station fleet reconciliation failed",
            error,
          )
        ),
      ),
    );
    yield* Effect.forkScoped(coordinator);

    const invalidate = (hostId?: HostIdValue): void => {
      if (admissionClosed) return;
      if (hostId === undefined) {
        pendingInvalidateAll = true;
        pendingInvalidationHosts.clear();
      } else if (!pendingInvalidateAll) {
        pendingInvalidationHosts.add(hostId);
      }
      invalidations.unsafeOffer(undefined);
    };
    const unsubscribeCanvases = canvases.subscribeChanges(() =>
      invalidate()
    );
    const unsubscribeWork = work.subscribeChanges(() => invalidate());
    const unsubscribeHosts = subscribeHostsSnapshot(() => invalidate());
    const unsubscribeFleetTargets = targets.subscribeChanges((hostId) =>
      invalidate(hostId)
    );
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        unsubscribeCanvases();
        unsubscribeWork();
        unsubscribeHosts();
        unsubscribeFleetTargets();
      })
    );

    const start = (): Effect.Effect<
      void,
      StationFleetTargetRepositoryError
    > =>
      Effect.gen(function* () {
        if (admissionClosed) return;
        const shouldStart = yield* Ref.modify(
          lifecycle,
          (state): readonly [boolean, Lifecycle] =>
            state === "idle"
              ? [true, "running"]
              : [false, state],
        );
        if (shouldStart) yield* reconcile;
      });

    const request = (
      hostId?: HostIdValue,
    ): Effect.Effect<void> =>
      Effect.suspend(() =>
        admissionClosed
          ? Effect.void
          : Ref.get(lifecycle).pipe(
              Effect.flatMap((state) =>
                !admissionClosed && state === "running"
                  ? Effect.sync(() => invalidate(hostId))
                  : Effect.void,
              ),
            ),
      );

    const waitForWorker = (
      control: WorkerControl,
    ): Effect.Effect<StationFleetPropagationResult> =>
      Effect.gen(function* () {
        const waiter = yield* Deferred.make<
          StationFleetPropagationResult
        >();
        const admitted = yield* Ref.modify(
          control.waiters,
          (current): readonly [boolean, ReadonlyArray<WorkerWaiter>] =>
            current.length >= STATION_FLEET_MAX_WAITERS_PER_TARGET
              ? [false, current]
              : [true, [...current, waiter]],
        );
        if (!admitted) {
          const current = yield* readStatus(control.target.hostId);
          const failure = unavailable(
            control.target.hostId,
            control.target.stationInstallationId,
            "connection-failed",
            `Station reconciliation already has ${STATION_FLEET_MAX_WAITERS_PER_TARGET} bounded waiters`,
          );
          return failureResult(
            control.target,
            failure,
            current,
          );
        }
        const currentStatus = yield* readStatus(control.target.hostId);
        if (
          currentStatus?.phase === "ready" ||
          currentStatus?.phase === "backoff" ||
          currentStatus?.phase === "stopped"
        ) {
          control.wake.unsafeOffer(undefined);
        }

        const completed = yield* Deferred.await(waiter).pipe(
          Effect.timeoutOption(
            Duration.millis(
              STATION_FLEET_SYNCHRONIZE_TIMEOUT_MS,
            ),
          ),
          Effect.ensuring(
            Ref.update(control.waiters, (current) =>
              current.filter((candidate) => candidate !== waiter)
            ),
          ),
        );
        if (Option.isSome(completed)) return completed.value;

        const current = yield* readStatus(control.target.hostId);
        const failure = unavailable(
          control.target.hostId,
          control.target.stationInstallationId,
          "deadline",
          "Station did not complete reconciliation before the bounded deadline",
        );
        return failureResult(
          control.target,
          failure,
          current,
        );
      });

    const synchronize = (
      hostId?: HostIdValue,
    ): Effect.Effect<
      ReadonlyArray<StationFleetPropagationResult>,
      StationFleetTargetRepositoryError
    > =>
      Effect.gen(function* () {
        if (admissionClosed) {
          return hostId === undefined
            ? []
            : [
                {
                  ok: false as const,
                  hostId,
                  error: unavailable(
                    hostId,
                    undefined,
                    "stopped",
                    "Station fleet supervisor is stopped",
                  ),
                },
              ];
        }
        const state = yield* Ref.get(lifecycle);
        if (state === "stopped") {
          return hostId === undefined
            ? []
            : [
                {
                  ok: false as const,
                  hostId,
                  error: unavailable(
                    hostId,
                    undefined,
                    "stopped",
                    "Station fleet supervisor is stopped",
                  ),
                },
              ];
        }
        yield* start();
        yield* reconcile;

        const selected =
          hostId === undefined
            ? [...workers.values()]
            : workers.get(hostId) === undefined
              ? []
              : [workers.get(hostId)!];
        if (hostId !== undefined && selected.length === 0) {
          return [
            {
              ok: false,
              hostId,
              error: unavailable(
                hostId,
                undefined,
                "not-enrolled",
                "Station host is not an enrolled fleet target",
              ),
            },
          ];
        }
        return yield* Effect.forEach(
          selected,
          waitForWorker,
          { concurrency: "unbounded" },
        );
      });

    const stop = Effect.gen(function* () {
      // This statement runs before the first Effect boundary when the stop
      // fiber starts. Every async worker continuation checks it before another
      // route/session/synchronization operation.
      admissionClosed = true;
      yield* Ref.set(lifecycle, "stopped");

      // Interrupt live outbound sessions before waiting behind an admitted
      // target-list reconciliation. Reconcile observes admissionClosed and
      // cannot create a replacement; the second clear under the lock closes a
      // worker that raced between its last check and this first cut.
      yield* FiberMap.clear(fibers);
      yield* reconcileLock.withPermits(1)(
        Effect.gen(function* () {
          yield* FiberMap.clear(fibers);
          const controls = [...workers.values()];
          workers.clear();
          for (const control of controls) {
            yield* Queue.shutdown(control.wake);
            const { failure, status } = yield* markTargetStopped(
              control.target,
              "Station fleet supervisor stopped",
            );
            yield* completeWaiters(
              control,
              failureResult(control.target, failure, status),
            );
          }
        }),
      );
    });

    yield* Effect.addFinalizer(() => stop);

    return StationFleetPropagation.of({
      start,
      beginShutdown: () => {
        admissionClosed = true;
      },
      request,
      synchronize,
      status: readStatus,
      statuses: readStatuses,
      stop,
    });
  }),
);
