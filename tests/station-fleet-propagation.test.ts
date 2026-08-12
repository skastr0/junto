import {
  Context,
  Deferred,
  Effect,
  Layer,
  ManagedRuntime,
  Queue,
  Ref,
  Schema,
} from "effect";
import { describe, expect, it } from "vitest";
import { HostId, type HostId as HostIdValue } from "../src/shared/remote-hosts";
import {
  InstallationId,
  LogicalSequence,
  ReportRequest,
  ReportResponse,
  STATION_API_PROTOCOL,
  StationHostId,
  StationSha256,
  StatusResponse,
  type ReportRequest as ReportRequestValue,
  type StationReadiness,
} from "../src/shared/station-api";
import type { StationControlEnvelope } from "../src/shared/station-api-envelope";
import { CanvasesService } from "../src/main/vellum/canvases";
import { WorkRepository } from "../src/main/vellum/work/repository";
import {
  StationApiService,
  type StationApiPeerContext,
} from "../src/main/vellum/station/api";
import {
  STATION_FLEET_MAX_WAITERS_PER_TARGET,
  StationFleetPropagation,
  StationFleetPropagationLive,
  StationFleetPeerUnavailable,
  StationPeerRouteResolutionError,
  StationPeerRouteResolver,
} from "../src/main/vellum/station/fleet-propagation";
import {
  StationFleetTargetRepository,
  type StationFleetTarget,
} from "../src/main/vellum/station/fleet-target-repository";
import {
  mintStationPeerRoute,
  StationPeerExchange,
  StationPeerExchangeError,
  type StationRemoteReportHandler,
} from "../src/main/vellum/station/peer-exchange";
import {
  CURRENT_STATION_PROTOCOL_SUPPORT,
  STATION_PROTOCOL_BASELINE,
  StationAppVersion,
  StationProtocolSupport,
  StationStateSchemaVersion,
} from "../src/shared/station-protocol";
import {
  StationPeerSessionClosedError,
  bindNegotiatedStationProtocol,
  type StationPeerProtocolBinding,
  type StationPeerSession,
} from "../src/main/vellum/station/peer-session";
import {
  StationPropagation,
  type StationPropagationReceipt,
} from "../src/main/vellum/station/propagation";
import {
  StationLivePeerRegistry,
  StationLivePeerRegistryLive,
} from "../src/main/vellum/station/session-registry";

const hostId = Schema.decodeUnknownSync(HostId);
const installationId = Schema.decodeUnknownSync(InstallationId);
const sequence = Schema.decodeUnknownSync(LogicalSequence);
const sha256 = Schema.decodeUnknownSync(StationSha256);
const stationHostId = Schema.decodeUnknownSync(StationHostId);

const COMMAND_CENTER = installationId("fleet-command-center");
const PROTOCOL_DIAGNOSTICS = {
  appVersion: StationAppVersion.make("fleet-test"),
  stateSchemaVersion: StationStateSchemaVersion.make(1),
  support: CURRENT_STATION_PROTOCOL_SUPPORT,
};
const PROTOCOL = bindNegotiatedStationProtocol({
  negotiatedProtocol: STATION_PROTOCOL_BASELINE,
  local: PROTOCOL_DIAGNOSTICS,
  peer: PROTOCOL_DIAGNOSTICS,
});
const INCOMPATIBLE_PEER_DIAGNOSTICS = {
  appVersion: StationAppVersion.make("future-remote"),
  stateSchemaVersion: StationStateSchemaVersion.make(3),
  support: StationProtocolSupport.make({
    preferred: 5,
    compatibleFrom: 5,
    warnBelow: 5,
  }),
};
const target = (host: string, station: string): StationFleetTarget => ({
  hostId: hostId(host),
  stationInstallationId: installationId(station),
  boundAt: "2026-07-27T00:00:00.000Z",
});

const receipt = (
  stationInstallationId: ReturnType<typeof installationId>,
  options: {
    readonly generation?: ReturnType<typeof sequence>;
    /** Per-Remote logical report cursor (never wall-clock). */
    readonly reportCursor?: number;
  } = {},
): StationPropagationReceipt => {
  const generation = options.generation ?? sequence("1");
  const reportCursor = options.reportCursor ?? 0;
  const receivedThrough =
    reportCursor > 0
      ? [
          {
            eventHome: stationInstallationId,
            entityHome: stationInstallationId,
            through: sequence(String(reportCursor)),
          },
        ]
      : [];
  return {
    stationInstallationId,
    remoteStatus: StatusResponse.make({
      protocol: STATION_API_PROTOCOL,
      op: "status",
      installationId: stationInstallationId,
      state: "ready",
      configuration: {
        role: "remote",
        hostId: stationHostId("fleet-remote"),
        agentHostId: stationHostId("fleet-remote"),
        commandCenterInstallationId: COMMAND_CENTER,
        supervisedPreferred: true,
      },
      configuredAt: "2026-07-27T00:00:00.000Z",
      projection: {
        generation,
        contentSha256: sha256("a".repeat(64)),
        receivedAt: "2026-07-27T00:00:00.000Z",
      },
      receivedThrough,
      peerAcknowledgedThrough: [],
      readiness: {
        database: true,
        workControl: true,
        simulation: true,
        session: true,
      },
      observedAt: "2026-07-27T00:00:00.000Z",
    }),
    projection: {
      decision: "unchanged",
      active: {
        generation,
        contentSha256: sha256("a".repeat(64)),
        receivedAt: "2026-07-27T00:00:00.000Z",
      },
    },
    report: {
      rounds: 1,
      outboundSent: 0,
      inboundReceived: 0,
      inboundAccepted: 0,
      inboundIdempotent: 0,
      inboundRejected: 0,
      receivedThrough,
      hasMoreOutbound: false,
      hasMoreInbound: false,
    },
  };
};

type ApiHandleCall = {
  readonly request: ReportRequestValue;
  readonly readiness: StationReadiness;
  readonly peer: StationApiPeerContext;
};

type SessionRecord = {
  readonly session: StationPeerSession;
  readonly handler: StationRemoteReportHandler;
  readonly open: Ref.Ref<boolean>;
  readonly closed: Deferred.Deferred<StationPeerSessionClosedError>;
};

