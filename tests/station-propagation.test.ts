import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Context,
  Effect,
  Either,
  Layer,
  ManagedRuntime,
  Schema,
} from "effect";
import { afterEach, describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import {
  ConfigureRequest,
  InstallationId,
  LogicalSequence,
  PairRequest,
  ReportRequest,
  STATION_API_PROTOCOL,
  StationEvent,
  StationHostId,
  StationSha256,
  StatusRequest,
  type InstallationId as InstallationIdValue,
  type StationApiRequest,
  type StationApiResponse,
} from "../src/shared/station-api";
import {
  workTaskClaim,
  workTaskCreate,
  type WorkIds,
} from "../src/shared/work";
import {
  CanvasError,
  CanvasesService,
} from "../src/main/vellum/canvases";
import { makeStateEngineLive } from "../src/main/vellum/state/engine";
import { SshEndpoint } from "../src/main/vellum/ssh/domain";
import {
  StationApiLive,
  StationApiService,
} from "../src/main/vellum/station/api";
import {
  StationPropagation,
  StationPropagationLive,
} from "../src/main/vellum/station/propagation";
import {
  StationRemoteApiClient,
  StationRemoteExecutionError,
} from "../src/main/vellum/station/remote-client";
import {
  StationRepository,
  makeStationRepositoryLive,
} from "../src/main/vellum/station/repository";
import {
  SettingsLive,
  SettingsService,
} from "../src/main/vellum/settings/service";
import {
  WorkRepository,
  WorkRepositoryLive,
  stationEventFromWorkEvent,
} from "../src/main/vellum/work/repository";

const decodeInstallationId = Schema.decodeUnknownSync(InstallationId);
const decodeHostId = Schema.decodeUnknownSync(StationHostId);
const decodeEndpoint = Schema.decodeUnknownSync(SshEndpoint);
const decodeSequence = Schema.decodeUnknownSync(LogicalSequence);
const decodeSha256 = Schema.decodeUnknownSync(StationSha256);

const COMMAND_CENTER = decodeInstallationId("command-center");
const NOW = "2026-07-27T12:00:00.000Z";
const READINESS = {
  database: true,
  workControl: true,
  simulation: true,
} as const;

const roots: string[] = [];
const runtimes: Array<{ readonly dispose: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true })
    ),
  );
});

const testRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "vellum-propagation-"));
  roots.push(root);
  return root;
};

const repositoriesAt = (
  databasePath: string,
  installationId: InstallationIdValue,
) =>
  Layer.provideMerge(
    Layer.mergeAll(
      makeStationRepositoryLive({
        makeInstallationId: () => installationId,
        now: () => NOW,
      }),
      WorkRepositoryLive,
      SettingsLive,
    ),
    makeStateEngineLive(databasePath),
  );

const makeStationRuntime = (
  databasePath: string,
  installationId: InstallationIdValue,
) =>
  ManagedRuntime.make(
    Layer.provideMerge(
      StationApiLive,
      repositoriesAt(databasePath, installationId),
    ),
  );

type StationRuntime = ReturnType<typeof makeStationRuntime>;

const makeCanvases = (
  documents: ReadonlyMap<string, CanvasDoc>,
  generation = "1",
) =>
  CanvasesService.of({
    doctor: Effect.succeed({
      id: "canvases",
      label: "Canvases",
      status: "ok",
      detail: "test authority",
    }),
    list: Effect.succeed([]),
    read: () => Effect.fail(new CanvasError({ message: "unused" })),
    write: () => Effect.fail(new CanvasError({ message: "unused" })),
    mutate: () => Effect.fail(new CanvasError({ message: "unused" })),
    create: () => Effect.fail(new CanvasError({ message: "unused" })),
    remove: () => Effect.fail(new CanvasError({ message: "unused" })),
    ensureSeed: Effect.void,
    writeSidecar: () =>
      Effect.fail(new CanvasError({ message: "unused" })),
    start: () => undefined,
    subscribeChanges: () => () => undefined,
    liveDocuments: () =>
      Effect.succeed(
        [...documents].map(([canvasName, doc]) => ({ canvasName, doc })),
      ),
    liveAuthorityGeneration: () => Effect.succeed(generation),
    authoritySnapshot: () =>
      Effect.succeed({ generation, documents }),
  });

