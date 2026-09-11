import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Effect,
  Result,
  Exit,
  Layer,
  ManagedRuntime,
  Queue,
  Schema,
  Scope,
  Stream,
} from "effect";
import { afterEach, describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import {
  InstallationId,
  type InstallationId as InstallationIdValue,
} from "../src/shared/installation-id";
import {
  HostId,
  type HostId as HostIdValue,
} from "../src/shared/remote-hosts";
import {
  ConfigureRequest,
  LogicalSequence,
  PairRequest,
  ProjectRequest,
  ReportRequest,
  ReportResponse,
  STATION_API_PROTOCOL,
  StationHostId,
  StationSha256,
  type StationApiRequest,
  type StationReadiness,
} from "../src/shared/station-api";
import {
  stationControlOk,
} from "../src/shared/station-api-envelope";
import type {
  StationSessionFrame,
} from "../src/shared/station-session";
import {
  CURRENT_STATION_PROTOCOL_SUPPORT,
  STATION_PROTOCOL_BASELINE,
  StationAppVersion,
  StationStateSchemaVersion,
} from "../src/shared/station-protocol";
import {
  IntentFactBasis,
  WorkRecord,
  type ActorRef,
  type IntentFactBasis as IntentFactBasisValue,
  type WorkRecord as WorkRecordValue,
} from "../src/shared/work-protocol";
import {
  CanvasesLive,
  CanvasesService,
} from "../src/main/vellum-command/canvases";
import {
  makeSettingsLive,
  SettingsService,
} from "../src/main/vellum-command/settings/service";
import {
  StationApiLive,
  StationApiService,
} from "../src/main/vellum-command/station/api";
import {
  deriveActorSeatId,
} from "../src/main/vellum-command/station/actor-seat-compiler";
import {
  StationFleetTargetRepository,
  StationFleetTargetRepositoryLive,
} from "../src/main/vellum-command/station/fleet-target-repository";
import {
  compileStationPortfolioBody,
  decodeStationPortfolioBody,
} from "../src/main/vellum-command/station/portfolio";
import {
  bindNegotiatedStationProtocol,
  makeStationPeerSession,
  type StationPeerSession,
  type StationSessionFrameTransport,
} from "../src/main/vellum-command/station/peer-session";
import {
  StationPropagation,
  StationPropagationLive,
} from "../src/main/vellum-command/station/propagation";
import {
  makeStationRepositoryLive,
  StationRepository,
} from "../src/main/vellum-command/station/repository";
import {
  StationLivePeerRegistry,
  StationLivePeerRegistryLive,
} from "../src/main/vellum-command/station/session-registry";
import {
  stationControlErrorEnvelope,
} from "../src/main/vellum-command/station/dispatcher";
import {
  makeStateEngineLive,
} from "../src/main/vellum-command/state/engine";
import {
  WorkLive,
  WorkService,
} from "../src/main/vellum-command/work/service";
import {
  executeOverseerWork,
  overseerWorkAdmin,
} from "../src/main/vellum-command/overseer/work";
import {
  createAuthorialTaskDependencyScopeCapability,
  createCurrentProjectedTaskDependencyScopeCapability,
  workRecordContentSha256,
  WorkAuthorityError,
  WorkRepository,
  WorkRepositoryLive,
} from "../src/main/vellum-command/work/repository";
import {
  makeContentServiceLive,
} from "../src/main/vellum-command/content/service";
import { makeInstallOpsLive } from "../src/main/vellum-command/install-ops/engine";

const runEffect = <A, E>(effect: Effect.Effect<A, E, any>): Promise<A> =>
  Effect.runPromise(effect as Effect.Effect<A, E, never>);



const now = "2026-07-27T18:00:00.000Z";
const strictDecode = { onExcessProperty: "error" } as const;
const readiness: StationReadiness = {
  database: true,
  workControl: true,
  simulation: true,
  session: true,
};
const PROTOCOL_DIAGNOSTICS = {
  appVersion: StationAppVersion.make("offline-roundtrip-test"),
  stateSchemaVersion: StationStateSchemaVersion.make(1),
  support: CURRENT_STATION_PROTOCOL_SUPPORT,
};
const PROTOCOL = bindNegotiatedStationProtocol({
  negotiatedProtocol: STATION_PROTOCOL_BASELINE,
  local: PROTOCOL_DIAGNOSTICS,
  peer: PROTOCOL_DIAGNOSTICS,
});

const installation = (value: string): InstallationIdValue =>
  Schema.decodeUnknownSync(InstallationId)(value);

const hostId = (value: string): HostIdValue =>
  Schema.decodeUnknownSync(HostId)(value);

const stationHostId = (value: string) =>
  Schema.decodeUnknownSync(StationHostId)(value);

const generation = (value: string) =>
  Schema.decodeUnknownSync(LogicalSequence)(value);

const projectionSha256 = (value: string) =>
  Schema.decodeUnknownSync(StationSha256)(value);

const makeInstallationRuntime = (
  databasePath: string,
  localInstallationId: InstallationIdValue,
) => {
  // databasePath is `<tmp>/vellum-command.db`; content + install-ops live beside it.
  const installRoot = join(databasePath, "..");
  const state = makeStateEngineLive(databasePath);
  const repositories = Layer.provideMerge(
    Layer.mergeAll(
      WorkRepositoryLive,
      makeStationRepositoryLive({
        makeInstallationId: () => localInstallationId,
        now: () => now,
      }),
      StationFleetTargetRepositoryLive,
      // Pairing/configure fixtures need blank topology (no auto-CC freeze).
      makeSettingsLive({ ensureDefaultCommandCenter: false }),
      makeContentServiceLive({
        root: join(installRoot, "content"),
        skipInlineMediaMigration: true,
      }),
    ),
    Layer.mergeAll(
      state,
      makeInstallOpsLive(join(installRoot, "install-ops.db")),
    ),
  );
  const canvases = Layer.provideMerge(CanvasesLive, repositories);
  const stationApi = Layer.provideMerge(StationApiLive, canvases);
  const stationRuntime = Layer.mergeAll(
    stationApi,
    StationLivePeerRegistryLive,
  );
  const work = Layer.provideMerge(WorkLive, stationRuntime);
  return ManagedRuntime.make(
    Layer.provideMerge(StationPropagationLive, work) as never);
};

type InstallationHarness = {
  readonly root: string;
  readonly runtime: ReturnType<typeof makeInstallationRuntime>;
  readonly api: typeof StationApiService.Service;
  readonly canvases: typeof CanvasesService.Service;
  readonly work: typeof WorkRepository.Service;
  readonly workService: typeof WorkService.Service;
  readonly settings: typeof SettingsService.Service;
  readonly fleetTargets: typeof StationFleetTargetRepository.Service;
  readonly station: typeof StationRepository.Service;
  readonly livePeers: typeof StationLivePeerRegistry.Service;
  readonly propagation: typeof StationPropagation.Service;
};

const activeIntentBasis = async (
  harness: InstallationHarness,
  kind: IntentFactBasisValue["kind"],
): Promise<IntentFactBasisValue> => {
  const witness = await harness.runtime.runPromise(
    harness.canvases.activeIntentWitness(),
  );
  return Schema.decodeUnknownSync(IntentFactBasis, strictDecode)({
    kind,
    ...witness,
  });
};

const currentTaskTopologyCapability = async (
  harness: InstallationHarness,
  kind: "authorial-intent" | "projected-intent",
  sink: { readonly canvasName: string; readonly nodeId: string },
) => {
  if (kind === "authorial-intent") {
    const authority = await harness.runtime.runPromise(
      harness.canvases.authorityMaterialSnapshot(),
    );
    return createAuthorialTaskDependencyScopeCapability({
      authority,
      authoringSink: sink,
    });
  }
  const projection = await harness.runtime.runPromise(harness.station.projection);
  if (projection === undefined) throw new Error("missing Remote projection");
  return createCurrentProjectedTaskDependencyScopeCapability({
    rawBody: projection.body,
    generation: projection.generation,
    contentSha256: projection.contentSha256,
    authoringSink: sink,
  });
};

const resealWorkRecord = (
  candidate: WorkRecordValue,
): WorkRecordValue => {
  const {
    contentSha256: _contentSha256,
    originAt: _originAt,
    ...semantic
  } = candidate;
  return Schema.decodeUnknownSync(WorkRecord, strictDecode)({
    ...candidate,
    contentSha256: workRecordContentSha256(
      semantic as Parameters<typeof workRecordContentSha256>[0],
    ),
  });
};

const opened: Array<InstallationHarness> = [];
const sessionScopes: Array<Scope.Closeable> = [];

afterEach(async () => {
  const scopes = sessionScopes.splice(0);
  await Promise.all(
    scopes.map((scope) =>
      Effect.runPromise(Scope.close(scope, Exit.void)),
    ),
  );
  const closing = opened.splice(0);
  await Promise.all(closing.map(({ runtime }) => runtime.dispose()));
  await Promise.all(
    closing.map(({ root }) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

const openInstallation = async (
  localInstallationId: InstallationIdValue,
): Promise<InstallationHarness> => {
  const root = await mkdtemp(
    join(tmpdir(), `vellum-command-station-offline-${localInstallationId}-`),
  );
  const harness = await openInstallationAt(root, localInstallationId);
  opened.push(harness);
  return harness;
};

const openInstallationAt = async (
  root: string,
  localInstallationId: InstallationIdValue,
): Promise<InstallationHarness> => {
  const runtime = makeInstallationRuntime(
    join(root, "vellum-command.db"),
    localInstallationId,
  );
  const services = await runtime.runPromise(
    Effect.gen(function* () {
      return {
        api: yield* StationApiService,
        canvases: yield* CanvasesService,
        work: yield* WorkRepository,
        workService: yield* WorkService,
        settings: yield* SettingsService,
        fleetTargets: yield* StationFleetTargetRepository,
        station: yield* StationRepository,
        livePeers: yield* StationLivePeerRegistry,
        propagation: yield* StationPropagation,
      };
    }),
  );
  const harness = {
    root,
    runtime,
    ...services,
  } satisfies InstallationHarness;
  return harness;
};

const restartInstallation = async (
  harness: InstallationHarness,
  localInstallationId: InstallationIdValue,
): Promise<InstallationHarness> => {
  const openedIndex = opened.indexOf(harness);
  if (openedIndex < 0) {
    throw new Error("cannot restart an installation outside the test harness");
  }
  await harness.runtime.dispose();
  const restarted = await openInstallationAt(
    harness.root,
    localInstallationId,
  );
  opened[openedIndex] = restarted;
  return restarted;
};

const message = (
  messageId: string,
  role: "user" | "agent",
  text: string,
  taskId: string,
) => ({
  messageId,
  role,
  parts: [{ kind: "text" as const, text }],
  taskId,
  contextId: "factory",
});

const makeInMemoryStationDuplex = Effect.gen(function* () {
  const commandCenterIncoming =
    yield* Queue.unbounded<StationSessionFrame>();
  const remoteIncoming = yield* Queue.unbounded<StationSessionFrame>();
  const close = Effect.all(
    [
      Queue.shutdown(commandCenterIncoming),
      Queue.shutdown(remoteIncoming),
    ],
    { discard: true },
  );
  const transport = (
    incoming: Queue.Dequeue<StationSessionFrame>,
    outgoing: Queue.Enqueue<StationSessionFrame>,
  ): StationSessionFrameTransport => ({
    incoming: Stream.fromQueue(incoming),
    send: (frame) => Queue.offer(outgoing, frame).pipe(Effect.asVoid),
    close,
  });
  return {
    commandCenter: transport(
      commandCenterIncoming,
      remoteIncoming,
    ),
    remote: transport(remoteIncoming, commandCenterIncoming),
  };
});

type ProductSessionConnection = {
  readonly scope: Scope.Closeable;
  readonly commandCenterSession: StationPeerSession;
  readonly remoteSession: StationPeerSession;
};

const apiEnvelope = (
  harness: InstallationHarness,
  peer:
    | { readonly _tag: "command-center-route" }
    | {
        readonly _tag: "enrolled-remote";
        readonly installationId: InstallationIdValue;
      },
) =>
  (request: StationApiRequest) =>
    harness.api.handle(request, readiness, peer).pipe(
      Effect.map(stationControlOk),
      Effect.catch((error) =>
        Effect.succeed(stationControlErrorEnvelope(error))
      ),
    );

const openProductSessionConnection = async (
  commandCenter: InstallationHarness,
  remote: InstallationHarness,
  commandCenterId: InstallationIdValue,
  remoteId: InstallationIdValue,
  remoteHost: HostIdValue,
): Promise<ProductSessionConnection> => {
  const scope = await runEffect(Scope.make());
  sessionScopes.push(scope);
  const sessions = await runEffect(
    Effect.gen(function* () {
      const duplex = yield* makeInMemoryStationDuplex;
      const commandCenterSession = yield* makeStationPeerSession({
        localRole: "command-center",
        localInstallationId: commandCenterId,
        peerInstallationId: remoteId,
        protocol: PROTOCOL,
        transport: duplex.commandCenter,
        handleRequest: apiEnvelope(commandCenter, {
          _tag: "enrolled-remote",
          installationId: remoteId,
        }),
      });
      const remoteSession = yield* makeStationPeerSession({
        localRole: "remote",
        localInstallationId: remoteId,
        peerInstallationId: commandCenterId,
        protocol: PROTOCOL,
        transport: duplex.remote,
        handleRequest: apiEnvelope(remote, {
          _tag: "command-center-route",
        }),
      });
      return { commandCenterSession, remoteSession };
    }).pipe(Effect.provideService(Scope.Scope, scope)),
  );
  await commandCenter.runtime.runPromise(
    commandCenter.livePeers.activate(
      remoteHost,
      remoteId,
      sessions.commandCenterSession,
    ).pipe(Effect.provideService(Scope.Scope, scope)),
  );
  return { scope, ...sessions };
};

const closeProductSessionConnection = (
  connection: ProductSessionConnection,
): Promise<void> =>
  Effect.runPromise(Scope.close(connection.scope, Exit.void));

const productPathDocument = (
  remoteHost: HostIdValue,
  bindingId: string,
): CanvasDoc => ({
  nodes: [
    {
      id: "shared-tasks",
      type: "text",
      x: 0,
      y: 0,
      width: 240,
      height: 100,
      text: "Shared Command Center tasks",
      ether: {
        entity: { kind: "task" },
        host: "local",
      },
    },
    {
      id: "remote-worker",
      type: "text",
      x: 320,
      y: 0,
      width: 240,
      height: 100,
      text: "Remote worker",
      ether: {
        entity: { kind: "agent", name: `${remoteHost}:builder` },
        host: remoteHost,
        terminal: {
          bindingId,
          harness: "codex",
          launch: { kind: "harness", argv: ["codex"] },
        },
      },
    },
  ],
  edges: [
    {
      id: "remote-worker-to-shared-tasks",
      fromNode: "remote-worker",
      toNode: "shared-tasks",
    },
  ],
});

const remoteTaskDocument = (
  remoteHost: HostIdValue,
  bindingId: string,
  includeActor = true,
): CanvasDoc => ({
  nodes: [
    {
      id: "remote-tasks",
      type: "text",
      x: 0,
      y: 0,
      width: 240,
      height: 100,
      text: "Remote tasks",
      ether: { entity: { kind: "task" }, host: remoteHost },
    },
    ...(includeActor
      ? [
          {
            id: "remote-worker",
            type: "text" as const,
            x: 320,
            y: 0,
            width: 240,
            height: 100,
            text: "Remote worker",
            ether: {
              entity: {
                kind: "agent",
                name: `${remoteHost}:builder`,
              },
              host: remoteHost,
              terminal: {
                bindingId,
                harness: "codex" as const,
                launch: {
                  kind: "harness" as const,
                  argv: ["codex"],
                },
              },
            },
          },
        ]
      : []),
  ],
  edges: includeActor
    ? [
        {
          id: "remote-worker-to-remote-tasks",
          fromNode: "remote-worker",
          toNode: "remote-tasks",
        },
      ]
    : [],
});

const archiveCurrentProjection = async (
  commandCenter: InstallationHarness,
  remote: InstallationHarness | undefined,
  commandCenterId: InstallationIdValue,
  remoteId: InstallationIdValue,
  remoteHost: HostIdValue,
) => {
  const authority = await commandCenter.runtime.runPromise(
    commandCenter.canvases.authoritySnapshot(),
  );
  const projection = await commandCenter.runtime.runPromise(
    commandCenter.station.archiveProjection({
      scope: "full",
      sourceCanvasGeneration: generation(authority.generation),
      sourceIntentSha256: projectionSha256(authority.intentSha256),
      body: compileStationPortfolioBody(
        authority.documents,
        new Map([
          ["local", commandCenterId],
          [remoteHost, remoteId],
        ]),
      ),
      createdAt: now,
    }),
  );
  if (remote !== undefined) {
    await remote.runtime.runPromise(
      remote.api.handle(
        ProjectRequest.make({
          protocol: STATION_API_PROTOCOL,
          op: "project",
          stationInstallationId: remoteId,
          projection,
        }),
        readiness,
        { _tag: "command-center-route" },
      ),
    );
  }
  return projection;
};

const configureDirectPair = async (
  commandCenter: InstallationHarness,
  remote: InstallationHarness,
  commandCenterId: InstallationIdValue,
  remoteId: InstallationIdValue,
  remoteHost: HostIdValue,
  document: CanvasDoc,
) => {
  await commandCenter.runtime.runPromise(
    commandCenter.settings.setStationTopology({
      role: "command-center",
      hostId: "local",
      supervisedPreferred: true,
    }),
  );
  await commandCenter.runtime.runPromise(
    commandCenter.fleetTargets.bind(
      { hostId: remoteHost, stationInstallationId: remoteId },
      now,
    ),
  );
  await commandCenter.runtime.runPromise(
    commandCenter.canvases.write("factory", document),
  );
  await remote.runtime.runPromise(
    remote.api.handle(
      PairRequest.make({
        protocol: STATION_API_PROTOCOL,
        op: "pair",
        commandCenterInstallationId: commandCenterId,
        stationInstallationId: remoteId,
        stationLabel: "Report Remote",
        appVersion: "0.1.0",
      }),
      readiness,
      { _tag: "command-center-route" },
    ),
  );
  const remoteStationHost = stationHostId(remoteHost);
  await remote.runtime.runPromise(
    remote.api.handle(
      ConfigureRequest.make({
        protocol: STATION_API_PROTOCOL,
        op: "configure",
        installationId: remoteId,
        configuration: {
          role: "remote",
          hostId: remoteStationHost,
          agentHostId: remoteStationHost,
          commandCenterInstallationId: commandCenterId,
          supervisedPreferred: true,
        },
        host: {
          id: remoteHost,
          label: "Report Remote",
          kind: "remote",
          capabilities: ["terminal"],
        },
      }),
      readiness,
      { _tag: "command-center-route" },
    ),
  );
  return archiveCurrentProjection(
    commandCenter,
    remote,
    commandCenterId,
    remoteId,
    remoteHost,
  );
};


describe("Station work authority survives Command Center downtime", () => {
  it("adopts one live-reserved CC task, progresses it offline, and reconciles by route sequence", async () => {
    const commandCenterId = installation("cc-offline-roundtrip");
    const remoteId = installation("remote-offline-roundtrip");
    const remoteHost = hostId("remote");
    const remoteStationHost = stationHostId(remoteHost);
    const commandCenter = await openInstallation(commandCenterId);
    const remote = await openInstallation(remoteId);
    const bindingId = "binding-remote-worker";
    const actor: ActorRef = {
      seatId: deriveActorSeatId(remoteId, bindingId),
      canvasName: "factory",
      nodeId: "remote-worker",
    };
    const sink = {
      canvasName: "factory",
      nodeId: "shared-tasks",
    };
    const document: CanvasDoc = {
      nodes: [
        {
          id: sink.nodeId,
          type: "text",
          x: 0,
          y: 0,
          width: 240,
          height: 100,
          text: "Shared Command Center tasks",
          ether: {
            entity: { kind: "task" },
            host: "local",
          },
        },
        {
          id: actor.nodeId,
          type: "text",
          x: 320,
          y: 0,
          width: 240,
          height: 100,
          text: "Remote worker",
          ether: {
            entity: { kind: "agent", name: "remote:builder" },
            host: remoteHost,
            terminal: {
              bindingId,
              harness: "codex",
              launch: { kind: "harness", argv: ["codex"] },
            },
          },
        },
      ],
      edges: [
        {
          id: "remote-worker-to-shared-tasks",
          fromNode: actor.nodeId,
          toNode: sink.nodeId,
        },
      ],
    };

    await commandCenter.runtime.runPromise(
      commandCenter.settings.setStationTopology({
        role: "command-center",
        hostId: "local",
        supervisedPreferred: true,
      }),
    );
    await commandCenter.runtime.runPromise(
      commandCenter.fleetTargets.bind(
        {
          hostId: remoteHost,
          stationInstallationId: remoteId,
        },
        now,
      ),
    );
    await commandCenter.runtime.runPromise(
      commandCenter.canvases.write("factory", document),
    );

    await remote.runtime.runPromise(
      remote.api.handle(
        PairRequest.make({
          protocol: STATION_API_PROTOCOL,
          op: "pair",
          commandCenterInstallationId: commandCenterId,
          stationInstallationId: remoteId,
          stationLabel: "Remote",
          appVersion: "0.1.0",
        }),
        readiness,
        { _tag: "command-center-route" },
      ),
    );
    await remote.runtime.runPromise(
      remote.api.handle(
        ConfigureRequest.make({
          protocol: STATION_API_PROTOCOL,
          op: "configure",
          installationId: remoteId,
          configuration: {
            role: "remote",
            hostId: remoteStationHost,
            agentHostId: remoteStationHost,
            commandCenterInstallationId: commandCenterId,
            supervisedPreferred: true,
          },
          host: {
            id: remoteHost,
            label: "Remote",
            kind: "remote",
            capabilities: ["terminal"],
          },
        }),
        readiness,
        { _tag: "command-center-route" },
      ),
    );

    const authority = await commandCenter.runtime.runPromise(
      commandCenter.canvases.authoritySnapshot(),
    );
    const projectionBody = compileStationPortfolioBody(
      authority.documents,
      new Map([
        ["local", commandCenterId],
        [remoteHost, remoteId],
      ]),
    );
    const archivedProjection =
      await commandCenter.runtime.runPromise(
        commandCenter.station.archiveProjection({
          scope: "full",
          sourceCanvasGeneration: generation(authority.generation),
          sourceIntentSha256: projectionSha256(
            authority.intentSha256,
          ),
          body: projectionBody,
          createdAt: now,
        }),
      );
    await remote.runtime.runPromise(
      remote.api.handle(
        ProjectRequest.make({
          protocol: STATION_API_PROTOCOL,
          op: "project",
          stationInstallationId: remoteId,
          projection: archivedProjection,
        }),
        readiness,
        { _tag: "command-center-route" },
      ),
    );

    const firstTaskId = "task-offline-roundtrip";
    const secondTaskId = "task-must-not-claim-offline";
    const commandCenterBasis = await activeIntentBasis(
      commandCenter,
      "authorial-intent",
    );
    const remoteBasis = await activeIntentBasis(
      remote,
      "projected-intent",
    );
    const commandCenterAuthority = await commandCenter.runtime.runPromise(
      commandCenter.canvases.authorityMaterialSnapshot(),
    );
    const remoteProjection = await remote.runtime.runPromise(
      remote.station.projection,
    );
    if (remoteProjection === undefined) {
      throw new Error("expected an installed Remote projection");
    }
    const commandCenterDependencyScope =
      createAuthorialTaskDependencyScopeCapability({
        authority: commandCenterAuthority,
        authoringSink: sink,
      });
    const remoteDependencyScope =
      createCurrentProjectedTaskDependencyScopeCapability({
        rawBody: remoteProjection.body,
        generation: remoteProjection.generation,
        contentSha256: remoteProjection.contentSha256,
        authoringSink: sink,
      });
    await commandCenter.runtime.runPromise(
      commandCenter.work.createTask({
        sink,
        task: {
          id: firstTaskId,
          state: "submitted",
          history: [
            message(
              "brief-offline-roundtrip",
              "user",
              "ship while Command Center is offline",
              firstTaskId,
            ),
          ],
        },
        basis: commandCenterBasis,
        dependencyScope: commandCenterDependencyScope,
        originAt: now,
        receivedAt: now,
      }),
    );
    await commandCenter.runtime.runPromise(
      commandCenter.work.createTask({
        sink,
        task: {
          id: secondTaskId,
          state: "submitted",
          history: [
            message(
              "brief-must-not-claim-offline",
              "user",
              "remain at Command Center until a live reservation",
              secondTaskId,
            ),
          ],
        },
        basis: commandCenterBasis,
        dependencyScope: commandCenterDependencyScope,
        originAt: now,
        receivedAt: now,
      }),
    );
    await commandCenter.runtime.runPromise(
      commandCenter.work.reserveRemoteTaskClaim({
        targetInstallationId: remoteId,
        sink,
        basis: commandCenterBasis,
        dependencyScope: commandCenterDependencyScope,
        taskId: firstTaskId,
        actor,
        originAt: now,
        receivedAt: now,
      }),
    );

    const claimRequest = await commandCenter.runtime.runPromise(
      commandCenter.api.prepareReport(remoteId),
    );
    expect(claimRequest.batch.records).toHaveLength(1);
    expect(claimRequest.batch.records[0]).toMatchObject({
      recordType: "command",
      operation: "task.claim",
      id: {
        route: {
          eventHome: commandCenterId,
          entityHome: remoteId,
        },
        seq: "1",
      },
      body: {
        operation: "task.claim",
        sourceQueueHome: commandCenterId,
        targetHome: remoteId,
        actor,
        sourceTask: {
          id: firstTaskId,
          state: "submitted",
        },
      },
    });

    const claimResponse = await remote.runtime.runPromise(
      remote.api.handle(
        claimRequest,
        readiness,
        { _tag: "command-center-route" },
      ),
    );
    if (claimResponse.op !== "report") {
      throw new Error("claim report did not produce a report response");
    }
    expect(claimResponse.batch.records).toHaveLength(2);
    expect(
      claimResponse.batch.records.map((record) => record.recordType),
    ).toEqual(["fact", "disposition"]);
    expect(claimResponse.batch.records[0]).toMatchObject({
      recordType: "fact",
      operation: "task.claim",
      id: {
        route: { eventHome: remoteId, entityHome: remoteId },
        seq: "1",
      },
      body: {
        operation: "task.claim",
        previousHome: commandCenterId,
        claimedBy: actor,
        task: {
          id: firstTaskId,
          state: "working",
          claimedBy: actor.seatId,
        },
      },
    });
    expect(claimResponse.batch.records[1]).toMatchObject({
      recordType: "disposition",
      id: {
        route: { eventHome: remoteId, entityHome: remoteId },
        seq: "2",
      },
      body: {
        status: "applied",
        command: claimRequest.batch.records[0]?.id,
      },
    });

    expect(
      (
        await remote.runtime.runPromise(
          remote.work.readSnapshot(sink.canvasName, sink.nodeId),
        )
      ).tasks.items,
    ).toEqual([
      expect.objectContaining({
        id: firstTaskId,
        state: "working",
        claimedBy: actor.seatId,
      }),
    ]);
    expect(
      await remote.runtime.runPromise(
        remote.work.itemHome(
          "task",
          sink.canvasName,
          sink.nodeId,
          firstTaskId,
        ),
      ),
    ).toBe(remoteId);

    // Command Center advances to G2 and revokes the Remote actor before the
    // G1 claim response arrives. The Remote stays disconnected on installed
    // G1; Command Center retains both immutable projection witnesses.
    await commandCenter.runtime.runPromise(
      commandCenter.canvases.write("factory", {
        ...document,
        nodes: document.nodes.filter(
          (node) => node.id !== actor.nodeId,
        ),
        edges: [],
      }),
    );
    const authorityG2 = await commandCenter.runtime.runPromise(
      commandCenter.canvases.authoritySnapshot(),
    );
    const projectionG2 = await commandCenter.runtime.runPromise(
      commandCenter.station.archiveProjection({
        scope: "full",
        sourceCanvasGeneration: generation(authorityG2.generation),
        sourceIntentSha256: projectionSha256(
          authorityG2.intentSha256,
        ),
        body: compileStationPortfolioBody(
          authorityG2.documents,
          new Map([
            ["local", commandCenterId],
            [remoteHost, remoteId],
          ]),
        ),
        createdAt: now,
      }),
    );
    expect(projectionG2.generation).toBe("2");
    expect(
      await commandCenter.runtime.runPromise(
        commandCenter.station.projection,
      ),
    ).toMatchObject({
      generation: "2",
      contentSha256: projectionG2.contentSha256,
    });
    expect(
      await remote.runtime.runPromise(remote.station.projection),
    ).toMatchObject({
      generation: archivedProjection.generation,
      contentSha256: archivedProjection.contentSha256,
    });

    await commandCenter.runtime.runPromise(
      commandCenter.api.acceptReportResponse(
        remoteId,
        claimRequest,
        claimResponse,
      ),
    );
    const commandCenterAfterClaim =
      await commandCenter.runtime.runPromise(
        commandCenter.work.readSnapshot(
          sink.canvasName,
          sink.nodeId,
        ),
      );
    expect(commandCenterAfterClaim.tasks.items).toHaveLength(2);
    expect(commandCenterAfterClaim.tasks.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: firstTaskId,
          state: "working",
          claimedBy: actor.seatId,
        }),
        expect.objectContaining({
          id: secondTaskId,
          state: "submitted",
        }),
      ]),
    );
    expect(
      await commandCenter.runtime.runPromise(
        commandCenter.work.itemHome(
          "task",
          sink.canvasName,
          sink.nodeId,
          firstTaskId,
        ),
      ),
    ).toBe(remoteId);

    // No Command Center exchange runs between this point and the later report.
    // The Remote owns the adopted row and can durably advance it under G1.
    const unreservedOfflineClaim = await remote.runtime.runPromise(
      remote.work.claimLocalTask({
        sink,
        taskId: secondTaskId,
        actor,
        basis: remoteBasis,
        dependencyScope: remoteDependencyScope,
        originAt: now,
        receivedAt: now,
      }).pipe(Effect.result),
    );
    expect(Result.isFailure(unreservedOfflineClaim)).toBe(true);
    if (Result.isFailure(unreservedOfflineClaim)) {
      expect(unreservedOfflineClaim.failure).toBeInstanceOf(
        WorkAuthorityError,
      );
      expect(unreservedOfflineClaim.failure).toMatchObject({
        reason: "missing-entity",
      });
    }

    const completed = await remote.runtime.runPromise(
      remote.work.transitionTask({
        sink,
        taskId: firstTaskId,
        state: "completed",
        message: message(
          "done-offline-roundtrip",
          "agent",
          "completed without Command Center",
          firstTaskId,
        ),
        basis: remoteBasis,
        // Display time deliberately ties every fact. Logical route sequence,
        // not wall clock/LWW, establishes the terminal state.
        originAt: now,
        receivedAt: now,
      }),
    );
    expect(completed.record).toMatchObject({
      recordType: "fact",
      operation: "task.transition",
      id: {
        route: { eventHome: remoteId, entityHome: remoteId },
        seq: "3",
      },
      predecessor: claimResponse.batch.records[0]?.id,
      body: {
        operation: "task.transition",
        task: {
          id: firstTaskId,
          state: "completed",
          claimedBy: actor.seatId,
        },
      },
    });

    const progressRequest = await remote.runtime.runPromise(
      remote.api.prepareReport(commandCenterId),
    );
    expect(
      progressRequest.batch.records.map((record) => [
        record.recordType,
        record.operation,
        record.id.seq,
      ]),
    ).toEqual([
      ["fact", "task.claim", "1"],
      ["disposition", "task.claim", "2"],
      ["fact", "task.transition", "3"],
    ]);

    if (completed.record.basis.kind !== "projected-intent") {
      throw new Error("offline transition did not retain projected intent");
    }
    const statusBeforeForgedFacts =
      await commandCenter.runtime.runPromise(
        commandCenter.station.statusFacts,
      );
    const forgedBases: ReadonlyArray<
      typeof completed.record.basis
    > = [
      {
        ...completed.record.basis,
        generation:
          "999" as typeof completed.record.basis.generation,
      },
      {
        ...completed.record.basis,
        contentSha256:
          "f".repeat(64) as typeof completed.record.basis.contentSha256,
      },
    ];
    for (const forgedBasis of forgedBases) {
      const forgedFact = resealWorkRecord({
        ...completed.record,
        basis: forgedBasis,
      });
      const forgedRequest = ReportRequest.make({
        ...progressRequest,
        batch: {
          ...progressRequest.batch,
          records: progressRequest.batch.records.map((record) =>
            record.recordType === "fact" && record.id.seq === "3"
              ? forgedFact
              : record
          ),
        },
      });
      const denied = await commandCenter.runtime.runPromise(
        commandCenter.api.handle(
          forgedRequest,
          readiness,
          {
            _tag: "enrolled-remote",
            installationId: remoteId,
          },
        ).pipe(Effect.result),
      );
      expect(Result.isFailure(denied)).toBe(true);
      expect(
        await commandCenter.runtime.runPromise(
          commandCenter.station.statusFacts,
        ),
      ).toEqual(statusBeforeForgedFacts);
      expect(
        (
          await commandCenter.runtime.runPromise(
            commandCenter.work.readSnapshot(
              sink.canvasName,
              sink.nodeId,
            ),
          )
        ).tasks.items.find((task) => task.id === firstTaskId)?.state,
      ).toBe("working");
      expect(
        await commandCenter.runtime.runPromise(
          commandCenter.work.recordsAfter({
            route: {
              eventHome: remoteId,
              entityHome: remoteId,
            },
            after: claimResponse.batch.records[1]!.id.seq,
          }),
        ),
      ).toEqual([]);
    }

    const progressResponse = await commandCenter.runtime.runPromise(
      commandCenter.api.handle(
        progressRequest,
        readiness,
        {
          _tag: "enrolled-remote",
          installationId: remoteId,
        },
      ),
    );
    if (progressResponse.op !== "report") {
      throw new Error("progress report did not produce a report response");
    }
    await remote.runtime.runPromise(
      remote.api.acceptReportResponse(
        commandCenterId,
        progressRequest,
        progressResponse,
      ),
    );

    const reconciled = await commandCenter.runtime.runPromise(
      commandCenter.work.readSnapshot(
        sink.canvasName,
        sink.nodeId,
      ),
    );
    expect(reconciled.tasks.items).toHaveLength(2);
    expect(reconciled.tasks.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: firstTaskId,
          state: "completed",
          claimedBy: actor.seatId,
        }),
        expect.objectContaining({
          id: secondTaskId,
          state: "submitted",
        }),
      ]),
    );
    expect(
      await commandCenter.runtime.runPromise(
        commandCenter.work.itemHome(
          "task",
          sink.canvasName,
          sink.nodeId,
          firstTaskId,
        ),
      ),
    ).toBe(remoteId);
  });

  it("claims through WorkService only with a live persistent session and converges after reconnect", async () => {
    const commandCenterId = installation("cc-product-session-roundtrip");
    const remoteId = installation("remote-product-session-roundtrip");
    const remoteHost = hostId("product-remote");
    const remoteStationHost = stationHostId(remoteHost);
    const commandCenter = await openInstallation(commandCenterId);
    let remote = await openInstallation(remoteId);
    const document = productPathDocument(
      remoteHost,
      "binding-product-remote-worker",
    );

    await commandCenter.runtime.runPromise(
      commandCenter.settings.setStationTopology({
        role: "command-center",
        hostId: "local",
        supervisedPreferred: true,
      }),
    );
    await commandCenter.runtime.runPromise(
      commandCenter.fleetTargets.bind(
        {
          hostId: remoteHost,
          stationInstallationId: remoteId,
        },
        now,
      ),
    );
    await commandCenter.runtime.runPromise(
      commandCenter.canvases.write("factory", document),
    );
    await remote.runtime.runPromise(
      remote.api.handle(
        PairRequest.make({
          protocol: STATION_API_PROTOCOL,
          op: "pair",
          commandCenterInstallationId: commandCenterId,
          stationInstallationId: remoteId,
          stationLabel: "Product Remote",
          appVersion: "0.1.0",
        }),
        readiness,
        { _tag: "command-center-route" },
      ),
    );
    await remote.runtime.runPromise(
      remote.api.handle(
        ConfigureRequest.make({
          protocol: STATION_API_PROTOCOL,
          op: "configure",
          installationId: remoteId,
          configuration: {
            role: "remote",
            hostId: remoteStationHost,
            agentHostId: remoteStationHost,
            commandCenterInstallationId: commandCenterId,
            supervisedPreferred: true,
          },
          host: {
            id: remoteHost,
            label: "Product Remote",
            kind: "remote",
            capabilities: ["terminal"],
          },
        }),
        readiness,
        { _tag: "command-center-route" },
      ),
    );

    const firstConnection = await openProductSessionConnection(
      commandCenter,
      remote,
      commandCenterId,
      remoteId,
      remoteHost,
    );
    expect(
      await commandCenter.runtime.runPromise(
        commandCenter.livePeers.isLive(remoteHost, remoteId),
      ),
    ).toBe(true);

    const projectionReceipt =
      await commandCenter.runtime.runPromise(
        commandCenter.propagation.synchronize(
          {
            stationInstallationId: remoteId,
            hostId: remoteStationHost,
          },
          firstConnection.commandCenterSession,
        ),
      );
    expect(projectionReceipt.projection.decision).toBe("install");
    expect(
      await remote.runtime.runPromise(remote.station.projection),
    ).toMatchObject({
      scope: "full",
      generation: "1",
    });

    const created = await commandCenter.runtime.runPromise(
      commandCenter.workService.workTaskCreate(
        "factory",
        "shared-tasks",
        "complete this task while Command Center is disconnected",
        {
          details:
            "complete this task while Command Center is disconnected",
        },
      ),
    );
    expect(created).toMatchObject({
      ok: true,
      disposition: "applied",
    });
    if (!created.ok) {
      throw new Error("product task creation failed");
    }
    const taskId = created.data.id;
    const commandCenterCanvas =
      await commandCenter.runtime.runPromise(
        commandCenter.canvases.read("factory"),
      );
    const actor = commandCenterCanvas.actorRefs.find(
      (candidate) => candidate.nodeId === "remote-worker",
    );
    if (actor === undefined) {
      throw new Error("projection did not compile the Remote actor seat");
    }

    const claimed = await commandCenter.runtime.runPromise(
      commandCenter.workService.workTaskClaim(
        "factory",
        "shared-tasks",
        taskId,
        actor,
      ),
    );
    expect(claimed).toMatchObject({
      ok: true,
      disposition: "queued",
    });

    const claimReceipt = await commandCenter.runtime.runPromise(
      commandCenter.propagation.synchronize(
        {
          stationInstallationId: remoteId,
          hostId: remoteStationHost,
        },
        firstConnection.commandCenterSession,
      ),
    );
    expect(claimReceipt.report).toMatchObject({
      outboundSent: 1,
      inboundReceived: 2,
      inboundAccepted: 2,
      inboundRejected: 0,
    });
    expect(
      (
        await remote.runtime.runPromise(
          remote.work.readSnapshot("factory", "shared-tasks"),
        )
      ).tasks.items,
    ).toEqual([
      expect.objectContaining({
        id: taskId,
        state: "working",
        claimedBy: actor.seatId,
      }),
    ]);
    expect(
      await remote.runtime.runPromise(
        remote.work.itemHome(
          "task",
          "factory",
          "shared-tasks",
          taskId,
        ),
      ),
    ).toBe(remoteId);

    await closeProductSessionConnection(firstConnection);
    expect(
      await commandCenter.runtime.runPromise(
        commandCenter.livePeers.isLive(remoteHost, remoteId),
      ),
    ).toBe(false);

    remote = await restartInstallation(remote, remoteId);
    expect(
      (
        await remote.runtime.runPromise(
          remote.work.readSnapshot("factory", "shared-tasks"),
        )
      ).tasks.items,
    ).toEqual([
      expect.objectContaining({
        id: taskId,
        state: "working",
        claimedBy: actor.seatId,
      }),
    ]);
    expect(
      await remote.runtime.runPromise(
        remote.work.itemHome(
          "task",
          "factory",
          "shared-tasks",
          taskId,
        ),
      ),
    ).toBe(remoteId);

    const completed = await remote.runtime.runPromise(
      remote.workService.workTaskTransition(
        "factory",
        "shared-tasks",
        taskId,
        "completed",
        "completed while Command Center was unavailable",
      ),
    );
    expect(completed).toMatchObject({
      ok: true,
      disposition: "applied",
      data: {
        id: taskId,
        state: "completed",
        claimedBy: actor.seatId,
      },
    });

    // The Command Center has not exchanged a frame since disconnect, so its
    // durable read model remains at the last integrated Remote fact.
    expect(
      (
        await commandCenter.runtime.runPromise(
          commandCenter.work.readSnapshot(
            "factory",
            "shared-tasks",
          ),
        )
      ).tasks.items,
    ).toEqual([
      expect.objectContaining({
        id: taskId,
        state: "working",
        claimedBy: actor.seatId,
      }),
    ]);

    const secondConnection = await openProductSessionConnection(
      commandCenter,
      remote,
      commandCenterId,
      remoteId,
      remoteHost,
    );
    const reconciliation =
      await commandCenter.runtime.runPromise(
        commandCenter.propagation.synchronize(
          {
            stationInstallationId: remoteId,
            hostId: remoteStationHost,
          },
          secondConnection.commandCenterSession,
        ),
      );
    expect(reconciliation.report).toMatchObject({
      outboundSent: 0,
      inboundReceived: 1,
      inboundAccepted: 1,
      inboundRejected: 0,
      receivedThrough: [
        {
          eventHome: remoteId,
          entityHome: remoteId,
          through: "3",
        },
      ],
    });

    const reconciled = await commandCenter.runtime.runPromise(
      commandCenter.work.readSnapshot(
        "factory",
        "shared-tasks",
      ),
    );
    expect(reconciled.tasks.items).toEqual([
      expect.objectContaining({
        id: taskId,
        state: "completed",
        claimedBy: actor.seatId,
      }),
    ]);
    expect(
      await commandCenter.runtime.runPromise(
        commandCenter.work.itemHome(
          "task",
          "factory",
          "shared-tasks",
          taskId,
        ),
      ),
    ).toBe(remoteId);

    const commandCenterCursors =
      await commandCenter.runtime.runPromise(
        commandCenter.station.statusFacts,
      );
    expect(commandCenterCursors.receivedThrough).toContainEqual({
      eventHome: remoteId,
      entityHome: remoteId,
      through: "3",
    });
    expect(
      commandCenterCursors.peerAcknowledgedThrough,
    ).toContainEqual({
      peerInstallationId: remoteId,
      acknowledgement: {
        eventHome: commandCenterId,
        entityHome: remoteId,
        through: "1",
      },
    });
  });

  /**
   * FLEET-P4 — two Remotes claim distinct CC-home tasks through live sessions.
   * Proves exact claim selection (one actor per task) and failure isolation
   * when Remote A disconnects while Remote B continues.
   */
  it("claims exact CC-home tasks on two Remotes without duplicate execution or cross-contamination", async () => {
    const commandCenterId = installation("cc-two-remote-claim");
    const remoteAId = installation("remote-a-two-remote-claim");
    const remoteBId = installation("remote-b-two-remote-claim");
    const remoteAHost = hostId("remote-a");
    const remoteBHost = hostId("remote-b");
    const remoteAStationHost = stationHostId(remoteAHost);
    const remoteBStationHost = stationHostId(remoteBHost);
    const commandCenter = await openInstallation(commandCenterId);
    const remoteA = await openInstallation(remoteAId);
    const remoteB = await openInstallation(remoteBId);

    const document: CanvasDoc = {
      nodes: [
        {
          id: "shared-tasks",
          type: "text",
          x: 0,
          y: 0,
          width: 240,
          height: 100,
          text: "Shared Command Center tasks",
          ether: { entity: { kind: "task" }, host: "local" },
        },
        {
          id: "worker-a",
          type: "text",
          x: 320,
          y: 0,
          width: 240,
          height: 100,
          text: "Remote A worker",
          ether: {
            entity: { kind: "agent", name: "remote-a:builder" },
            host: remoteAHost,
            terminal: {
              bindingId: "binding-a",
              harness: "codex",
              launch: { kind: "harness", argv: ["codex"] },
            },
          },
        },
        {
          id: "worker-b",
          type: "text",
          x: 320,
          y: 160,
          width: 240,
          height: 100,
          text: "Remote B worker",
          ether: {
            entity: { kind: "agent", name: "remote-b:builder" },
            host: remoteBHost,
            terminal: {
              bindingId: "binding-b",
              harness: "codex",
              launch: { kind: "harness", argv: ["codex"] },
            },
          },
        },
      ],
      edges: [
        { id: "a-to-tasks", fromNode: "worker-a", toNode: "shared-tasks" },
        { id: "b-to-tasks", fromNode: "worker-b", toNode: "shared-tasks" },
      ],
    };

    await commandCenter.runtime.runPromise(
      commandCenter.settings.setStationTopology({
        role: "command-center",
        hostId: "local",
        supervisedPreferred: true,
      }),
    );
    await commandCenter.runtime.runPromise(
      commandCenter.fleetTargets.bind(
        { hostId: remoteAHost, stationInstallationId: remoteAId },
        now,
      ),
    );
    await commandCenter.runtime.runPromise(
      commandCenter.fleetTargets.bind(
        { hostId: remoteBHost, stationInstallationId: remoteBId },
        now,
      ),
    );
    await commandCenter.runtime.runPromise(
      commandCenter.canvases.write("factory", document),
    );

    const pairAndConfigure = async (
      remote: InstallationHarness,
      remoteId: InstallationIdValue,
      remoteHost: HostIdValue,
      remoteStationHost: ReturnType<typeof stationHostId>,
      label: string,
    ) => {
      await remote.runtime.runPromise(
        remote.api.handle(
          PairRequest.make({
            protocol: STATION_API_PROTOCOL,
            op: "pair",
            commandCenterInstallationId: commandCenterId,
            stationInstallationId: remoteId,
            stationLabel: label,
            appVersion: "0.1.0",
          }),
          readiness,
          { _tag: "command-center-route" },
        ),
      );
      await remote.runtime.runPromise(
        remote.api.handle(
          ConfigureRequest.make({
            protocol: STATION_API_PROTOCOL,
            op: "configure",
            installationId: remoteId,
            configuration: {
              role: "remote",
              hostId: remoteStationHost,
              agentHostId: remoteStationHost,
              commandCenterInstallationId: commandCenterId,
              supervisedPreferred: true,
            },
            host: {
              id: remoteHost,
              label,
              kind: "remote",
              capabilities: ["terminal"],
            },
          }),
          readiness,
          { _tag: "command-center-route" },
        ),
      );
    };
    await pairAndConfigure(
      remoteA,
      remoteAId,
      remoteAHost,
      remoteAStationHost,
      "Remote A",
    );
    await pairAndConfigure(
      remoteB,
      remoteBId,
      remoteBHost,
      remoteBStationHost,
      "Remote B",
    );

    const connectionA = await openProductSessionConnection(
      commandCenter,
      remoteA,
      commandCenterId,
      remoteAId,
      remoteAHost,
    );
    const connectionB = await openProductSessionConnection(
      commandCenter,
      remoteB,
      commandCenterId,
      remoteBId,
      remoteBHost,
    );

    // Independent complete projections — same authorial generation, two homes.
    const projA = await commandCenter.runtime.runPromise(
      commandCenter.propagation.synchronize(
        {
          stationInstallationId: remoteAId,
          hostId: remoteAStationHost,
        },
        connectionA.commandCenterSession,
      ),
    );
    const projB = await commandCenter.runtime.runPromise(
      commandCenter.propagation.synchronize(
        {
          stationInstallationId: remoteBId,
          hostId: remoteBStationHost,
        },
        connectionB.commandCenterSession,
      ),
    );
    expect(projA.projection.decision).toBe("install");
    expect(projB.projection.decision).toBe("install");

    const createTask = async (brief: string) => {
      const created = await commandCenter.runtime.runPromise(
        commandCenter.workService.workTaskCreate(
          "factory",
          "shared-tasks",
          brief,
          { details: brief },
        ),
      );
      expect(created).toMatchObject({ ok: true, disposition: "applied" });
      if (!created.ok) throw new Error("task create failed");
      return created.data.id as string;
    };
    const taskForA = await createTask("task for Remote A only");
    const taskForB = await createTask("task for Remote B only");

    const canvas = await commandCenter.runtime.runPromise(
      commandCenter.canvases.read("factory"),
    );
    const actorA = canvas.actorRefs.find((a) => a.nodeId === "worker-a");
    const actorB = canvas.actorRefs.find((a) => a.nodeId === "worker-b");
    if (!actorA || !actorB) {
      throw new Error("expected both Remote actors in the authorial canvas");
    }

    const claimA = await commandCenter.runtime.runPromise(
      commandCenter.workService.workTaskClaim(
        "factory",
        "shared-tasks",
        taskForA,
        actorA,
      ),
    );
    const claimB = await commandCenter.runtime.runPromise(
      commandCenter.workService.workTaskClaim(
        "factory",
        "shared-tasks",
        taskForB,
        actorB,
      ),
    );
    expect(claimA).toMatchObject({ ok: true });
    expect(claimB).toMatchObject({ ok: true });

    await commandCenter.runtime.runPromise(
      commandCenter.propagation.synchronize(
        {
          stationInstallationId: remoteAId,
          hostId: remoteAStationHost,
        },
        connectionA.commandCenterSession,
      ),
    );
    await commandCenter.runtime.runPromise(
      commandCenter.propagation.synchronize(
        {
          stationInstallationId: remoteBId,
          hostId: remoteBStationHost,
        },
        connectionB.commandCenterSession,
      ),
    );

    const snapA = await remoteA.runtime.runPromise(
      remoteA.work.readSnapshot("factory", "shared-tasks"),
    );
    const snapB = await remoteB.runtime.runPromise(
      remoteB.work.readSnapshot("factory", "shared-tasks"),
    );
    expect(snapA.tasks.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: taskForA,
          state: "working",
          claimedBy: actorA.seatId,
        }),
      ]),
    );
    expect(snapB.tasks.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: taskForB,
          state: "working",
          claimedBy: actorB.seatId,
        }),
      ]),
    );
    // Exact claim: A does not hold B's task as working under actorA.
    expect(
      snapA.tasks.items.find((t) => t.id === taskForB)?.claimedBy,
    ).not.toBe(actorA.seatId);
    expect(
      snapB.tasks.items.find((t) => t.id === taskForA)?.claimedBy,
    ).not.toBe(actorB.seatId);

    // Failure isolation: drop Remote A; Remote B still completes its claim.
    await closeProductSessionConnection(connectionA);
    expect(
      await commandCenter.runtime.runPromise(
        commandCenter.livePeers.isLive(remoteAHost, remoteAId),
      ),
    ).toBe(false);
    expect(
      await commandCenter.runtime.runPromise(
        commandCenter.livePeers.isLive(remoteBHost, remoteBId),
      ),
    ).toBe(true);

    const completedB = await remoteB.runtime.runPromise(
      remoteB.workService.workTaskTransition(
        "factory",
        "shared-tasks",
        taskForB,
        "completed",
        "B finished while A was disconnected",
      ),
    );
    expect(completedB).toMatchObject({
      ok: true,
      data: { id: taskForB, state: "completed", claimedBy: actorB.seatId },
    });

    const reconcileB = await commandCenter.runtime.runPromise(
      commandCenter.propagation.synchronize(
        {
          stationInstallationId: remoteBId,
          hostId: remoteBStationHost,
        },
        connectionB.commandCenterSession,
      ),
    );
    expect(reconcileB.report.inboundRejected).toBe(0);

    const ccSnap = await commandCenter.runtime.runPromise(
      commandCenter.work.readSnapshot("factory", "shared-tasks"),
    );
    expect(ccSnap.tasks.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: taskForB,
          state: "completed",
          claimedBy: actorB.seatId,
        }),
        expect.objectContaining({
          id: taskForA,
          state: "working",
          claimedBy: actorA.seatId,
        }),
      ]),
    );

    // Remotes never open sessions to each other — only CC↔Remote product paths.
    expect(connectionA.commandCenterSession.localInstallationId).toBe(
      commandCenterId,
    );
    expect(connectionA.commandCenterSession.peerInstallationId).toBe(remoteAId);
    expect(connectionB.commandCenterSession.peerInstallationId).toBe(remoteBId);
    expect(connectionA.remoteSession.peerInstallationId).toBe(commandCenterId);
    expect(connectionB.remoteSession.peerInstallationId).toBe(commandCenterId);

    await closeProductSessionConnection(connectionB);
  });

  it("admits Remote actor task.create, replays after revocation, and fails closed without a non-leaking outcome route", async () => {
    const commandCenterId = installation("cc-remote-create-report");
    const remoteId = installation("remote-create-report");
    const remoteHost = hostId("remote-create");
    const commandCenter = await openInstallation(commandCenterId);
    const remote = await openInstallation(remoteId);
    const bindingId = "binding-remote-create";
    const document = productPathDocument(remoteHost, bindingId);
    await configureDirectPair(
      commandCenter,
      remote,
      commandCenterId,
      remoteId,
      remoteHost,
      document,
    );
    const actor: ActorRef = {
      seatId: deriveActorSeatId(remoteId, bindingId),
      canvasName: "factory",
      nodeId: "remote-worker",
    };

    const created = await remote.runtime.runPromise(
      remote.workService.workTaskCreate(
        "factory",
        "shared-tasks",
        "create this stable Task at Command Center",
        { details: "create this stable Task at Command Center" },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          admissionOmitted: "approval",
          raisedBy: actor,
        },
      ),
    );
    expect(created).toMatchObject({
      ok: true,
      disposition: "queued",
      data: {
        state: "submitted",
        admission: "approval",
        raisedBy: actor,
      },
    });
    if (!created.ok) throw new Error("Remote Task create did not enqueue");
    const taskId = created.data.id;

    const request = await remote.runtime.runPromise(
      remote.api.prepareReport(commandCenterId),
    );
    expect(request.batch.records).toHaveLength(1);
    expect(request.batch.records[0]).toMatchObject({
      recordType: "command",
      operation: "task.create",
      id: {
        route: { eventHome: remoteId, entityHome: commandCenterId },
        seq: "1",
      },
      item: { itemId: taskId },
      body: {
        operation: "task.create",
        task: {
          id: taskId,
          admission: "approval",
          raisedBy: actor,
        },
      },
    });
    const command = request.batch.records[0];
    if (
      command?.recordType !== "command" ||
      command.body.operation !== "task.create"
    ) {
      throw new Error("expected the exact Remote task.create command");
    }
    const commandedTask = command.body.task;
    expect(command.item.itemId).toBe(commandedTask.id);
    expect(commandedTask).toEqual(created.data);

    const response = await commandCenter.runtime.runPromise(
      commandCenter.api.handle(
        request,
        readiness,
        { _tag: "enrolled-remote", installationId: remoteId },
      ),
    );
    if (response.op !== "report") {
      throw new Error("Remote Task create did not produce a report response");
    }
    expect(response.batch.acknowledge).toEqual([
      {
        eventHome: remoteId,
        entityHome: commandCenterId,
        through: "1",
      },
    ]);
    expect(
      response.batch.records.map((record) => [
        record.recordType,
        record.operation,
        record.id.seq,
      ]),
    ).toEqual([
      ["fact", "task.create", "1"],
      ["disposition", "task.create", "2"],
    ]);
    const returnedFact = response.batch.records[0];
    if (
      returnedFact?.recordType !== "fact" ||
      returnedFact.body.operation !== "task.create"
    ) {
      throw new Error("expected the exact task.create result fact");
    }
    expect(returnedFact.body.task).toEqual(commandedTask);
    expect(returnedFact.basis).toEqual({
      kind: "command",
      command: command.id,
      commandSha256: command.contentSha256,
    });
    expect(
      (
        await commandCenter.runtime.runPromise(
          commandCenter.work.readSnapshot("factory", "shared-tasks"),
        )
      ).tasks.items,
    ).toEqual([commandedTask]);

    const revoked: CanvasDoc = {
      nodes: document.nodes.filter((node) => node.id === "shared-tasks"),
      edges: [],
    };
    await commandCenter.runtime.runPromise(
      commandCenter.canvases.write("factory", revoked),
    );
    await archiveCurrentProjection(
      commandCenter,
      remote,
      commandCenterId,
      remoteId,
      remoteHost,
    );

    const integrated = await remote.runtime.runPromise(
      remote.api.acceptReportResponse(
        commandCenterId,
        request,
        response,
      ),
    );
    expect(integrated).toMatchObject({
      accepted: 2,
      rejected: 0,
      receivedThrough: [
        {
          eventHome: commandCenterId,
          entityHome: commandCenterId,
          through: "2",
        },
      ],
    });
    expect(
      (await remote.runtime.runPromise(remote.work.pendingCommands))[0],
    ).toMatchObject({
      command: { item: { itemId: taskId } },
      resolution: { status: "applied" },
    });

    const outcomeAckRequest = await remote.runtime.runPromise(
      remote.api.prepareReport(commandCenterId),
    );
    expect(outcomeAckRequest.batch.records).toEqual([]);
    expect(outcomeAckRequest.batch.acknowledge).toEqual([
      {
        eventHome: commandCenterId,
        entityHome: commandCenterId,
        through: "2",
      },
    ]);
    const outcomeAckResponse = await commandCenter.runtime.runPromise(
      commandCenter.api.handle(
        outcomeAckRequest,
        readiness,
        { _tag: "enrolled-remote", installationId: remoteId },
      ),
    );
    if (outcomeAckResponse.op !== "report") {
      throw new Error("outcome ACK did not produce a report response");
    }
    await remote.runtime.runPromise(
      remote.api.acceptReportResponse(
        commandCenterId,
        outcomeAckRequest,
        outcomeAckResponse,
      ),
    );

    const replayRequest = ReportRequest.make({
      ...request,
      batch: {
        ...request.batch,
        acknowledge: outcomeAckRequest.batch.acknowledge,
      },
    });
    const replayResponse = await commandCenter.runtime.runPromise(
      commandCenter.api.handle(
        replayRequest,
        readiness,
        { _tag: "enrolled-remote", installationId: remoteId },
      ),
    );
    if (replayResponse.op !== "report") {
      throw new Error("command replay did not produce a report response");
    }
    expect(replayResponse.batch.records).toEqual(response.batch.records);
    expect(replayResponse.batch.acknowledge).toEqual(
      response.batch.acknowledge,
    );
    const replayed = await remote.runtime.runPromise(
      remote.api.acceptReportResponse(
        commandCenterId,
        replayRequest,
        replayResponse,
      ),
    );
    expect(replayed).toMatchObject({
      accepted: 0,
      idempotent: 2,
      rejected: 0,
    });

    const unrelated = await commandCenter.runtime.runPromise(
      commandCenter.workService.workTaskCreate(
        "factory",
        "shared-tasks",
        "unrelated Command Center fact",
        { details: "unrelated Command Center fact" },
      ),
    );
    expect(unrelated).toMatchObject({ ok: true, disposition: "applied" });
    await commandCenter.runtime.runPromise(
      commandCenter.canvases.write("factory", document),
    );
    await archiveCurrentProjection(
      commandCenter,
      remote,
      commandCenterId,
      remoteId,
      remoteHost,
    );
    const blockedCreate = await remote.runtime.runPromise(
      remote.workService.workTaskCreate(
        "factory",
        "shared-tasks",
        "do not disclose the unrelated CC prefix",
        { details: "do not disclose the unrelated CC prefix" },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          admissionOmitted: "approval",
          raisedBy: actor,
        },
      ),
    );
    expect(blockedCreate).toMatchObject({ ok: true, disposition: "queued" });
    if (!blockedCreate.ok) throw new Error("second Remote Task did not enqueue");
    const blockedRequest = await remote.runtime.runPromise(
      remote.api.prepareReport(commandCenterId),
    );
    const blocked = await commandCenter.runtime.runPromise(
      commandCenter.api.handle(
        blockedRequest,
        readiness,
        { _tag: "enrolled-remote", installationId: remoteId },
      ).pipe(Effect.result),
    );
    expect(Result.isFailure(blocked)).toBe(true);
    if (Result.isFailure(blocked)) {
      expect(blocked.failure).toMatchObject({
        _tag: "WorkReplicationError",
        reason: "response-capacity",
        message: expect.stringContaining(
          "no contiguous non-leaking protocol-1 outcome route",
        ),
      });
    }
    expect(
      (
        await commandCenter.runtime.runPromise(
          commandCenter.work.readSnapshot("factory", "shared-tasks"),
        )
      ).tasks.items.some((task) => task.id === blockedCreate.data.id),
    ).toBe(false);
    expect(
      (await commandCenter.runtime.runPromise(commandCenter.station.statusFacts))
        .receivedThrough,
    ).toEqual(
      expect.arrayContaining([
        {
          eventHome: remoteId,
          entityHome: commandCenterId,
          through: "1",
        },
      ]),
    );
  });

  it("admits retained exact dependency intent through the production report path", async () => {
    const commandCenterId = installation("cc-retained-dependency-report");
    const remoteId = installation("remote-retained-dependency-report");
    const remoteHost = hostId("retained-dependency-remote");
    const commandCenter = await openInstallation(commandCenterId);
    const remote = await openInstallation(remoteId);
    const bindingId = "binding-retained-dependency";
    const document = remoteTaskDocument(remoteHost, bindingId);
    const retainedProjection = await configureDirectPair(
      commandCenter,
      remote,
      commandCenterId,
      remoteId,
      remoteHost,
      document,
    );
    const actor: ActorRef = {
      seatId: deriveActorSeatId(remoteId, bindingId),
      canvasName: "factory",
      nodeId: "remote-worker",
    };
    const createOptions = {
      admission: "auto" as const,
      admissionOmitted: "inherit" as const,
      raisedBy: actor,
    };
    const prerequisite = await remote.runtime.runPromise(
      remote.workService.workTaskCreate(
        "factory",
        "remote-tasks",
        "retained prerequisite",
        { details: "retained prerequisite" },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        createOptions,
      ),
    );
    expect(prerequisite).toMatchObject({ ok: true, disposition: "applied" });
    if (!prerequisite.ok) throw new Error("prerequisite create failed");
    const dependent = await remote.runtime.runPromise(
      remote.workService.workTaskCreate(
        "factory",
        "remote-tasks",
        "retained dependent",
        { details: "retained dependent" },
        undefined,
        undefined,
        [prerequisite.data.id],
        undefined,
        undefined,
        createOptions,
      ),
    );
    expect(dependent).toMatchObject({
      ok: true,
      disposition: "applied",
      data: { dependsOn: [prerequisite.data.id] },
    });
    if (!dependent.ok) throw new Error("dependent create failed");

    await commandCenter.runtime.runPromise(
      commandCenter.canvases.write("factory", { nodes: [], edges: [] }),
    );
    const currentProjection = await archiveCurrentProjection(
      commandCenter,
      undefined,
      commandCenterId,
      remoteId,
      remoteHost,
    );
    expect(currentProjection.generation).not.toBe(retainedProjection.generation);

    const request = await remote.runtime.runPromise(
      remote.api.prepareReport(commandCenterId),
    );
    expect(
      request.batch.records.map((record) => [
        record.recordType,
        record.operation,
        record.id.seq,
      ]),
    ).toEqual([
      ["fact", "task.create", "1"],
      ["fact", "task.create", "2"],
    ]);
    expect(
      request.batch.records.every(
        (record) =>
          record.recordType === "fact" &&
          record.basis.kind === "projected-intent" &&
          String(record.basis.generation) ===
            String(retainedProjection.generation) &&
          String(record.basis.contentSha256) ===
            String(retainedProjection.contentSha256),
      ),
    ).toBe(true);

    const response = await commandCenter.runtime.runPromise(
      commandCenter.api.handle(
        request,
        readiness,
        { _tag: "enrolled-remote", installationId: remoteId },
      ),
    );
    if (response.op !== "report") {
      throw new Error("retained dependency report did not produce a response");
    }
    expect(response.batch.records).toEqual([]);
    expect(response.batch.acknowledge).toEqual([
      { eventHome: remoteId, entityHome: remoteId, through: "2" },
    ]);
    const snapshot = await commandCenter.runtime.runPromise(
      commandCenter.work.readSnapshot("factory", "remote-tasks"),
    );
    expect(snapshot.tasks.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: prerequisite.data.id }),
        expect.objectContaining({
          id: dependent.data.id,
          dependsOn: [prerequisite.data.id],
        }),
      ]),
    );

    await remote.runtime.runPromise(
      remote.api.acceptReportResponse(commandCenterId, request, response),
    );
    expect(
      (await remote.runtime.runPromise(remote.station.statusFacts))
        .peerAcknowledgedThrough,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          peerInstallationId: commandCenterId,
          acknowledgement: {
            eventHome: remoteId,
            entityHome: remoteId,
            through: "2",
          },
        }),
      ]),
    );
  });


  it("fails closed for retained actorless host authority without a basis-bound witness", async () => {
    const commandCenterId = installation("cc-actorless-retained-report");
    const remoteId = installation("remote-actorless-retained-report");
    const remoteHost = hostId("actorless-retained-remote");
    const commandCenter = await openInstallation(commandCenterId);
    const remote = await openInstallation(remoteId);
    const document = remoteTaskDocument(
      remoteHost,
      "unused-actorless-binding",
      false,
    );
    const actorlessProjection = await configureDirectPair(
      commandCenter,
      remote,
      commandCenterId,
      remoteId,
      remoteHost,
      document,
    );
    expect(
      decodeStationPortfolioBody(actorlessProjection.body).actorSeats,
    ).toEqual([]);
    expect(
      await commandCenter.runtime.runPromise(
        commandCenter.fleetTargets.get(remoteHost),
      ),
    ).toMatchObject({
      hostId: remoteHost,
      stationInstallationId: remoteId,
    });
    const basis = await activeIntentBasis(remote, "projected-intent");
    const sink = { canvasName: "factory", nodeId: "remote-tasks" };
    const dependencyScope = await currentTaskTopologyCapability(
      remote,
      "projected-intent",
      sink,
    );
    const taskId = "actorless-retained-task";
    await remote.runtime.runPromise(
      remote.work.createTask({
        sink,
        basis,
        dependencyScope,
        task: {
          id: taskId,
          state: "submitted",
          history: [
            message(
              "actorless-retained-brief",
              "user",
              "must not invent historical host authority",
              taskId,
            ),
          ],
        },
        originAt: now,
        receivedAt: now,
      }),
    );
    const request = await remote.runtime.runPromise(
      remote.api.prepareReport(commandCenterId),
    );
    expect(request.batch.records).toHaveLength(1);
    expect(request.batch.records[0]).toMatchObject({
      recordType: "fact",
      operation: "task.create",
      id: {
        route: { eventHome: remoteId, entityHome: remoteId },
        seq: "1",
      },
      basis: {
        kind: "projected-intent",
        generation: String(actorlessProjection.generation),
        contentSha256: String(actorlessProjection.contentSha256),
      },
    });

    await commandCenter.runtime.runPromise(
      commandCenter.canvases.write(
        "factory",
        remoteTaskDocument(remoteHost, "current-actor-witness"),
      ),
    );
    const currentActorfulProjection = await archiveCurrentProjection(
      commandCenter,
      undefined,
      commandCenterId,
      remoteId,
      remoteHost,
    );
    expect(currentActorfulProjection.generation).not.toBe(
      actorlessProjection.generation,
    );
    expect(
      decodeStationPortfolioBody(currentActorfulProjection.body).actorSeats,
    ).toHaveLength(1);

    const before = await commandCenter.runtime.runPromise(
      commandCenter.station.statusFacts,
    );
    const refused = await commandCenter.runtime.runPromise(
      commandCenter.api.handle(
        request,
        readiness,
        { _tag: "enrolled-remote", installationId: remoteId },
      ).pipe(Effect.result),
    );
    expect(Result.isFailure(refused)).toBe(true);
    if (Result.isFailure(refused)) {
      expect(refused.failure).toMatchObject({
        _tag: "WorkReplicationError",
        reason: "causal-conflict",
        message: expect.stringContaining(
          "projected task queue has no basis-bound host-to-installation witness",
        ),
      });
    }
    expect(
      await commandCenter.runtime.runPromise(commandCenter.station.statusFacts),
    ).toEqual(before);
    expect(
      (
        await commandCenter.runtime.runPromise(
          commandCenter.work.readSnapshot("factory", "remote-tasks"),
        )
      ).tasks.items,
    ).toEqual([]);
  });


  it("rejects an overfull mandatory response, then converges through contiguous report pages", async () => {
    const commandCenterId = installation("cc-contiguous-report-pages");
    const remoteId = installation("remote-contiguous-report-pages");
    const remoteHost = hostId("contiguous-report-remote");
    const commandCenter = await openInstallation(commandCenterId);
    const remote = await openInstallation(remoteId);
    const bindingId = "binding-contiguous-report";
    const document = remoteTaskDocument(remoteHost, bindingId);
    await configureDirectPair(
      commandCenter,
      remote,
      commandCenterId,
      remoteId,
      remoteHost,
      document,
    );
    const remoteBasis = await activeIntentBasis(remote, "projected-intent");
    const sink = { canvasName: "factory", nodeId: "remote-tasks" };
    const dependencyScope = await currentTaskTopologyCapability(
      remote,
      "projected-intent",
      sink,
    );
    for (let index = 1; index <= 257; index += 1) {
      const taskId = `prefix-task-${index}`;
      await remote.runtime.runPromise(
        remote.work.createTask({
          sink,
          basis: remoteBasis,
          dependencyScope,
          task: {
            id: taskId,
            state: "submitted",
            history: [],
          },
          originAt: now,
          receivedAt: now,
        }),
      );
    }
    const commandedTaskId = "task-after-257-prefix-facts";
    await commandCenter.runtime.runPromise(
      commandCenter.work.enqueueRemoteCommand({
        targetInstallationId: remoteId,
        sink,
        item: {
          kind: "task",
          itemId: commandedTaskId,
          sink,
        },
        action: {
          operation: "task.create",
          task: {
            id: commandedTaskId,
            state: "submitted",
            history: [],
          },
        },
        originAt: now,
        receivedAt: now,
      }),
    );

    const overfullRequest = await commandCenter.runtime.runPromise(
      commandCenter.api.prepareReport(remoteId),
    );
    expect(overfullRequest.batch.records).toHaveLength(1);
    const overfull = await remote.runtime.runPromise(
      remote.api.handle(
        overfullRequest,
        readiness,
        { _tag: "command-center-route" },
      ).pipe(Effect.result),
    );
    expect(Result.isFailure(overfull)).toBe(true);
    if (Result.isFailure(overfull)) {
      expect(overfull.failure).toMatchObject({
        _tag: "WorkReplicationError",
        reason: "response-capacity",
      });
    }
    const afterRefusal = await remote.runtime.runPromise(
      remote.work.recordsAfter({
        route: { eventHome: remoteId, entityHome: remoteId },
        limit: 257,
      }),
    );
    expect(afterRefusal).toHaveLength(257);
    expect(afterRefusal.at(-1)?.id.seq).toBe("257");
    expect(
      (
        await remote.runtime.runPromise(
          remote.work.readSnapshot("factory", "remote-tasks"),
        )
      ).tasks.items.some((task) => task.id === commandedTaskId),
    ).toBe(false);
    expect(
      (await remote.runtime.runPromise(remote.station.statusFacts))
        .receivedThrough,
    ).not.toEqual(
      expect.arrayContaining([
        {
          eventHome: commandCenterId,
          entityHome: remoteId,
          through: "1",
        },
      ]),
    );

    const prefixRequest = await remote.runtime.runPromise(
      remote.api.prepareReport(commandCenterId),
    );
    expect(prefixRequest.batch.records).toHaveLength(256);
    expect(prefixRequest.batch.records[0]?.id.seq).toBe("1");
    expect(prefixRequest.batch.records.at(-1)?.id.seq).toBe("256");
    expect(prefixRequest.batch.hasMore).toBe(true);
    const prefixResponse = await commandCenter.runtime.runPromise(
      commandCenter.api.handle(
        prefixRequest,
        readiness,
        { _tag: "enrolled-remote", installationId: remoteId },
      ),
    );
    if (prefixResponse.op !== "report") {
      throw new Error("prefix report did not produce a response");
    }
    expect(prefixResponse.batch.acknowledge).toEqual([
      { eventHome: remoteId, entityHome: remoteId, through: "256" },
    ]);
    await remote.runtime.runPromise(
      remote.api.acceptReportResponse(
        commandCenterId,
        prefixRequest,
        prefixResponse,
      ),
    );

    const retryRequest = await commandCenter.runtime.runPromise(
      commandCenter.api.prepareReport(remoteId),
    );
    expect(retryRequest.batch.records).toHaveLength(1);
    expect(retryRequest.batch.records[0]?.id).toEqual(
      overfullRequest.batch.records[0]?.id,
    );
    expect(retryRequest.batch.acknowledge).toEqual([
      { eventHome: remoteId, entityHome: remoteId, through: "256" },
    ]);
    const retryResponse = await remote.runtime.runPromise(
      remote.api.handle(
        retryRequest,
        readiness,
        { _tag: "command-center-route" },
      ),
    );
    if (retryResponse.op !== "report") {
      throw new Error("retry report did not produce a response");
    }
    expect(
      retryResponse.batch.records.map((record) => record.id.seq),
    ).toEqual(["257", "258", "259"]);
    expect(
      retryResponse.batch.records.map((record) => record.recordType),
    ).toEqual(["fact", "fact", "disposition"]);
    expect(retryResponse.batch.acknowledge).toEqual([
      {
        eventHome: commandCenterId,
        entityHome: remoteId,
        through: "1",
      },
    ]);
    expect(retryResponse.batch.hasMore).toBe(false);

    await commandCenter.runtime.runPromise(
      commandCenter.api.acceptReportResponse(
        remoteId,
        retryRequest,
        retryResponse,
      ),
    );
    expect(
      (await commandCenter.runtime.runPromise(commandCenter.work.pendingCommands))[0],
    ).toMatchObject({
      command: { item: { itemId: commandedTaskId } },
      resolution: { status: "applied" },
    });
    expect(
      (await commandCenter.runtime.runPromise(commandCenter.station.statusFacts))
        .receivedThrough,
    ).toEqual(
      expect.arrayContaining([
        {
          eventHome: remoteId,
          entityHome: remoteId,
          through: "259",
        },
      ]),
    );

    const finalAckRequest = await commandCenter.runtime.runPromise(
      commandCenter.api.prepareReport(remoteId),
    );
    expect(finalAckRequest.batch.records).toEqual([]);
    expect(finalAckRequest.batch.acknowledge).toEqual([
      { eventHome: remoteId, entityHome: remoteId, through: "259" },
    ]);
    const finalAckResponse = await remote.runtime.runPromise(
      remote.api.handle(
        finalAckRequest,
        readiness,
        { _tag: "command-center-route" },
      ),
    );
    if (finalAckResponse.op !== "report") {
      throw new Error("final ACK report did not produce a response");
    }
    await commandCenter.runtime.runPromise(
      commandCenter.api.acceptReportResponse(
        remoteId,
        finalAckRequest,
        finalAckResponse,
      ),
    );
    expect(
      (await remote.runtime.runPromise(remote.station.statusFacts))
        .peerAcknowledgedThrough,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          peerInstallationId: commandCenterId,
          acknowledgement: {
            eventHome: remoteId,
            entityHome: remoteId,
            through: "259",
          },
        }),
      ]),
    );
  });

  it("imports only the exact cross-canvas overseer artifact outcome after grant revoke", async () => {
    const commandCenterId = installation("cc-overseer-artifact");
    const remoteId = installation("remote-overseer-artifact");
    const remoteHost = hostId("artifact-remote");
    const commandCenter = await openInstallation(commandCenterId);
    const remote = await openInstallation(remoteId);
    const bindingId = "binding-artifact-overseer";
    const publisher: ActorRef = {
      seatId: deriveActorSeatId(remoteId, bindingId),
      canvasName: "publisher-home",
      nodeId: "remote-overseer",
    };
    const artifactSink = {
      canvasName: "factory",
      nodeId: "artifacts",
    };
    const destinationDocument: CanvasDoc = {
      nodes: [
        {
          id: artifactSink.nodeId,
          type: "text",
          x: 0,
          y: 0,
          width: 240,
          height: 100,
          text: "Cross-canvas artifacts",
          ether: {
            entity: { kind: "artifacts" },
            host: "local",
          },
        },
      ],
      edges: [],
    };
    const publisherDocument: CanvasDoc = {
      nodes: [
        {
          id: publisher.nodeId,
          type: "text",
          x: 0,
          y: 0,
          width: 240,
          height: 100,
          text: "Remote overseer",
          ether: {
            entity: {
              kind: "agent",
              name: `${remoteHost}:overseer`,
            },
            host: remoteHost,
            terminal: {
              bindingId,
              harness: "codex",
              launch: { kind: "harness", argv: ["codex"] },
            },
          },
        },
      ],
      edges: [],
    };

    await configureDirectPair(
      commandCenter,
      remote,
      commandCenterId,
      remoteId,
      remoteHost,
      destinationDocument,
    );
    const publisherWrite = await commandCenter.runtime.runPromise(
      commandCenter.canvases.write(
        publisher.canvasName,
        publisherDocument,
      ),
    );
    const grant = await commandCenter.runtime.runPromise(
      commandCenter.canvases.canvasOverseerSet({
        canvasName: publisher.canvasName,
        nodeId: publisher.nodeId,
        overseer: true,
        expectedRevision: publisherWrite.revision,
      }),
    );
    await archiveCurrentProjection(
      commandCenter,
      remote,
      commandCenterId,
      remoteId,
      remoteHost,
    );
    const installedProjection = await remote.runtime.runPromise(
      remote.station.projection,
    );
    if (installedProjection === undefined) {
      throw new Error("expected overseer projection on Remote");
    }
    expect(
      decodeStationPortfolioBody(installedProjection.body).actorSeats.find(
        (seat) => seat.seatId === publisher.seatId,
      ),
    ).toMatchObject({
      overseer: true,
      primaryRef: {
        canvasName: publisher.canvasName,
        nodeId: publisher.nodeId,
      },
    });

    const artifact = {
      artifactId: "cross-canvas-overseer-artifact",
      name: "proof.txt",
      parts: [{ kind: "text" as const, text: "publisher stays original" }],
    };
    const command = await commandCenter.runtime.runPromise(
      commandCenter.work.enqueueRemoteCommand({
        targetInstallationId: remoteId,
        sink: artifactSink,
        item: {
          kind: "artifact",
          itemId: artifact.artifactId,
          sink: artifactSink,
        },
        action: {
          operation: "artifact.publish",
          artifact,
          publishedBy: publisher,
        },
        originAt: now,
        receivedAt: now,
      }),
    );
    const request = await commandCenter.runtime.runPromise(
      commandCenter.api.prepareReport(remoteId),
    );
    expect(request.batch.records).toEqual([
      expect.objectContaining({
        id: command.id,
        recordType: "command",
        item: {
          kind: "artifact",
          itemId: artifact.artifactId,
          sink: artifactSink,
        },
        body: {
          operation: "artifact.publish",
          artifact,
          publishedBy: publisher,
        },
      }),
    ]);

    const response = await remote.runtime.runPromise(
      remote.api.handle(
        request,
        readiness,
        { _tag: "command-center-route" },
      ),
    );
    if (response.op !== "report") {
      throw new Error("artifact command did not produce a report response");
    }
    const fact = response.batch.records.find(
      (record) => record.recordType === "fact",
    );
    const disposition = response.batch.records.find(
      (record) => record.recordType === "disposition",
    );
    if (
      fact?.recordType !== "fact" ||
      fact.body.operation !== "artifact.publish" ||
      disposition?.recordType !== "disposition" ||
      disposition.body.status !== "applied"
    ) {
      throw new Error(
        `artifact command did not produce an applied outcome: ${JSON.stringify(response.batch.records)}`,
      );
    }
    expect(fact.body.publishedBy).toEqual(publisher);
    expect(fact.id.route).toEqual({
      eventHome: remoteId,
      entityHome: remoteId,
    });
    expect(
      (
        await remote.runtime.runPromise(
          remote.work.readSnapshot(
            artifactSink.canvasName,
            artifactSink.nodeId,
          ),
        )
      ).artifacts.items,
    ).toEqual([
      expect.objectContaining({ artifactId: artifact.artifactId }),
    ]);

    const grantedRevision = grant.affected.find(
      (affected) => affected.name === publisher.canvasName,
    )?.revision;
    if (grantedRevision === undefined) {
      throw new Error("overseer grant did not report publisher canvas revision");
    }
    await commandCenter.runtime.runPromise(
      commandCenter.canvases.canvasOverseerSet({
        canvasName: publisher.canvasName,
        nodeId: publisher.nodeId,
        overseer: false,
        expectedRevision: grantedRevision,
      }),
    );
    const statusBeforeForgery = await commandCenter.runtime.runPromise(
      commandCenter.station.statusFacts,
    );
    const forgedFact = resealWorkRecord({
      ...fact,
      body: {
        ...fact.body,
        publishedBy: {
          ...fact.body.publishedBy,
          nodeId: "forged-overseer",
        },
      },
    });
    const forgedDisposition = resealWorkRecord({
      ...disposition,
      body: {
        ...disposition.body,
        factSha256: forgedFact.contentSha256,
      },
    });
    const forgedResponse = ReportResponse.make({
      ...response,
      batch: {
        ...response.batch,
        records: response.batch.records.map((record) =>
          record.recordType === "fact"
            ? forgedFact
            : record.recordType === "disposition"
              ? forgedDisposition
              : record
        ),
      },
    });
    const denied = await commandCenter.runtime.runPromise(
      commandCenter.api.acceptReportResponse(
        remoteId,
        request,
        forgedResponse,
      ).pipe(Effect.result),
    );
    expect(Result.isFailure(denied)).toBe(true);
    expect(
      await commandCenter.runtime.runPromise(
        commandCenter.station.statusFacts,
      ),
    ).toEqual(statusBeforeForgery);
    expect(
      await commandCenter.runtime.runPromise(
        commandCenter.work.recordsAfter({
          route: { eventHome: remoteId, entityHome: remoteId },
        }),
      ),
    ).toEqual([]);
    expect(
      (await commandCenter.runtime.runPromise(commandCenter.work.pendingCommands))[0],
    ).toMatchObject({ command: { id: command.id }, resolution: undefined });

    await commandCenter.runtime.runPromise(
      commandCenter.api.acceptReportResponse(remoteId, request, response),
    );
    expect(
      (await commandCenter.runtime.runPromise(commandCenter.work.pendingCommands))[0],
    ).toMatchObject({
      command: { id: command.id },
      resolution: { status: "applied" },
    });
    const imported = await commandCenter.runtime.runPromise(
      commandCenter.work.recordsAfter({
        route: { eventHome: remoteId, entityHome: remoteId },
      }),
    );
    expect(imported[0]).toMatchObject({
      recordType: "fact",
      body: {
        operation: "artifact.publish",
        artifact,
        publishedBy: publisher,
      },
    });
  });

  it("routes overseer claims to the assignee home and Remote-homed requests without ordinary edges", async () => {
    const commandCenterId = installation("cc-overseer-work-residency");
    const remoteId = installation("remote-overseer-work-residency");
    const remoteHost = hostId("residency-remote");
    const commandCenter = await openInstallation(commandCenterId);
    const remote = await openInstallation(remoteId);
    const overseerBinding = "binding-remote-overseer-residency";
    const assigneeBinding = "binding-cc-assignee-residency";
    const document: CanvasDoc = {
      nodes: [
        {
          id: "shared-tasks",
          type: "text",
          x: 0,
          y: 0,
          width: 240,
          height: 100,
          text: "Shared tasks",
          ether: { entity: { kind: "task" }, host: "local" },
        },
        {
          id: "inbox",
          type: "text",
          x: 0,
          y: 160,
          width: 240,
          height: 100,
          text: "Requests",
          ether: { entity: { kind: "requests" }, host: "local" },
        },
        {
          id: "cc-assignee",
          type: "text",
          x: 320,
          y: 0,
          width: 240,
          height: 100,
          text: "Command Center assignee",
          ether: {
            entity: { kind: "agent", name: "local:assignee" },
            host: "local",
            terminal: {
              bindingId: assigneeBinding,
              harness: "codex",
              launch: { kind: "harness", argv: ["codex"] },
            },
          },
        },
        {
          id: "remote-overseer",
          type: "text",
          x: 640,
          y: 0,
          width: 240,
          height: 100,
          text: "Remote overseer",
          ether: {
            entity: { kind: "agent", name: `${remoteHost}:overseer` },
            host: remoteHost,
            terminal: {
              bindingId: overseerBinding,
              harness: "codex",
              launch: { kind: "harness", argv: ["codex"] },
            },
          },
        },
      ],
      edges: [],
    };
    await configureDirectPair(
      commandCenter,
      remote,
      commandCenterId,
      remoteId,
      remoteHost,
      document,
    );
    const grantWrite = await commandCenter.runtime.runPromise(
      commandCenter.canvases.read("factory"),
    );
    await commandCenter.runtime.runPromise(
      commandCenter.canvases.canvasOverseerSet({
        canvasName: "factory",
        nodeId: "remote-overseer",
        overseer: true,
        expectedRevision: grantWrite.revision,
      }),
    );
    await archiveCurrentProjection(
      commandCenter,
      remote,
      commandCenterId,
      remoteId,
      remoteHost,
    );
    const connection = await openProductSessionConnection(
      commandCenter,
      remote,
      commandCenterId,
      remoteId,
      remoteHost,
    );
    const canvas = await commandCenter.runtime.runPromise(
      commandCenter.canvases.read("factory"),
    );
    const overseer = canvas.actorRefs.find((actor) => actor.nodeId === "remote-overseer");
    const assignee = canvas.actorRefs.find((actor) => actor.nodeId === "cc-assignee");
    if (overseer === undefined || assignee === undefined) {
      throw new Error("expected overseer and assignee seats");
    }
    const created = await commandCenter.runtime.runPromise(
      executeOverseerWork(
        { canvasName: "factory", nodeId: overseer.nodeId },
        {
          operation: "tasks.create",
          args: {
            target: "shared-tasks",
            brief: "assign the CC seat",
            metadata: { details: "assign the CC seat" },
          },
        },
        overseerWorkAdmin(overseer),
      ),
    );
    const taskId = (created as { readonly id: string }).id;
    const claimed = await commandCenter.runtime.runPromise(
      executeOverseerWork(
        { canvasName: "factory", nodeId: overseer.nodeId },
        {
          operation: "tasks.claim",
          args: { target: "shared-tasks", task: taskId, actor: "cc-assignee" },
        },
        overseerWorkAdmin(overseer),
      ),
    );
    expect(claimed).toMatchObject({ disposition: "applied" });
    expect(
      (
        await commandCenter.runtime.runPromise(
          commandCenter.work.readSnapshot("factory", "shared-tasks"),
        )
      ).tasks.items.find((task) => task.id === taskId),
    ).toMatchObject({
      state: "working",
      claimedBy: assignee.seatId,
    });
    expect(
      await commandCenter.runtime.runPromise(
        commandCenter.work.itemHome("task", "factory", "shared-tasks", taskId),
      ),
    ).toBe(commandCenterId);

    await commandCenter.runtime.runPromise(
      commandCenter.canvases.canvasOverseerSet({
        canvasName: "factory",
        nodeId: "cc-assignee",
        overseer: true,
        expectedRevision: (
          await commandCenter.runtime.runPromise(commandCenter.canvases.read("factory"))
        ).revision,
      }),
    );
    await archiveCurrentProjection(
      commandCenter,
      remote,
      commandCenterId,
      remoteId,
      remoteHost,
    );
    const remoteAssigned = await commandCenter.runtime.runPromise(
      executeOverseerWork(
        { canvasName: "factory", nodeId: assignee.nodeId },
        {
          operation: "tasks.create",
          args: {
            target: "shared-tasks",
            brief: "assign the Remote seat",
            metadata: { details: "assign the Remote seat" },
          },
        },
        overseerWorkAdmin(assignee),
      ),
    );
    const remoteTaskId = (remoteAssigned as { readonly id: string }).id;
    const remoteClaim = await commandCenter.runtime.runPromise(
      executeOverseerWork(
        { canvasName: "factory", nodeId: assignee.nodeId },
        {
          operation: "tasks.claim",
          args: { target: "shared-tasks", task: remoteTaskId, actor: "remote-overseer" },
        },
        overseerWorkAdmin(assignee),
      ),
    );
    expect(remoteClaim).toMatchObject({ disposition: "queued" });
    const claimSync = await commandCenter.runtime.runPromise(
      commandCenter.propagation.synchronize(
        {
          stationInstallationId: remoteId,
          hostId: stationHostId(remoteHost),
        },
        connection.commandCenterSession,
      ),
    );
    expect(claimSync.report).toMatchObject({ inboundRejected: 0 });
    expect(
      (
        await remote.runtime.runPromise(
          remote.work.readSnapshot("factory", "shared-tasks"),
        )
      ).tasks.items.find((task) => task.id === remoteTaskId),
    ).toMatchObject({
      state: "working",
      claimedBy: overseer.seatId,
    });
    expect(
      await remote.runtime.runPromise(
        remote.work.itemHome("task", "factory", "shared-tasks", remoteTaskId),
      ),
    ).toBe(remoteId);

    const raised = await commandCenter.runtime.runPromise(
      executeOverseerWork(
        { canvasName: "factory", nodeId: overseer.nodeId },
        {
          operation: "request.create",
          args: {
            target: "inbox",
            brief: "need a ruling",
            reason: "remote overseer raised this",
          },
        },
        overseerWorkAdmin(overseer),
      ),
    );
    expect(raised).toMatchObject({ disposition: "queued" });
    const requestId = (raised as { readonly id: string }).id;
    const requestSync = await commandCenter.runtime.runPromise(
      commandCenter.propagation.synchronize(
        {
          stationInstallationId: remoteId,
          hostId: stationHostId(remoteHost),
        },
        connection.commandCenterSession,
      ),
    );
    expect(requestSync.report).toMatchObject({
      inboundRejected: 0,
    });
    expect(
      await remote.runtime.runPromise(
        remote.work.itemHome("request", "factory", "inbox", requestId),
      ),
    ).toBe(remoteId);
    expect(
      await commandCenter.runtime.runPromise(
        commandCenter.work.itemHome("request", "factory", "inbox", requestId),
      ),
    ).toBe(remoteId);

    await commandCenter.runtime.runPromise(
      commandCenter.canvases.canvasOverseerSet({
        canvasName: "factory",
        nodeId: "remote-overseer",
        overseer: false,
        expectedRevision: (
          await commandCenter.runtime.runPromise(commandCenter.canvases.read("factory"))
        ).revision,
      }),
    );
    await expect(
      commandCenter.runtime.runPromise(
        executeOverseerWork(
          { canvasName: "factory", nodeId: overseer.nodeId },
          {
            operation: "request.create",
            args: {
              target: "inbox",
              brief: "revoked",
              reason: "must fail after revoke",
            },
          },
          overseerWorkAdmin(overseer),
        ),
      ),
    ).rejects.toMatchObject({ type: "AuthError" });
    await closeProductSessionConnection(connection);
  });

});