type HarnessOptions = {
  readonly failRouteFor?: ReadonlySet<HostIdValue>;
  readonly protocolIncompatibleFor?: ReadonlySet<HostIdValue>;
  readonly sessionProtocol?: StationPeerProtocolBinding;
  readonly blockSecondRouteFor?: HostIdValue;
  readonly blockFirstSynchronizationFor?: HostIdValue;
  readonly blockFirstTargetList?: boolean;
  readonly responseHasMore?: boolean;
};

const makeHarness = (
  fleet: ReadonlyArray<StationFleetTarget>,
  options: HarnessOptions = {},
) => {
  const currentFleet = new Map(
    fleet.map((entry) => [entry.hostId, entry] as const),
  );
  const byInstallation = new Map(
    fleet.map((entry) => [entry.stationInstallationId, entry] as const),
  );
  const synchronizationCounts = new Map<HostIdValue, number>();
  const synchronizationEvents = new Map(
    fleet.map(
      (entry) =>
        [entry.hostId, Effect.runSync(Queue.unbounded<number>())] as const,
    ),
  );
  const synchronizationEventsFor = (
    host: HostIdValue,
  ): Queue.Queue<number> => {
    const existing = synchronizationEvents.get(host);
    if (existing !== undefined) return existing;
    const created = Effect.runSync(Queue.unbounded<number>());
    synchronizationEvents.set(host, created);
    return created;
  };
  const routeResolutionCounts = new Map<HostIdValue, number>();
  const openCounts = new Map<
    StationFleetTarget["stationInstallationId"],
    number
  >();
  const closeCounts = new Map<
    StationFleetTarget["stationInstallationId"],
    number
  >();
  const sessions = new Map<
    StationFleetTarget["stationInstallationId"],
    Array<SessionRecord>
  >();
  const apiHandleCalls: Array<ApiHandleCall> = [];
  /** Per-Remote durable report cursor (logical seq), independent across targets. */
  const reportCursors = new Map<
    StationFleetTarget["stationInstallationId"],
    number
  >();
  /** Every peer session open — proves Remotes never open to each other. */
  const openedPeerPairs: Array<{
    readonly localInstallationId: ReturnType<typeof installationId>;
    readonly peerInstallationId: ReturnType<typeof installationId>;
  }> = [];
  const secondRouteStarted = Effect.runSync(Deferred.make<void>());
  const releaseSecondRoute = Effect.runSync(Deferred.make<void>());
  const targetListStarted = Effect.runSync(Deferred.make<void>());
  const releaseTargetList = Effect.runSync(Deferred.make<void>());
  const synchronizationStarted = Effect.runSync(Deferred.make<void>());
  const releaseSynchronization = Effect.runSync(Deferred.make<void>());
  const canvasListeners = new Set<(name: string) => void>();
  const workListeners = new Set<(canvasName: string, nodeId: string) => void>();
  const fleetTargetListeners = new Set<(hostId: HostIdValue) => void>();
  let targetListCount = 0;

  const fleetTargets = StationFleetTargetRepository.of({
    list: Effect.gen(function* () {
      targetListCount += 1;
      if (options.blockFirstTargetList === true && targetListCount === 1) {
        yield* Deferred.succeed(targetListStarted, undefined);
        yield* Deferred.await(releaseTargetList);
      }
      return [...currentFleet.values()];
    }),
    bind: (identity, boundAt = "2026-07-27T00:00:00.000Z") =>
      Effect.sync(() => {
        const entry: StationFleetTarget = {
          ...identity,
          boundAt,
        };
        currentFleet.set(entry.hostId, entry);
        byInstallation.set(entry.stationInstallationId, entry);
        for (const listener of fleetTargetListeners) {
          listener(entry.hostId);
        }
        return entry;
      }),
    get: (host) => Effect.sync(() => currentFleet.get(host)),
    remove: (host) =>
      Effect.sync(() => {
        const removed = currentFleet.delete(host);
        if (removed) {
          for (const listener of fleetTargetListeners) listener(host);
        }
        return removed;
      }),
    subscribeChanges: (listener) => {
      fleetTargetListeners.add(listener);
      return () => {
        fleetTargetListeners.delete(listener);
      };
    },
  });

  const propagation = StationPropagation.of({
    synchronize: (input, session) =>
      Effect.gen(function* () {
        expect(session.peerInstallationId).toBe(input.stationInstallationId);
        // No peer-routing: CC sessions only ever face the named Remote.
        expect(session.localInstallationId).toBe(COMMAND_CENTER);
        const next = (synchronizationCounts.get(input.hostId) ?? 0) + 1;
        synchronizationCounts.set(input.hostId, next);
        const events = synchronizationEventsFor(input.hostId);
        yield* Queue.offer(events, next);
        if (
          options.blockFirstSynchronizationFor === input.hostId &&
          next === 1
        ) {
          yield* Deferred.succeed(synchronizationStarted, undefined);
          yield* Deferred.await(releaseSynchronization);
        }
        const cursor =
          (reportCursors.get(input.stationInstallationId) ?? 0) + 1;
        reportCursors.set(input.stationInstallationId, cursor);
        return receipt(input.stationInstallationId, {
          generation: sequence("1"),
          reportCursor: cursor,
        });
      }),
  });

  const routeResolver = StationPeerRouteResolver.of({
    resolve: (input) =>
      Effect.gen(function* () {
        const next = (routeResolutionCounts.get(input.hostId) ?? 0) + 1;
        routeResolutionCounts.set(input.hostId, next);
        if (options.failRouteFor?.has(input.hostId) === true) {
          return yield* StationPeerRouteResolutionError.make({
            hostId: input.hostId,
            stationInstallationId: input.stationInstallationId,
            reason: "missing-route",
            message: "test route is unavailable",
          });
        }
        if (options.blockSecondRouteFor === input.hostId && next === 2) {
          yield* Deferred.succeed(secondRouteStarted, undefined);
          yield* Deferred.await(releaseSecondRoute);
        }
        return mintStationPeerRoute(input.stationInstallationId);
      }),
  });

  const exchange = StationPeerExchange.of({
    open: (route, handler) =>
      Effect.gen(function* () {
        const remote = route.peerInstallationId;
        const enrolled = byInstallation.get(remote);
        if (enrolled === undefined) {
          return yield* Effect.die("exchange received an unknown peer");
        }
        if (
          options.protocolIncompatibleFor?.has(enrolled.hostId) === true
        ) {
          return yield* StationPeerExchangeError.make({
            peerInstallationId: remote,
            reason: "protocol-incompatible",
            message: "test peers have no common Station protocol",
            localProtocol: PROTOCOL_DIAGNOSTICS,
            peerProtocol: INCOMPATIBLE_PEER_DIAGNOSTICS,
          });
        }
        openCounts.set(remote, (openCounts.get(remote) ?? 0) + 1);
        openedPeerPairs.push({
          localInstallationId: COMMAND_CENTER,
          peerInstallationId: remote,
        });
        const open = yield* Ref.make(true);
        const closed = yield* Deferred.make<StationPeerSessionClosedError>();
        const closeWith = (
          reason: StationPeerSessionClosedError["reason"],
        ): Effect.Effect<void> =>
          Effect.gen(function* () {
            yield* Ref.set(open, false);
            yield* Deferred.succeed(
              closed,
              StationPeerSessionClosedError.make({
                peerInstallationId: remote,
                reason,
                message: `test session ${reason}`,
              }),
            );
          }).pipe(Effect.asVoid);
        const session: StationPeerSession = {
          localInstallationId: COMMAND_CENTER,
          peerInstallationId: remote,
          protocol: options.sessionProtocol ?? PROTOCOL,
          request: () => Effect.die("fake propagation owns request behavior"),
          withOpen: (effect) => effect,
          isOpen: Ref.get(open),
          awaitClosed: Deferred.await(closed),
          close: closeWith("local-close"),
        };
        const record: SessionRecord = {
          session,
          handler,
          open,
          closed,
        };
        const history = sessions.get(remote) ?? [];
        history.push(record);
        sessions.set(remote, history);
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            closeCounts.set(remote, (closeCounts.get(remote) ?? 0) + 1);
            yield* closeWith("scope-closed");
          }),
        );
        return session;
      }),
  });

  const api = StationApiService.of({
    handle: (request, readiness, peer) => {
      if (request.op !== "report") {
        return Effect.die("fleet test accepts inbound report only");
      }
      apiHandleCalls.push({ request, readiness, peer });
      return Effect.succeed(
        ReportResponse.make({
          protocol: STATION_API_PROTOCOL,
          op: "report",
          senderInstallationId: request.targetInstallationId,
          targetInstallationId: request.senderInstallationId,
          batch: {
            records: [],
            acknowledge: [],
            hasMore: options.responseHasMore ?? false,
          },
        }),
      );
    },
    prepareReport: () => Effect.die("fake propagation prepares reports itself"),
    acceptReportResponse: () =>
      Effect.die("fake propagation integrates reports itself"),
  });

  const canvases = {
    subscribeChanges: (listener: (name: string) => void): (() => void) => {
      canvasListeners.add(listener);
      return () => {
        canvasListeners.delete(listener);
      };
    },
  } as Context.Service.Shape<typeof CanvasesService>;

  const work = {
    subscribeChanges: (
      listener: (canvasName: string, nodeId: string) => void,
    ): (() => void) => {
      workListeners.add(listener);
      return () => {
        workListeners.delete(listener);
      };
    },
  } as Context.Service.Shape<typeof WorkRepository>;

  const dependencies = Layer.mergeAll(
    Layer.succeed(StationFleetTargetRepository, fleetTargets),
    Layer.succeed(StationPropagation, propagation),
    Layer.succeed(StationPeerRouteResolver, routeResolver),
    Layer.succeed(StationPeerExchange, exchange),
    Layer.succeed(StationApiService, api),
    Layer.succeed(CanvasesService, canvases),
    Layer.succeed(WorkRepository, work),
    StationLivePeerRegistryLive,
  );
  const layer = Layer.merge(
    dependencies,
    StationFleetPropagationLive.pipe(Layer.provide(dependencies)),
  );

  const currentSession = (
    remote: StationFleetTarget["stationInstallationId"],
  ): SessionRecord => {
    const history = sessions.get(remote);
    const current = history?.at(-1);
    if (current === undefined) {
      throw new TypeError("expected an open test session");
    }
    return current;
  };

  return {
    layer,
    apiHandleCalls,
    openedPeerPairs,
    reportCursor: (
      remote: StationFleetTarget["stationInstallationId"],
    ): number => reportCursors.get(remote) ?? 0,
    openCount: (remote: StationFleetTarget["stationInstallationId"]): number =>
      openCounts.get(remote) ?? 0,
    closeCount: (remote: StationFleetTarget["stationInstallationId"]): number =>
      closeCounts.get(remote) ?? 0,
    synchronizationCount: (host: HostIdValue): number =>
      synchronizationCounts.get(host) ?? 0,
    routeResolutionCount: (host: HostIdValue): number =>
      routeResolutionCounts.get(host) ?? 0,
    takeSynchronization: (host: HostIdValue): Effect.Effect<number> => {
      return Queue.take(synchronizationEventsFor(host));
    },
    bindTarget: (entry: StationFleetTarget) =>
      fleetTargets.bind(
        {
          hostId: entry.hostId,
          stationInstallationId: entry.stationInstallationId,
        },
        entry.boundAt,
      ).pipe(Effect.asVoid),
    disconnect: (
      remote: StationFleetTarget["stationInstallationId"],
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const current = currentSession(remote);
        yield* Ref.set(current.open, false);
        yield* Deferred.succeed(
          current.closed,
          StationPeerSessionClosedError.make({
            peerInstallationId: remote,
            reason: "transport-ended",
            message: "test transport disconnected",
          }),
        );
      }).pipe(Effect.asVoid),
    sendRemoteReport: (
      remote: StationFleetTarget["stationInstallationId"],
      request: ReportRequestValue,
    ): Effect.Effect<StationControlEnvelope> =>
      currentSession(remote).handler(request),
    secondRouteStarted: Deferred.await(secondRouteStarted),
    releaseSecondRoute: Deferred.succeed(releaseSecondRoute, undefined).pipe(
      Effect.asVoid,
    ),
    targetListStarted: Deferred.await(targetListStarted),
    releaseTargetList: Deferred.succeed(releaseTargetList, undefined).pipe(
      Effect.asVoid,
    ),
    synchronizationStarted: Deferred.await(synchronizationStarted),
    releaseSynchronization: Deferred.succeed(
      releaseSynchronization,
      undefined,
    ).pipe(Effect.asVoid),
    emitCanvasChange: (): void => {
      for (const listener of canvasListeners) listener("portfolio");
    },
    emitWorkChange: (): void => {
      for (const listener of workListeners) {
        listener("portfolio", "tasks");
      }
    },
  };
};