type RemoteRoute = {
  readonly runtime: StationRuntime;
  readonly requests: ReportRequest[];
  readonly responses: Extract<StationApiResponse, { readonly op: "report" }>[];
  loseNextReport: boolean;
};

type ResponseFor<R extends StationApiRequest> = Extract<
  StationApiResponse,
  { readonly op: R["op"] }
>;

const invokeStation = <R extends StationApiRequest>(
  runtime: StationRuntime,
  request: R,
): Effect.Effect<ResponseFor<R>> =>
  Effect.promise(() =>
    runtime.runPromise(
      Effect.flatMap(
        StationApiService,
        (api) => api.handle(request, READINESS),
      ),
    )
  ).pipe(
    Effect.map((response) => {
      if (response.op !== request.op) {
        throw new Error(
          `Station API returned ${response.op} for ${request.op}`,
        );
      }
      return response as ResponseFor<R>;
    }),
  );

const makeRemoteClient = (
  routes: ReadonlyMap<string, RemoteRoute>,
) => {
  const route = (endpoint: SshEndpoint): RemoteRoute => {
    const found = routes.get(endpoint);
    if (found === undefined) {
      throw new Error(`unknown in-memory Station endpoint ${endpoint}`);
    }
    return found;
  };

  return StationRemoteApiClient.of({
    status: (endpoint) =>
      invokeStation(
        route(endpoint).runtime,
        StatusRequest.make({
          protocol: STATION_API_PROTOCOL,
          op: "status",
        }),
      ),
    pair: (endpoint, request) =>
      invokeStation(route(endpoint).runtime, request),
    configure: (endpoint, request) =>
      invokeStation(route(endpoint).runtime, request),
    project: (endpoint, request) =>
      invokeStation(route(endpoint).runtime, request),
    report: (endpoint, request) => {
      const target = route(endpoint);
      target.requests.push(request);
      return invokeStation(target.runtime, request).pipe(
        Effect.flatMap((response) => {
          target.responses.push(response);
          if (!target.loseNextReport) return Effect.succeed(response);
          target.loseNextReport = false;
          return Effect.fail(
            StationRemoteExecutionError.make({
              endpoint,
              operation: "report",
              exitCode: 255,
              message: "simulated response loss after durable Remote apply",
            }),
          );
        }),
      );
    },
  });
};

const makeCommandCenterRuntime = (
  databasePath: string,
  canvases: Context.Tag.Service<typeof CanvasesService>,
  remote: Context.Tag.Service<typeof StationRemoteApiClient>,
) => {
  const dependencies = Layer.mergeAll(
    repositoriesAt(databasePath, COMMAND_CENTER),
    Layer.succeed(CanvasesService, canvases),
    Layer.succeed(StationRemoteApiClient, remote),
  );
  return ManagedRuntime.make(
    Layer.provideMerge(
      Layer.merge(StationApiLive, StationPropagationLive),
      dependencies,
    ),
  );
};

type CommandCenterRuntime = ReturnType<typeof makeCommandCenterRuntime>;

const taskSink = (id: string, host: string): CanvasDoc["nodes"][number] => ({
  id,
  type: "text",
  x: 0,
  y: 0,
  width: 240,
  height: 100,
  text: "station task sink",
  ether: {
    entity: { kind: "task" },
    host,
  },
});

const taskCanvas = (
  nodes: ReadonlyArray<{ readonly id: string; readonly host: string }>,
): CanvasDoc => ({
  nodes: nodes.map(({ id, host }) => taskSink(id, host)),
  edges: [],
});

const ids = (key: string): WorkIds => ({
  id: () => `task-${key}`,
  messageId: () => `message-${key}`,
});