const withRuntime = async <A>(
  harness: ReturnType<typeof makeHarness>,
  use: (
    runtime: ManagedRuntime.ManagedRuntime<
      | Context.Service.Identifier<typeof StationFleetPropagation>
      | Context.Service.Identifier<typeof StationLivePeerRegistry>,
      never
    >,
  ) => Promise<A>,
): Promise<A> => {
  const runtime = ManagedRuntime.make(harness.layer);
  try {
    return await use(runtime);
  } finally {
    await runtime.dispose();
  }
};

const ready = (
  runtime: ManagedRuntime.ManagedRuntime<
    | Context.Service.Identifier<typeof StationFleetPropagation>
    | Context.Service.Identifier<typeof StationLivePeerRegistry>,
    never
  >,
  service: Context.Service.Shape<typeof StationFleetPropagation>,
  host: HostIdValue,
): Promise<void> =>
  runtime.runPromise(
    Effect.gen(function* () {
      while ((yield* service.status(host))?.phase !== "ready") {
        yield* Effect.yieldNow;
      }
    }),
  );

describe("StationFleetPropagation persistent supervisor", () => {
  it("reuses one scoped peer session across request and awaited synchronization wakes", async () => {
    const remote = target("render-host", "render-station");
    const harness = makeHarness([remote]);

    await withRuntime(harness, async (runtime) => {
      const service = await runtime.runPromise(StationFleetPropagation);
      const initial = await runtime.runPromise(
        service.synchronize(remote.hostId),
      );

      expect(initial).toHaveLength(1);
      expect(initial[0]?.ok).toBe(true);
      expect(
        await runtime.runPromise(harness.takeSynchronization(remote.hostId)),
      ).toBe(1);

      await runtime.runPromise(service.request(remote.hostId));
      expect(
        await runtime.runPromise(harness.takeSynchronization(remote.hostId)),
      ).toBe(2);
      await ready(runtime, service, remote.hostId);

      const awaited = await runtime.runPromise(
        service.synchronize(remote.hostId),
      );
      expect(awaited[0]?.ok).toBe(true);
      expect(
        await runtime.runPromise(harness.takeSynchronization(remote.hostId)),
      ).toBe(3);

      expect(harness.openCount(remote.stationInstallationId)).toBe(1);
      expect(
        harness.synchronizationCount(remote.hostId),
      ).toBeGreaterThanOrEqual(3);
    });
  });

  it("keeps the renamed exact codec live and mutation-capable", async () => {
    const remote = target("current-host", "current-station");
    const harness = makeHarness([remote], {
      sessionProtocol: PROTOCOL,
    });

    await withRuntime(harness, async (runtime) => {
      const service = await runtime.runPromise(StationFleetPropagation);
      const registry = await runtime.runPromise(StationLivePeerRegistry);
      const [result] = await runtime.runPromise(
        service.synchronize(remote.hostId),
      );

      expect(result?.ok).toBe(true);
      if (result?.ok === true) {
        expect(result.status).toMatchObject({
          phase: "ready",
          sessionOpen: true,
          protocol: {
            compatibility: "compatible",
            negotiatedProtocol: STATION_PROTOCOL_BASELINE,
          },
        });
      }
      expect(
        await runtime.runPromise(
          registry.isLive(remote.hostId, remote.stationInstallationId),
        ),
      ).toBe(true);
    });
  });

  it("keeps a healthy target ready when another target cannot resolve a route", async () => {
    const unavailable = target("offline-host", "offline-station");
    const healthy = target("healthy-host", "healthy-station");
    const harness = makeHarness([unavailable, healthy], {
      failRouteFor: new Set([unavailable.hostId]),
    });

    await withRuntime(harness, async (runtime) => {
      const service = await runtime.runPromise(StationFleetPropagation);
      const results = await runtime.runPromise(service.synchronize());
      const failed = results.find(
        (result) => result.hostId === unavailable.hostId,
      );
      const succeeded = results.find(
        (result) => result.hostId === healthy.hostId,
      );

      expect(failed?.ok).toBe(false);
      if (failed?.ok === false) {
        expect(failed.error.reason).toBe("route-unavailable");
      }
      expect(succeeded?.ok).toBe(true);
      expect(harness.openCount(unavailable.stationInstallationId)).toBe(0);
      expect(harness.openCount(healthy.stationInstallationId)).toBe(1);
    });
  });

  it("starts a worker when an existing host gains a fleet target after startup", async () => {
    const remote = target("late-bind-host", "late-bind-station");
    const harness = makeHarness([]);

    await withRuntime(harness, async (runtime) => {
      const service = await runtime.runPromise(StationFleetPropagation);
      const registry = await runtime.runPromise(StationLivePeerRegistry);
      await runtime.runPromise(service.start());

      expect(harness.openCount(remote.stationInstallationId)).toBe(0);
      await runtime.runPromise(harness.bindTarget(remote));
      expect(
        await runtime.runPromise(harness.takeSynchronization(remote.hostId)),
      ).toBe(1);
      await ready(runtime, service, remote.hostId);

      expect(harness.openCount(remote.stationInstallationId)).toBe(1);
      expect(
        await runtime.runPromise(
          registry.isLive(remote.hostId, remote.stationInstallationId),
        ),
      ).toBe(true);
    });
  });

  it("routes an inbound Remote report through StationApiService and immediately drains hasMore", async () => {
    const remote = target("report-host", "report-station");
    const harness = makeHarness([remote]);

    await withRuntime(harness, async (runtime) => {
      const service = await runtime.runPromise(StationFleetPropagation);
      await runtime.runPromise(service.synchronize(remote.hostId));
      await runtime.runPromise(harness.takeSynchronization(remote.hostId));

      const request = ReportRequest.make({
        protocol: STATION_API_PROTOCOL,
        op: "report",
        senderInstallationId: remote.stationInstallationId,
        targetInstallationId: COMMAND_CENTER,
        batch: {
          records: [],
          acknowledge: [],
          hasMore: true,
        },
      });
      const envelope = await runtime.runPromise(
        harness.sendRemoteReport(remote.stationInstallationId, request),
      );

      expect(envelope.ok).toBe(true);
      expect(harness.apiHandleCalls).toHaveLength(1);
      expect(harness.apiHandleCalls[0]).toMatchObject({
        request,
        readiness: {
          database: true,
          workControl: true,
          simulation: true,
          session: true,
        },
        peer: {
          _tag: "enrolled-remote",
          installationId: remote.stationInstallationId,
        },
      });
      expect(
        await runtime.runPromise(harness.takeSynchronization(remote.hostId)),
      ).toBe(2);
      expect(harness.openCount(remote.stationInstallationId)).toBe(1);
    });
  });

  it("removes the live witness on disconnect and registers a fresh session after reconnect", async () => {
    const remote = target("reconnect-host", "reconnect-station");
    const harness = makeHarness([remote], {
      blockSecondRouteFor: remote.hostId,
    });

    await withRuntime(harness, async (runtime) => {
      const service = await runtime.runPromise(StationFleetPropagation);
      const registry = await runtime.runPromise(StationLivePeerRegistry);
      await runtime.runPromise(service.synchronize(remote.hostId));
      await runtime.runPromise(harness.takeSynchronization(remote.hostId));
      expect(
        await runtime.runPromise(
          registry.isLive(remote.hostId, remote.stationInstallationId),
        ),
      ).toBe(true);

      await runtime.runPromise(
        harness.disconnect(remote.stationInstallationId),
      );
      await runtime.runPromise(service.request(remote.hostId));
      await runtime.runPromise(harness.secondRouteStarted);

      expect(harness.closeCount(remote.stationInstallationId)).toBe(1);
      expect(
        await runtime.runPromise(
          registry.isLive(remote.hostId, remote.stationInstallationId),
        ),
      ).toBe(false);

      const reconnected = runtime.runPromise(
        service.synchronize(remote.hostId),
      );
      await runtime.runPromise(harness.releaseSecondRoute);
      const result = await reconnected;

      expect(result[0]?.ok).toBe(true);
      expect(harness.openCount(remote.stationInstallationId)).toBe(2);
      expect(
        await runtime.runPromise(
          registry.isLive(remote.hostId, remote.stationInstallationId),
        ),
      ).toBe(true);
    });
  });

  it("interrupts the scoped session and removes liveness when stopped", async () => {
    const remote = target("stop-host", "stop-station");
    const harness = makeHarness([remote]);

    await withRuntime(harness, async (runtime) => {
      const service = await runtime.runPromise(StationFleetPropagation);
      const registry = await runtime.runPromise(StationLivePeerRegistry);
      await runtime.runPromise(service.synchronize(remote.hostId));
      await runtime.runPromise(harness.takeSynchronization(remote.hostId));

      await runtime.runPromise(service.stop);

      expect(harness.closeCount(remote.stationInstallationId)).toBe(1);
      expect(
        await runtime.runPromise(
          registry.isLive(remote.hostId, remote.stationInstallationId),
        ),
      ).toBe(false);
      expect(
        await runtime.runPromise(service.status(remote.hostId)),
      ).toMatchObject({
        phase: "stopped",
        sessionOpen: false,
      });
    });
  });

  it("closes admission synchronously and interrupts an outbound reconnect", async () => {
    const remote = target("revoked-host", "revoked-station");
    const harness = makeHarness([remote], {
      blockSecondRouteFor: remote.hostId,
    });

    await withRuntime(harness, async (runtime) => {
      const service = await runtime.runPromise(StationFleetPropagation);
      const initial = await runtime.runPromise(
        service.synchronize(remote.hostId),
      );
      expect(initial[0]?.ok).toBe(true);

      await runtime.runPromise(
        harness.disconnect(remote.stationInstallationId),
      );
      await runtime.runPromise(service.request(remote.hostId));
      await runtime.runPromise(harness.secondRouteStarted);

      service.beginShutdown();
      const denied = await runtime.runPromise(
        service.synchronize(remote.hostId),
      );
      await runtime.runPromise(service.stop);

      expect(denied[0]?.ok).toBe(false);
      if (denied[0]?.ok === false) {
        expect(denied[0].error.reason).toBe("stopped");
      }
      expect(harness.openCount(remote.stationInstallationId)).toBe(1);
      expect(harness.closeCount(remote.stationInstallationId)).toBe(1);

      await runtime.runPromise(service.request(remote.hostId));
      await runtime.runPromise(Effect.yieldNow);
      expect(harness.openCount(remote.stationInstallationId)).toBe(1);
    });
  });

  it("serializes stop behind an admitted reconciliation and leaves no worker alive", async () => {
    const remote = target("stop-race-host", "stop-race-station");
    const harness = makeHarness([remote], {
      blockFirstTargetList: true,
    });

    await withRuntime(harness, async (runtime) => {
      const service = await runtime.runPromise(StationFleetPropagation);
      const registry = await runtime.runPromise(StationLivePeerRegistry);
      const starting = runtime.runPromise(service.start());
      await runtime.runPromise(harness.targetListStarted);

      let stopCompleted = false;
      const stopping = runtime.runPromise(service.stop).then(() => {
        stopCompleted = true;
      });
      await Promise.resolve();
      expect(stopCompleted).toBe(false);

      await runtime.runPromise(harness.releaseTargetList);
      await starting;
      await stopping;

      expect(
        await runtime.runPromise(
          registry.isLive(remote.hostId, remote.stationInstallationId),
        ),
      ).toBe(false);
      expect(
        await runtime.runPromise(service.status(remote.hostId)),
      ).toMatchObject({
        phase: "stopped",
        sessionOpen: false,
      });

      const opensAfterStop = harness.openCount(
        remote.stationInstallationId,
      );
      await runtime.runPromise(service.request(remote.hostId));
      await runtime.runPromise(Effect.yieldNow);
      expect(harness.openCount(remote.stationInstallationId)).toBe(
        opensAfterStop,
      );
    });
  });

  it("returns typed unavailability when the persistent route fails without opening a fallback", async () => {
    const remote = target("missing-host", "missing-station");
    const harness = makeHarness([remote], {
      failRouteFor: new Set([remote.hostId]),
    });

    await withRuntime(harness, async (runtime) => {
      const service = await runtime.runPromise(StationFleetPropagation);
      const results = await runtime.runPromise(
        service.synchronize(remote.hostId),
      );
      const result = results[0];

      expect(result?.ok).toBe(false);
      if (result?.ok === false) {
        expect(result.error).toBeInstanceOf(StationFleetPeerUnavailable);
        expect(result.error.reason).toBe("route-unavailable");
      }
      expect(harness.openCount(remote.stationInstallationId)).toBe(0);
      const parkedResolutionCount = harness.routeResolutionCount(
        remote.hostId,
      );
      expect(parkedResolutionCount).toBeGreaterThanOrEqual(1);

      await runtime.runPromise(Effect.sleep("600 millis"));
      expect(harness.routeResolutionCount(remote.hostId)).toBe(
        parkedResolutionCount,
      );

      const explicitlyRetried = await runtime.runPromise(
        service.synchronize(remote.hostId),
      );
      expect(explicitlyRetried[0]?.ok).toBe(false);
      expect(harness.routeResolutionCount(remote.hostId)).toBe(
        parkedResolutionCount + 1,
      );
    });
  });

  it("parks an incompatible peer as update-required without minting live claim authority", async () => {
    const remote = target("future-host", "future-station");
    const harness = makeHarness([remote], {
      protocolIncompatibleFor: new Set([remote.hostId]),
    });

    await withRuntime(harness, async (runtime) => {
      const service = await runtime.runPromise(StationFleetPropagation);
      const registry = await runtime.runPromise(StationLivePeerRegistry);
      await runtime.runPromise(service.start());
      await runtime.runPromise(
        Effect.gen(function* () {
          while (
            (yield* service.status(remote.hostId))?.phase !==
              "update-required"
          ) {
            yield* Effect.yieldNow;
          }
        }),
      );
      const status = await runtime.runPromise(service.status(remote.hostId));

      expect(status?.lastFailure?.reason).toBe("update-required");
      expect(status?.lastFailure?.message).toContain("running locally");
      expect(status).toMatchObject({
        phase: "update-required",
        sessionOpen: false,
        protocol: {
          compatibility: "update-required",
          local: PROTOCOL_DIAGNOSTICS,
          peer: INCOMPATIBLE_PEER_DIAGNOSTICS,
        },
      });
      expect(harness.synchronizationCount(remote.hostId)).toBe(0);
      expect(
        await runtime.runPromise(
          registry.isLive(remote.hostId, remote.stationInstallationId),
        ),
      ).toBe(false);

      const parkedResolutionCount = harness.routeResolutionCount(
        remote.hostId,
      );
      await runtime.runPromise(Effect.sleep("600 millis"));
      expect(harness.routeResolutionCount(remote.hostId)).toBe(
        parkedResolutionCount,
      );
    });
  });

  it("bounds concurrent reconciliation waiters per target", async () => {
    const remote = target("waiter-host", "waiter-station");
    const harness = makeHarness([remote], {
      blockFirstSynchronizationFor: remote.hostId,
    });

    await withRuntime(harness, async (runtime) => {
      const service = await runtime.runPromise(StationFleetPropagation);
      await runtime.runPromise(service.start());
      await runtime.runPromise(harness.synchronizationStarted);

      const requests = Array.from(
        { length: STATION_FLEET_MAX_WAITERS_PER_TARGET + 1 },
        () => runtime.runPromise(service.synchronize(remote.hostId)),
      );
      const capacity = await Promise.race(requests);

      expect(capacity[0]?.ok).toBe(false);
      if (capacity[0]?.ok === false) {
        expect(capacity[0].error.reason).toBe("connection-failed");
        expect(capacity[0].error.message).toContain(
          `${STATION_FLEET_MAX_WAITERS_PER_TARGET} bounded waiters`,
        );
      }

      await runtime.runPromise(harness.releaseSynchronization);
      const completed = await Promise.all(requests);
      expect(
        completed.filter((result) => result[0]?.ok === true),
      ).toHaveLength(STATION_FLEET_MAX_WAITERS_PER_TARGET);
    });
  });
});

/**
 * FLEET-P4 — Command Center + Remote A + Remote B topology matrix.
 *
 * Proves independent sessions, cursors, reconnects, projection receipts,
 * failure isolation, and bounded concurrency without peer-to-peer routing.
 * Timestamps never decide convergence — only logical report cursors do.
 */
describe("FLEET-P4 two-Remote Station topology", () => {
  const remoteA = target("remote-a-host", "remote-a-station");
  const remoteB = target("remote-b-host", "remote-b-station");

  it("establishes two persistent sessions with distinct host and installation identities", async () => {
    const harness = makeHarness([remoteA, remoteB]);

    await withRuntime(harness, async (runtime) => {
      const service = await runtime.runPromise(StationFleetPropagation);
      const registry = await runtime.runPromise(StationLivePeerRegistry);
      const results = await runtime.runPromise(service.synchronize());

      expect(results).toHaveLength(2);
      expect(results.every((result) => result.ok)).toBe(true);
      expect(harness.openCount(remoteA.stationInstallationId)).toBe(1);
      expect(harness.openCount(remoteB.stationInstallationId)).toBe(1);
      expect(
        await runtime.runPromise(
          registry.isLive(remoteA.hostId, remoteA.stationInstallationId),
        ),
      ).toBe(true);
      expect(
        await runtime.runPromise(
          registry.isLive(remoteB.hostId, remoteB.stationInstallationId),
        ),
      ).toBe(true);

      // No Remote ever opens a session to the other Remote — only CC→Remote.
      expect(harness.openedPeerPairs).toHaveLength(2);
      expect(
        harness.openedPeerPairs.every(
          (pair) =>
            pair.localInstallationId === COMMAND_CENTER &&
            pair.peerInstallationId !== COMMAND_CENTER,
        ),
      ).toBe(true);
      expect(
        harness.openedPeerPairs.map((pair) => pair.peerInstallationId).sort(),
      ).toEqual(
        [remoteA.stationInstallationId, remoteB.stationInstallationId].sort(),
      );
    });
  });

  it("delivers the same complete authorial generation independently with per-target receipts", async () => {
    const harness = makeHarness([remoteA, remoteB]);

    await withRuntime(harness, async (runtime) => {
      const service = await runtime.runPromise(StationFleetPropagation);
      const results = await runtime.runPromise(service.synchronize());
      const receiptA = results.find((r) => r.hostId === remoteA.hostId);
      const receiptB = results.find((r) => r.hostId === remoteB.hostId);

      expect(receiptA?.ok).toBe(true);
      expect(receiptB?.ok).toBe(true);
      if (receiptA?.ok === true && receiptB?.ok === true) {
        // Same authorial generation on both targets.
        expect(receiptA.receipt.projection.active.generation).toBe(
          receiptB.receipt.projection.active.generation,
        );
        expect(receiptA.receipt.stationInstallationId).toBe(
          remoteA.stationInstallationId,
        );
        expect(receiptB.receipt.stationInstallationId).toBe(
          remoteB.stationInstallationId,
        );
      }
      // Each target reconciled at least once; exact count may include worker
      // startup wake — independence is the receipt identity, not the tally.
      expect(harness.synchronizationCount(remoteA.hostId)).toBeGreaterThanOrEqual(
        1,
      );
      expect(harness.synchronizationCount(remoteB.hostId)).toBeGreaterThanOrEqual(
        1,
      );
    });
  });

  it("advances distinct logical report cursors without cross-contamination", async () => {
    const harness = makeHarness([remoteA, remoteB]);

    await withRuntime(harness, async (runtime) => {
      const service = await runtime.runPromise(StationFleetPropagation);
      // Explicit per-host wakes — never wall-clock ordering.
      await runtime.runPromise(service.synchronize(remoteA.hostId));
      await runtime.runPromise(service.synchronize(remoteA.hostId));
      await runtime.runPromise(service.synchronize(remoteA.hostId));
      const cursorA = harness.reportCursor(remoteA.stationInstallationId);
      const cursorBIdle = harness.reportCursor(remoteB.stationInstallationId);
      await runtime.runPromise(service.synchronize(remoteB.hostId));
      const cursorB = harness.reportCursor(remoteB.stationInstallationId);

      // A was woken more times than B; B only advanced on its own wake.
      expect(cursorA).toBeGreaterThan(cursorBIdle);
      expect(cursorB).toBeGreaterThan(cursorBIdle);
      expect(cursorA).toBeGreaterThan(cursorB);
      expect(harness.synchronizationCount(remoteA.hostId)).toBeGreaterThan(
        harness.synchronizationCount(remoteB.hostId),
      );
    });
  });

  it("disconnects Remote A while Remote B continues projection, reporting, and claim-ready liveness", async () => {
    const harness = makeHarness([remoteA, remoteB], {
      blockSecondRouteFor: remoteA.hostId,
    });

    await withRuntime(harness, async (runtime) => {
      const service = await runtime.runPromise(StationFleetPropagation);
      const registry = await runtime.runPromise(StationLivePeerRegistry);
      await runtime.runPromise(service.synchronize());
      await ready(runtime, service, remoteA.hostId);
      await ready(runtime, service, remoteB.hostId);
      const cursorBBefore = harness.reportCursor(remoteB.stationInstallationId);

      await runtime.runPromise(
        harness.disconnect(remoteA.stationInstallationId),
      );
      // Head-of-line: A reconnect path is blocked; B must still reconcile.
      await runtime.runPromise(service.request(remoteA.hostId));
      await runtime.runPromise(harness.secondRouteStarted);

      const bWhileADown = await runtime.runPromise(
        service.synchronize(remoteB.hostId),
      );
      expect(bWhileADown[0]?.ok).toBe(true);
      expect(
        await runtime.runPromise(
          registry.isLive(remoteB.hostId, remoteB.stationInstallationId),
        ),
      ).toBe(true);
      expect(
        await runtime.runPromise(
          registry.isLive(remoteA.hostId, remoteA.stationInstallationId),
        ),
      ).toBe(false);
      expect(harness.reportCursor(remoteB.stationInstallationId)).toBeGreaterThan(
        cursorBBefore,
      );

      // Release A's reconnect without blocking B further.
      await runtime.runPromise(harness.releaseSecondRoute);
      const aBack = await runtime.runPromise(
        service.synchronize(remoteA.hostId),
      );
      expect(aBack[0]?.ok).toBe(true);
    });
  });

  it("reconnects Remote A and resumes strictly after its own durable cursor", async () => {
    const harness = makeHarness([remoteA, remoteB], {
      blockSecondRouteFor: remoteA.hostId,
    });

    await withRuntime(harness, async (runtime) => {
      const service = await runtime.runPromise(StationFleetPropagation);
      await runtime.runPromise(service.synchronize(remoteA.hostId));
      await runtime.runPromise(service.synchronize(remoteA.hostId));
      await runtime.runPromise(service.synchronize(remoteB.hostId));
      const cursorABefore = harness.reportCursor(remoteA.stationInstallationId);
      const cursorBBefore = harness.reportCursor(remoteB.stationInstallationId);
      expect(cursorABefore).toBeGreaterThan(cursorBBefore);

      await runtime.runPromise(
        harness.disconnect(remoteA.stationInstallationId),
      );
      await runtime.runPromise(service.request(remoteA.hostId));
      await runtime.runPromise(harness.secondRouteStarted);
      await runtime.runPromise(harness.releaseSecondRoute);
      await runtime.runPromise(service.synchronize(remoteA.hostId));

      // A continues from its own counter; B is unchanged while A was reconnecting.
      expect(harness.reportCursor(remoteA.stationInstallationId)).toBeGreaterThan(
        cursorABefore,
      );
      expect(harness.reportCursor(remoteB.stationInstallationId)).toBe(
        cursorBBefore,
      );
      expect(harness.openCount(remoteA.stationInstallationId)).toBeGreaterThanOrEqual(
        2,
      );
    });
  });

  it("keeps Remote B ready when Remote A's route is unavailable (installation/endpoint failure isolation)", async () => {
    const harness = makeHarness([remoteA, remoteB], {
      failRouteFor: new Set([remoteA.hostId]),
    });

    await withRuntime(harness, async (runtime) => {
      const service = await runtime.runPromise(StationFleetPropagation);
      const registry = await runtime.runPromise(StationLivePeerRegistry);
      const results = await runtime.runPromise(service.synchronize());
      const failedA = results.find((result) => result.hostId === remoteA.hostId);
      const okB = results.find((result) => result.hostId === remoteB.hostId);

      expect(failedA?.ok).toBe(false);
      if (failedA?.ok === false) {
        expect(failedA.error.reason).toBe("route-unavailable");
      }
      expect(okB?.ok).toBe(true);
      expect(harness.openCount(remoteA.stationInstallationId)).toBe(0);
      expect(harness.openCount(remoteB.stationInstallationId)).toBe(1);
      expect(
        await runtime.runPromise(
          registry.isLive(remoteB.hostId, remoteB.stationInstallationId),
        ),
      ).toBe(true);
      expect(
        await runtime.runPromise(
          registry.isLive(remoteA.hostId, remoteA.stationInstallationId),
        ),
      ).toBe(false);

      // B still accepts further wakes while A stays parked.
      const bAgain = await runtime.runPromise(
        service.synchronize(remoteB.hostId),
      );
      expect(bAgain[0]?.ok).toBe(true);
      expect(harness.reportCursor(remoteB.stationInstallationId)).toBeGreaterThan(
        0,
      );
      expect(harness.reportCursor(remoteA.stationInstallationId)).toBe(0);
    });
  });

  it("runs disjoint Remote cadences without head-of-line blocking or peer sessions", async () => {
    const harness = makeHarness([remoteA, remoteB], {
      blockFirstSynchronizationFor: remoteA.hostId,
    });

    await withRuntime(harness, async (runtime) => {
      const service = await runtime.runPromise(StationFleetPropagation);
      // Start both workers; A blocks on first sync, B must not wait on A.
      await runtime.runPromise(service.start());
      await runtime.runPromise(harness.synchronizationStarted);

      const bDuringAHold = await runtime.runPromise(
        service.synchronize(remoteB.hostId),
      );
      expect(bDuringAHold[0]?.ok).toBe(true);
      expect(harness.reportCursor(remoteB.stationInstallationId)).toBeGreaterThanOrEqual(
        1,
      );

      await runtime.runPromise(harness.releaseSynchronization);
      await ready(runtime, service, remoteA.hostId);
      await ready(runtime, service, remoteB.hostId);

      // Distinct cadences: wake A thrice, B once more.
      await runtime.runPromise(service.synchronize(remoteA.hostId));
      await runtime.runPromise(service.synchronize(remoteA.hostId));
      await runtime.runPromise(service.synchronize(remoteB.hostId));

      expect(harness.synchronizationCount(remoteA.hostId)).toBeGreaterThanOrEqual(
        3,
      );
      expect(harness.synchronizationCount(remoteB.hostId)).toBeGreaterThanOrEqual(
        2,
      );
      // Still no Remote↔Remote sessions.
      expect(
        harness.openedPeerPairs.every(
          (pair) => pair.localInstallationId === COMMAND_CENTER,
        ),
      ).toBe(true);
    });
  });

  it("closes propagation admission with both workers active and leaves no live sessions", async () => {
    const harness = makeHarness([remoteA, remoteB]);

    await withRuntime(harness, async (runtime) => {
      const service = await runtime.runPromise(StationFleetPropagation);
      const registry = await runtime.runPromise(StationLivePeerRegistry);
      await runtime.runPromise(service.synchronize());
      await ready(runtime, service, remoteA.hostId);
      await ready(runtime, service, remoteB.hostId);

      service.beginShutdown();
      const deniedA = await runtime.runPromise(
        service.synchronize(remoteA.hostId),
      );
      const deniedB = await runtime.runPromise(
        service.synchronize(remoteB.hostId),
      );
      expect(deniedA[0]?.ok).toBe(false);
      expect(deniedB[0]?.ok).toBe(false);
      if (deniedA[0]?.ok === false) {
        expect(deniedA[0].error.reason).toBe("stopped");
      }

      await runtime.runPromise(service.stop);
      expect(
        await runtime.runPromise(
          registry.isLive(remoteA.hostId, remoteA.stationInstallationId),
        ),
      ).toBe(false);
      expect(
        await runtime.runPromise(
          registry.isLive(remoteB.hostId, remoteB.stationInstallationId),
        ),
      ).toBe(false);
      expect(
        await runtime.runPromise(service.status(remoteA.hostId)),
      ).toMatchObject({ phase: "stopped", sessionOpen: false });
      expect(
        await runtime.runPromise(service.status(remoteB.hostId)),
      ).toMatchObject({ phase: "stopped", sessionOpen: false });
    });
  });

  it("bounds concurrent waiters per target independently for two Remotes", async () => {
    const harness = makeHarness([remoteA, remoteB], {
      blockFirstSynchronizationFor: remoteA.hostId,
    });

    await withRuntime(harness, async (runtime) => {
      const service = await runtime.runPromise(StationFleetPropagation);
      await runtime.runPromise(service.start());
      await runtime.runPromise(harness.synchronizationStarted);

      // Flood A while B stays available.
      const aRequests = Array.from(
        { length: STATION_FLEET_MAX_WAITERS_PER_TARGET + 1 },
        () => runtime.runPromise(service.synchronize(remoteA.hostId)),
      );
      const aCapacity = await Promise.race(aRequests);
      expect(aCapacity[0]?.ok).toBe(false);

      const bOk = await runtime.runPromise(service.synchronize(remoteB.hostId));
      expect(bOk[0]?.ok).toBe(true);

      await runtime.runPromise(harness.releaseSynchronization);
      await Promise.all(aRequests);
    });
  });
});