const createCommand = (
  repository: typeof WorkRepository.Service,
  input: {
    readonly doc: CanvasDoc;
    readonly nodeId: string;
    readonly route: string;
    readonly key: string;
  },
) =>
  repository.mutate({
    canvasName: "factory",
    nodeId: input.nodeId,
    entityHome: input.route,
    eventHome: COMMAND_CENTER,
    materialization: "on-disposition",
    operation: "task.create",
    authoredDoc: input.doc,
    transform: (projected) => {
      const result = workTaskCreate(
        projected,
        "factory",
        input.nodeId,
        `command ${input.key}`,
        undefined,
        ids(input.key),
      );
      return { doc: result.doc, value: result.task };
    },
    originAt: NOW,
    receivedAt: NOW,
  });

const claimTask = (
  repository: typeof WorkRepository.Service,
  input: {
    readonly doc: CanvasDoc;
    readonly nodeId: string;
    readonly route: string;
    readonly eventHome: InstallationIdValue;
    readonly taskId: string;
    readonly actor: string;
  },
) =>
  repository.mutate({
    canvasName: "factory",
    nodeId: input.nodeId,
    entityHome: input.route,
    eventHome: input.eventHome,
    materialization: "immediate",
    operation: "task.claim",
    authoredDoc: input.doc,
    transform: (projected) => {
      const result = workTaskClaim(
        projected,
        "factory",
        input.nodeId,
        input.taskId,
        input.actor,
        ids(`${input.taskId}-claim`),
      );
      return { doc: result.doc, value: result.task };
    },
    originAt: NOW,
    receivedAt: NOW,
  });

const configureRemote = async (
  runtime: StationRuntime,
  installationId: InstallationIdValue,
  hostId: string,
): Promise<void> => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const api = yield* StationApiService;
      yield* api.handle(
        PairRequest.make({
          protocol: STATION_API_PROTOCOL,
          op: "pair",
          commandCenterInstallationId: COMMAND_CENTER,
          stationInstallationId: installationId,
          stationLabel: hostId,
          appVersion: "0.1.0",
        }),
        READINESS,
      );
      yield* api.handle(
        ConfigureRequest.make({
          protocol: STATION_API_PROTOCOL,
          op: "configure",
          installationId,
          configuration: {
            role: "remote",
            hostId: decodeHostId(hostId),
            agentHostId: decodeHostId(hostId),
            commandCenterInstallationId: COMMAND_CENTER,
            supervisedPreferred: true,
          },
          host: {
            id: hostId,
            label: hostId,
            kind: "remote",
            endpoint: hostId,
            capabilities: ["terminal", "browser", "hermes"],
          },
        }),
        READINESS,
      );
    }),
  );
};

const selectCommandCenter = async (
  runtime: CommandCenterRuntime,
): Promise<void> => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const settings = yield* SettingsService;
      yield* settings.setStationTopology({
        role: "command-center",
        hostId: "command",
        supervisedPreferred: true,
      });
    }),
  );
};

const target = (
  endpoint: SshEndpoint,
  stationInstallationId: InstallationIdValue,
  hostId: string,
) => ({
  endpoint,
  stationInstallationId,
  hostId: decodeHostId(hostId),
});

const makeRemote = async (
  root: string,
  key: string,
  hostId: string,
) => {
  const installationId = decodeInstallationId(`station-${key}`);
  const endpoint = decodeEndpoint(`${key}.test`);
  const runtime = makeStationRuntime(
    join(root, `${key}.db`),
    installationId,
  );
  runtimes.push(runtime);
  await configureRemote(runtime, installationId, hostId);
  const route: RemoteRoute = {
    runtime,
    requests: [],
    responses: [],
    loseNextReport: false,
  };
  return { installationId, endpoint, runtime, route };
};

describe("StationPropagation canonical work replication", () => {
  it("installs the projection, applies a command, and returns Remote work to Command Center", async () => {
    const root = await testRoot();
    const host = "studio";
    const nodeId = "studio-tasks";
    const doc = taskCanvas([{ id: nodeId, host }]);
    const remote = await makeRemote(root, "studio", host);
    const remoteClient = makeRemoteClient(
      new Map([[remote.endpoint, remote.route]]),
    );
    const commandCenter = makeCommandCenterRuntime(
      join(root, "command-center.db"),
      makeCanvases(new Map([["factory", doc]])),
      remoteClient,
    );
    runtimes.push(commandCenter);
    await selectCommandCenter(commandCenter);

    const ccWork = await commandCenter.runPromise(WorkRepository);
    const remoteWork = await remote.runtime.runPromise(WorkRepository);
    const created = await commandCenter.runPromise(
      createCommand(ccWork, {
        doc,
        nodeId,
        route: host,
        key: "studio",
      }),
    );
    expect(
      (await commandCenter.runPromise(
        ccWork.readSnapshot("factory", nodeId),
      )).tasks.items,
    ).toEqual([]);

    const propagation = await commandCenter.runPromise(StationPropagation);
    const receipt = await commandCenter.runPromise(
      propagation.synchronize(
        target(remote.endpoint, remote.installationId, host),
      ),
    );

    expect(receipt).toMatchObject({
      stationInstallationId: remote.installationId,
      projection: { decision: "install" },
      report: {
        rounds: 1,
        outboundSent: 1,
        inboundReceived: 1,
        inboundAccepted: 1,
        inboundIdempotent: 0,
      },
    });
    expect(
      (await remote.runtime.runPromise(
        remoteWork.readSnapshot("factory", nodeId),
      )).tasks.items[0]?.id,
    ).toBe(created.value.id);
    expect(
      (await commandCenter.runPromise(
        ccWork.readSnapshot("factory", nodeId),
      )).tasks.items[0]?.id,
    ).toBe(created.value.id);

    await remote.runtime.runPromise(
      claimTask(remoteWork, {
        doc,
        nodeId,
        route: host,
        eventHome: remote.installationId,
        taskId: created.value.id,
        actor: "studio:worker",
      }),
    );
    const resultReceipt = await commandCenter.runPromise(
      propagation.synchronize(
        target(remote.endpoint, remote.installationId, host),
      ),
    );

    expect(resultReceipt).toMatchObject({
      projection: { decision: "unchanged" },
      report: {
        rounds: 1,
        outboundSent: 0,
        inboundReceived: 1,
        inboundAccepted: 1,
      },
    });
    expect(
      (await commandCenter.runPromise(
        ccWork.readSnapshot("factory", nodeId),
      )).tasks.items[0],
    ).toMatchObject({
      id: created.value.id,
      state: "working",
      metadata: { claimedBy: "studio:worker" },
    });
  });

  it("recovers when the report response is lost after Remote commit", async () => {
    const root = await testRoot();
    const host = "studio";
    const nodeId = "studio-tasks";
    const doc = taskCanvas([{ id: nodeId, host }]);
    const remote = await makeRemote(root, "lost-response", host);
    const remoteClient = makeRemoteClient(
      new Map([[remote.endpoint, remote.route]]),
    );
    const commandCenter = makeCommandCenterRuntime(
      join(root, "command-center.db"),
      makeCanvases(new Map([["factory", doc]])),
      remoteClient,
    );
    runtimes.push(commandCenter);
    await selectCommandCenter(commandCenter);

    const ccWork = await commandCenter.runPromise(WorkRepository);
    const remoteWork = await remote.runtime.runPromise(WorkRepository);
    const created = await commandCenter.runPromise(
      createCommand(ccWork, {
        doc,
        nodeId,
        route: host,
        key: "lost",
      }),
    );
    const propagation = await commandCenter.runPromise(StationPropagation);
    remote.route.loseNextReport = true;

    const lost = await commandCenter.runPromise(
      propagation.synchronize(
        target(remote.endpoint, remote.installationId, host),
      ).pipe(Effect.either),
    );
    expect(Either.isLeft(lost)).toBe(true);
    if (Either.isLeft(lost)) {
      expect(lost.left).toMatchObject({
        _tag: "StationRemoteExecutionError",
        operation: "report",
      });
    }
    expect(
      (await remote.runtime.runPromise(
        remoteWork.readSnapshot("factory", nodeId),
      )).tasks.items[0]?.id,
    ).toBe(created.value.id);
    expect(
      (await commandCenter.runPromise(
        ccWork.readSnapshot("factory", nodeId),
      )).tasks.items,
    ).toEqual([]);

    // The Remote continues working while the response is lost. Its result is
    // causally downstream of the command that CC has not materialized yet.
    // Replay must return the applied disposition first, then this claim.
    await remote.runtime.runPromise(
      claimTask(remoteWork, {
        doc,
        nodeId,
        route: host,
        eventHome: remote.installationId,
        taskId: created.value.id,
        actor: "lost-response:worker",
      }),
    );

    const recovered = await commandCenter.runPromise(
      propagation.synchronize(
        target(remote.endpoint, remote.installationId, host),
      ),
    );
    expect(recovered.report).toMatchObject({
      rounds: 1,
      outboundSent: 0,
      inboundReceived: 2,
      inboundAccepted: 2,
    });
    expect(
      (await commandCenter.runPromise(
        ccWork.readSnapshot("factory", nodeId),
      )).tasks.items[0],
    ).toMatchObject({
      id: created.value.id,
      state: "working",
      metadata: { claimedBy: "lost-response:worker" },
    });
    expect(remote.route.requests.map((request) => request.outbound.length))
      .toEqual([1, 0]);
    expect(remote.route.responses.map((response) => response.inbound.length))
      .toEqual([1, 2]);
  });

  it("pages more than 256 commands and dispositions without skipping a cursor", async () => {
    const root = await testRoot();
    const host = "render";
    const count = 300;
    const nodes = Array.from({ length: count }, (_, index) => ({
      id: `tasks-${index + 1}`,
      host,
    }));
    const doc = taskCanvas(nodes);
    const remote = await makeRemote(root, "render", host);
    const remoteClient = makeRemoteClient(
      new Map([[remote.endpoint, remote.route]]),
    );
    const commandCenter = makeCommandCenterRuntime(
      join(root, "command-center.db"),
      makeCanvases(new Map([["factory", doc]]), "27"),
      remoteClient,
    );
    runtimes.push(commandCenter);
    await selectCommandCenter(commandCenter);

    const ccWork = await commandCenter.runPromise(WorkRepository);
    for (let index = 0; index < count; index += 1) {
      await commandCenter.runPromise(
        createCommand(ccWork, {
          doc,
          nodeId: nodes[index]!.id,
          route: host,
          key: String(index + 1),
        }),
      );
    }

    const propagation = await commandCenter.runPromise(StationPropagation);
    const receipt = await commandCenter.runPromise(
      propagation.synchronize(
        target(remote.endpoint, remote.installationId, host),
      ),
    );

    expect(receipt.report).toMatchObject({
      rounds: 2,
      outboundSent: count,
      inboundReceived: count,
      inboundAccepted: count,
      inboundIdempotent: 0,
      hasMoreOutbound: false,
      hasMoreInbound: false,
    });
    expect(remote.route.requests.map((request) => request.outbound.length))
      .toEqual([256, 44]);
    expect(remote.route.responses.map((response) => response.inbound.length))
      .toEqual([256, 44]);
    expect(
      await commandCenter.runPromise(
        ccWork.snapshotsForCanvas("factory"),
      ),
    ).toHaveLength(count);
    const remoteWork = await remote.runtime.runPromise(WorkRepository);
    expect(
      await remote.runtime.runPromise(
        remoteWork.snapshotsForCanvas("factory"),
      ),
    ).toHaveLength(count);

    const ccFacts = await commandCenter.runPromise(
      Effect.flatMap(StationRepository, (repository) =>
        repository.statusFacts
      ),
    );
    const remoteFacts = await remote.runtime.runPromise(
      Effect.flatMap(StationRepository, (repository) =>
        repository.statusFacts
      ),
    );
    expect(ccFacts.receivedThrough).toContainEqual({
      home: remote.installationId,
      through: decodeSequence(String(count)),
    });
    expect(remoteFacts.receivedThrough).toContainEqual({
      home: COMMAND_CENTER,
      through: decodeSequence(String(count)),
    });
  });

  it("isolates two Remote routes whose source streams both begin at sequence 1", async () => {
    const root = await testRoot();
    const doc = taskCanvas([
      { id: "tasks-a", host: "host-a" },
      { id: "tasks-b", host: "host-b" },
    ]);
    const remoteA = await makeRemote(root, "remote-a", "host-a");
    const remoteB = await makeRemote(root, "remote-b", "host-b");
    const remoteClient = makeRemoteClient(
      new Map([
        [remoteA.endpoint, remoteA.route],
        [remoteB.endpoint, remoteB.route],
      ]),
    );
    const commandCenter = makeCommandCenterRuntime(
      join(root, "command-center.db"),
      makeCanvases(new Map([["factory", doc]]), "8"),
      remoteClient,
    );
    runtimes.push(commandCenter);
    await selectCommandCenter(commandCenter);

    const ccWork = await commandCenter.runPromise(WorkRepository);
    await commandCenter.runPromise(
      createCommand(ccWork, {
        doc,
        nodeId: "tasks-a",
        route: "host-a",
        key: "a",
      }),
    );
    await commandCenter.runPromise(
      createCommand(ccWork, {
        doc,
        nodeId: "tasks-b",
        route: "host-b",
        key: "b",
      }),
    );

    const commandsA = await commandCenter.runPromise(
      ccWork.eventsAfter({
        eventHome: COMMAND_CENTER,
        entityHome: "host-a",
        afterSeq: "0",
      }),
    );
    const commandsB = await commandCenter.runPromise(
      ccWork.eventsAfter({
        eventHome: COMMAND_CENTER,
        entityHome: "host-b",
        afterSeq: "0",
      }),
    );
    expect(commandsA.map((event) => event.seq)).toEqual(["1"]);
    expect(commandsB.map((event) => event.seq)).toEqual(["1"]);

    const propagation = await commandCenter.runPromise(StationPropagation);
    await commandCenter.runPromise(
      propagation.synchronize(
        target(remoteA.endpoint, remoteA.installationId, "host-a"),
      ),
    );
    await commandCenter.runPromise(
      propagation.synchronize(
        target(remoteB.endpoint, remoteB.installationId, "host-b"),
      ),
    );

    const workA = await remoteA.runtime.runPromise(WorkRepository);
    const workB = await remoteB.runtime.runPromise(WorkRepository);
    expect(
      (await remoteA.runtime.runPromise(
        workA.readSnapshot("factory", "tasks-a"),
      )).tasks.items.map((task) => task.id),
    ).toEqual(["task-a"]);
    expect(
      (await remoteA.runtime.runPromise(
        workA.readSnapshot("factory", "tasks-b"),
      )).tasks.items,
    ).toEqual([]);
    expect(
      (await remoteB.runtime.runPromise(
        workB.readSnapshot("factory", "tasks-b"),
      )).tasks.items.map((task) => task.id),
    ).toEqual(["task-b"]);
    expect(
      (await remoteB.runtime.runPromise(
        workB.readSnapshot("factory", "tasks-a"),
      )).tasks.items,
    ).toEqual([]);

    const factsA = await remoteA.runtime.runPromise(
      workA.eventsAfter({
        eventHome: remoteA.installationId,
        entityHome: "host-a",
        afterSeq: "0",
      }),
    );
    const factsB = await remoteB.runtime.runPromise(
      workB.eventsAfter({
        eventHome: remoteB.installationId,
        entityHome: "host-b",
        afterSeq: "0",
      }),
    );
    expect(factsA.map((event) => event.seq)).toEqual(["1"]);
    expect(factsB.map((event) => event.seq)).toEqual(["1"]);
    expect(factsA[0]?.payloadJson).toContain('"disposition":"applied"');
    expect(factsB[0]?.payloadJson).toContain('"disposition":"applied"');

    const ccFacts = await commandCenter.runPromise(
      Effect.flatMap(StationRepository, (repository) =>
        repository.statusFacts
      ),
    );
    expect(ccFacts.receivedThrough).toEqual(
      expect.arrayContaining([
        { home: remoteA.installationId, through: decodeSequence("1") },
        { home: remoteB.installationId, through: decodeSequence("1") },
      ]),
    );

    await commandCenter.runPromise(
      propagation.synchronize(
        target(remoteA.endpoint, remoteA.installationId, "host-a"),
      ),
    );
    await commandCenter.runPromise(
      propagation.synchronize(
        target(remoteB.endpoint, remoteB.installationId, "host-b"),
      ),
    );
    expect(
      remoteA.route.requests.at(-1)?.acknowledgeInbound,
    ).toEqual([{
      home: remoteA.installationId,
      through: decodeSequence("1"),
    }]);
    expect(
      remoteB.route.requests.at(-1)?.acknowledgeInbound,
    ).toEqual([{
      home: remoteB.installationId,
      through: decodeSequence("1"),
    }]);
  });

  it("rejects foreign homes, corrupt hashes, and wrong ACK homes without advancing", async () => {
    const root = await testRoot();
    const host = "studio";
    const nodeId = "studio-tasks";
    const doc = taskCanvas([{ id: nodeId, host }]);
    const remote = await makeRemote(root, "boundary", host);
    const source = makeStationRuntime(
      join(root, "source.db"),
      COMMAND_CENTER,
    );
    runtimes.push(source);
    const sourceWork = await source.runPromise(WorkRepository);
    await source.runPromise(
      createCommand(sourceWork, {
        doc,
        nodeId,
        route: host,
        key: "boundary",
      }),
    );
    const [canonical] = await source.runPromise(
      sourceWork.eventsAfter({
        eventHome: COMMAND_CENTER,
        entityHome: host,
        afterSeq: "0",
      }),
    );
    expect(canonical).toBeDefined();
    const api = await remote.runtime.runPromise(StationApiService);

    const foreign = await remote.runtime.runPromise(
      api.handle(
        ReportRequest.make({
          protocol: STATION_API_PROTOCOL,
          op: "report",
          stationInstallationId: remote.installationId,
          outbound: [
            StationEvent.make({
              ...stationEventFromWorkEvent(canonical!),
              identity: {
                home: decodeInstallationId("foreign-command-center"),
                sequence: decodeSequence("1"),
              },
            }),
          ],
          acknowledgeInbound: [],
        }),
        READINESS,
      ).pipe(Effect.either),
    );
    expect(Either.isLeft(foreign)).toBe(true);
    if (Either.isLeft(foreign)) {
      expect(foreign.left).toMatchObject({
        _tag: "StationApiInvariantError",
        reason: "event-home-mismatch",
      });
    }

    const corrupt = await remote.runtime.runPromise(
      api.handle(
        ReportRequest.make({
          protocol: STATION_API_PROTOCOL,
          op: "report",
          stationInstallationId: remote.installationId,
          outbound: [
            StationEvent.make({
              ...stationEventFromWorkEvent(canonical!),
              contentSha256: decodeSha256("0".repeat(64)),
            }),
          ],
          acknowledgeInbound: [],
        }),
        READINESS,
      ).pipe(Effect.either),
    );
    expect(Either.isLeft(corrupt)).toBe(true);
    if (Either.isLeft(corrupt)) {
      expect(corrupt.left).toMatchObject({
        _tag: "WorkReplicationError",
        reason: "integrity",
      });
    }

    const wrongAck = await remote.runtime.runPromise(
      api.handle(
        ReportRequest.make({
          protocol: STATION_API_PROTOCOL,
          op: "report",
          stationInstallationId: remote.installationId,
          outbound: [],
          acknowledgeInbound: [{
            home: COMMAND_CENTER,
            through: decodeSequence("1"),
          }],
        }),
        READINESS,
      ).pipe(Effect.either),
    );
    expect(Either.isLeft(wrongAck)).toBe(true);
    if (Either.isLeft(wrongAck)) {
      expect(wrongAck.left).toMatchObject({
        _tag: "StationApiInvariantError",
        reason: "ack-home-mismatch",
      });
    }

    const facts = await remote.runtime.runPromise(
      Effect.flatMap(StationRepository, (repository) =>
        repository.statusFacts
      ),
    );
    expect(facts.receivedThrough).toEqual([]);
  });
});
