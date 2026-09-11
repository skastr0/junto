import {
  Effect,
  Layer,
  ManagedRuntime,
  Schema,
} from "effect";
import { describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import {
  InstallationId,
  LogicalSequence,
  ProjectResponse,
  ReportRequest,
  ReportResponse,
  STATION_API_PROTOCOL,
  StationHostId,
  StatusResponse,
  type ProjectRequest,
  type StationApiRequest,
  type StationApiResponse,
} from "../src/shared/station-api";
import {
  CanvasError,
  CanvasesService,
} from "../src/main/vellum-command/canvases";
import {
  CURRENT_STATION_PROTOCOL_SUPPORT,
  STATION_PROTOCOL_BASELINE,
  StationAppVersion,
  StationStateSchemaVersion,
} from "../src/shared/station-protocol";
import {
  StationApiService,
} from "../src/main/vellum-command/station/api";
import {
  StationFleetTargetRepository,
  type StationFleetTarget,
} from "../src/main/vellum-command/station/fleet-target-repository";
import type {
  StationApiResponseFor,
  StationPeerSession,
} from "../src/main/vellum-command/station/peer-session";
import {
  bindNegotiatedStationProtocol,
} from "../src/main/vellum-command/station/peer-session";
import {
  StationPropagation,
  StationPropagationLive,
  summarizeStationProjectionTopology,
} from "../src/main/vellum-command/station/propagation";
import {
  StationRepository,
  stationProjectionContentSha256,
} from "../src/main/vellum-command/station/repository";
import {
  canvasAuthorityMaterialFixture,
} from "./helpers/canvas-authority-material";

const installationId = Schema.decodeUnknownSync(InstallationId);
const stationHostId = Schema.decodeUnknownSync(StationHostId);

const COMMAND_CENTER = installationId("command-center");
const REMOTE = installationId("remote-one");
const LOCAL_HOST = stationHostId("local");
const REMOTE_HOST = stationHostId("remote-one");
const NOW = "2026-07-27T12:00:00.000Z";
const AUTHORITY_SHA256 =
  stationProjectionContentSha256("test canvas authority");
const projectionSequence = Schema.decodeUnknownSync(LogicalSequence);
const PROTOCOL_DIAGNOSTICS = {
  appVersion: StationAppVersion.make("propagation-test"),
  stateSchemaVersion: StationStateSchemaVersion.make(1),
  support: CURRENT_STATION_PROTOCOL_SUPPORT,
};
const PROTOCOL = bindNegotiatedStationProtocol({
  negotiatedProtocol: STATION_PROTOCOL_BASELINE,
  local: PROTOCOL_DIAGNOSTICS,
  peer: PROTOCOL_DIAGNOSTICS,
});

const TARGET: StationFleetTarget = {
  hostId: REMOTE_HOST,
  stationInstallationId: REMOTE,
  boundAt: NOW,
};

const emptyCanvas: CanvasDoc = {
  nodes: [],
  edges: [],
};

const canvases = (
  documents: ReadonlyMap<string, CanvasDoc> =
    new Map([["main", emptyCanvas]]),
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
    readWithIntentWitness: () =>
      Effect.fail(new CanvasError({ message: "unused" })),
    readNodeStructure: () =>
      Effect.fail(new CanvasError({ message: "unused" })),
    write: () => Effect.fail(new CanvasError({ message: "unused" })),
    mutate: () => Effect.fail(new CanvasError({ message: "unused" })),
    create: () => Effect.fail(new CanvasError({ message: "unused" })),
    remove: () => Effect.fail(new CanvasError({ message: "unused" })),
    ensureSeed: Effect.void,
    writeSidecar: () =>
      Effect.fail(new CanvasError({ message: "unused" })),
    start: () => undefined,
    subscribeChanges: () => () => undefined,
    announceInstalledProjection: () => undefined,
    liveDocuments: () =>
      Effect.succeed(
        [...documents].map(([canvasName, doc]) => ({
          canvasName,
          doc,
        })),
      ),
    liveAuthorityGeneration: () => Effect.succeed(generation),
    authoritySnapshot: () =>
      Effect.succeed({
        generation,
        intentSha256: AUTHORITY_SHA256,
        documents,
      }),
    authorityMaterialSnapshot: () =>
      Effect.sync(() => canvasAuthorityMaterialFixture(generation, documents)),
    activeIntentWitness: () =>
      Effect.succeed({
        generation,
        contentSha256: AUTHORITY_SHA256,
      }),
    activeActorRefs: () => Effect.succeed([]),
  });

const repository = (
  role: "command-center" | "remote" = "command-center",
) => {
  let archived: ProjectRequest["projection"] | undefined;
  return StationRepository.of({
    installationId: Effect.succeed(COMMAND_CENTER),
    pairing: Effect.succeed(undefined),
    configuration: Effect.succeed({
      configuration:
        role === "command-center"
          ? {
              role: "command-center",
              hostId: LOCAL_HOST,
              supervisedPreferred: true,
            }
          : {
              role: "remote",
              hostId: REMOTE_HOST,
              agentHostId: REMOTE_HOST,
              commandCenterInstallationId: COMMAND_CENTER,
              supervisedPreferred: true,
            },
      configuredAt: NOW,
    }),
    projection: Effect.succeed(undefined),
    projectionByReference: (reference) =>
      Effect.succeed(
        archived?.generation === reference.generation &&
            archived.contentSha256 === reference.contentSha256
          ? { ...archived, receivedAt: NOW }
          : undefined,
      ),
    archiveProjection: (draft) =>
      Effect.sync(() => {
        const contentSha256 =
          stationProjectionContentSha256(draft.body);
        if (
          archived?.sourceCanvasGeneration ===
            draft.sourceCanvasGeneration &&
          archived.sourceIntentSha256 === draft.sourceIntentSha256 &&
          archived.contentSha256 === contentSha256 &&
          archived.body === draft.body
        ) {
          return archived;
        }
        archived = {
          ...draft,
          generation: projectionSequence(
            archived === undefined
              ? "1"
              : (BigInt(archived.generation) + 1n).toString(),
          ),
          contentSha256,
        };
        return archived;
      }),
    pair: () => Effect.die("unused"),
    configureRemote: () => Effect.die("unused"),
    installProjection: () => Effect.die("unused"),
    statusFacts: Effect.die("unused"),
  });
};

const fleetTargets = StationFleetTargetRepository.of({
  bind: () => Effect.die("unused"),
  get: () => Effect.succeed(TARGET),
  list: Effect.succeed([TARGET]),
  remove: () => Effect.die("unused"),
  subscribeChanges: () => () => {},
});

type RequestHandler = <R extends StationApiRequest>(
  request: R,
) => Effect.Effect<StationApiResponseFor<R>>;

const session = (
  handle: RequestHandler,
  peerInstallationId = REMOTE,
): StationPeerSession => ({
  localInstallationId: COMMAND_CENTER,
  peerInstallationId,
  protocol: PROTOCOL,
  request: handle,
  withOpen: (effect) => effect,
  isOpen: Effect.succeed(true),
  awaitClosed: Effect.never,
  close: Effect.void,
});

const status = (
  projection?: StatusResponse["projection"],
  readiness: StatusResponse["readiness"] = {
    database: true,
    workControl: true,
    simulation: true,
    session: true,
  },
) =>
  StatusResponse.make({
    protocol: STATION_API_PROTOCOL,
    op: "status",
    installationId: REMOTE,
    state: "ready",
    configuration: {
      role: "remote",
      hostId: REMOTE_HOST,
      agentHostId: REMOTE_HOST,
      commandCenterInstallationId: COMMAND_CENTER,
      supervisedPreferred: true,
    },
    configuredAt: NOW,
    ...(projection === undefined ? {} : { projection }),
    receivedThrough: [],
    peerAcknowledgedThrough: [],
    readiness,
    observedAt: NOW,
  });

const api = (options: {
  readonly prepare?: (
    round: number,
  ) => ReportRequest;
  readonly integrate?: (
    round: number,
    response: ReportResponse,
  ) => {
    readonly accepted: number;
    readonly idempotent: number;
    readonly rejected: number;
    readonly receivedThrough: [];
    readonly peerHasMore: boolean;
  };
} = {}) => {
  let prepared = 0;
  let integrated = 0;
  return StationApiService.of({
    handle: () => Effect.die("unused"),
    prepareReport: () =>
      Effect.sync(() => {
        prepared += 1;
        return options.prepare?.(prepared) ??
          ReportRequest.make({
            protocol: STATION_API_PROTOCOL,
            op: "report",
            senderInstallationId: COMMAND_CENTER,
            targetInstallationId: REMOTE,
            batch: {
              records: [],
              acknowledge: [],
              hasMore: false,
            },
          });
      }),
    acceptReportResponse: (_peer, _request, response) =>
      Effect.sync(() => {
        integrated += 1;
        return options.integrate?.(integrated, response) ?? {
          accepted: 0,
          idempotent: 0,
          rejected: 0,
          receivedThrough: [],
          peerHasMore: false,
        };
      }),
  });
};

const runtime = (
  stationApi: ReturnType<typeof api>,
  stationRepository = repository(),
  canvasService = canvases(),
) =>
  ManagedRuntime.make(
    Layer.provide(
      StationPropagationLive,
      Layer.mergeAll(
        Layer.succeed(CanvasesService, canvasService),
        Layer.succeed(StationRepository, stationRepository),
        Layer.succeed(StationApiService, stationApi),
        Layer.succeed(
          StationFleetTargetRepository,
          fleetTargets,
        ),
      ),
    ) as never);

const reportResponse = (hasMore = false) =>
  ReportResponse.make({
    protocol: STATION_API_PROTOCOL,
    op: "report",
    senderInstallationId: REMOTE,
    targetInstallationId: COMMAND_CENTER,
    batch: {
      records: [],
      acknowledge: [],
      hasMore,
    },
  });

describe("StationPropagation", () => {
  it("summarizes the exact projected actor and sink routes per Remote", () => {
    const node = (
      id: string,
      kind: string,
      host: string,
    ): CanvasDoc["nodes"][number] => ({
      id,
      type: "text",
      text: id,
      x: 0,
      y: 0,
      width: 100,
      height: 40,
      ether: { entity: { kind }, host },
    });
    const document: CanvasDoc = {
      nodes: [
        node("cc-actor", "agent", "local"),
        node("cc-sink", "task", "local"),
        node("remote-actor", "agent", "remote-one"),
        node("remote-sink", "requests", "remote-one"),
        node("remote-cron", "cron", "remote-one"),
        node("other-sink", "artifacts", "remote-two"),
      ],
      edges: [
        { id: "e1", fromNode: "remote-actor", toNode: "remote-sink", ether: { verb: "escalates" } },
        { id: "e2", fromNode: "remote-actor", toNode: "cc-sink", ether: { verb: "contributes" } },
        { id: "e3", fromNode: "cc-actor", toNode: "remote-sink", ether: { verb: "escalates" } },
        { id: "e4", fromNode: "remote-actor", toNode: "other-sink", ether: { verb: "publishes" } },
        { id: "e5", fromNode: "missing", toNode: "remote-sink" },
      ],
    };

    expect(
      summarizeStationProjectionTopology(
        new Map([["main", document]]),
        "local",
        "remote-one",
      ),
    ).toEqual({
      canvasCount: 1,
      nodeCount: 6,
      edgeCount: 5,
      actorCount: 2,
      sinkCount: 3,
      schedulerCount: 1,
      targetNodeCount: 3,
      targetActorCount: 1,
      targetSinkCount: 1,
      targetSchedulerCount: 1,
      commandCenterNodeCount: 2,
      otherStationNodeCount: 1,
      targetInternalAccessEdgeCount: 1,
      remoteActorToCommandCenterSinkEdgeCount: 1,
      commandCenterActorToRemoteSinkEdgeCount: 1,
      stationPeerEdgeCount: 1,
      danglingEdgeCount: 1,
    });
  });

  it("runs status, projection, and report on the supplied persistent session", async () => {
    const operations: StationApiRequest["op"][] = [];
    let projected: ProjectRequest | undefined;
    let statusRequests = 0;
    const peer = session(<R extends StationApiRequest>(request: R) => {
      operations.push(request.op);
      switch (request.op) {
        case "status": {
          statusRequests += 1;
          return Effect.succeed(
            status(
              statusRequests === 1 || projected === undefined
                ? undefined
                : {
                    generation: projected.projection.generation,
                    contentSha256:
                      projected.projection.contentSha256,
                    receivedAt: NOW,
                  },
            ),
          ) as Effect.Effect<StationApiResponseFor<R>>;
        }
        case "project": {
          projected = request;
          return Effect.succeed(
            ProjectResponse.make({
              protocol: STATION_API_PROTOCOL,
              op: "project",
              stationInstallationId: REMOTE,
              decision: "install",
              active: {
                generation: request.projection.generation,
                contentSha256:
                  request.projection.contentSha256,
                receivedAt: NOW,
              },
            }),
          ) as Effect.Effect<StationApiResponseFor<R>>;
        }
        case "report":
          return Effect.succeed(
            reportResponse(),
          ) as Effect.Effect<StationApiResponseFor<R>>;
        default:
          return Effect.die("unexpected Station operation");
      }
    });
    const stationRuntime = runtime(
      api(),
      repository(),
      canvases(undefined, "41"),
    );

    try {
      const receipt = await stationRuntime.runPromise(
        Effect.flatMap(StationPropagation, (service) =>
          service.synchronize(
            {
              stationInstallationId: REMOTE,
              hostId: REMOTE_HOST,
            },
            peer,
          )
        ),
      );

      expect(operations).toEqual([
        "status",
        "project",
        "report",
        "status",
      ]);
      expect(projected?.projection.scope).toBe("full");
      expect(projected?.projection).toMatchObject({
        generation: "1",
        sourceCanvasGeneration: "41",
        sourceIntentSha256: AUTHORITY_SHA256,
      });
      expect(projected?.projection.contentSha256).toBe(
        stationProjectionContentSha256(
          projected?.projection.body ?? "",
        ),
      );
      expect(receipt.projection.decision).toBe("install");
      expect(receipt.remoteStatus).toMatchObject({
        installationId: REMOTE,
        state: "ready",
        projection: {
          generation: projected?.projection.generation,
          contentSha256: projected?.projection.contentSha256,
        },
        readiness: {
          database: true,
          workControl: true,
          simulation: true,
          session: true,
        },
      });
      expect(receipt.report).toMatchObject({
        rounds: 1,
        outboundSent: 0,
        inboundReceived: 0,
        inboundAccepted: 0,
        inboundIdempotent: 0,
        inboundRejected: 0,
      });
    } finally {
      await stationRuntime.dispose();
    }
  });

  it("does not reinstall an identical active projection", async () => {
    let desired:
      | {
          readonly generation: ProjectRequest["projection"]["generation"];
          readonly contentSha256:
            ProjectRequest["projection"]["contentSha256"];
        }
      | undefined;
    const firstPeer = session(<R extends StationApiRequest>(request: R) => {
      if (request.op === "status") {
        return Effect.succeed(status()) as Effect.Effect<
          StationApiResponseFor<R>
        >;
      }
      if (request.op === "project") {
        desired = request.projection;
        return Effect.succeed(
          ProjectResponse.make({
            protocol: STATION_API_PROTOCOL,
            op: "project",
            stationInstallationId: REMOTE,
            decision: "install",
            active: {
              generation: request.projection.generation,
              contentSha256:
                request.projection.contentSha256,
              receivedAt: NOW,
            },
          }),
        ) as Effect.Effect<StationApiResponseFor<R>>;
      }
      if (request.op === "report") {
        return Effect.succeed(
          reportResponse(),
        ) as Effect.Effect<StationApiResponseFor<R>>;
      }
      return Effect.die("unexpected Station operation");
    });
    const stationRuntime = runtime(api());

    try {
      await stationRuntime.runPromise(
        Effect.flatMap(StationPropagation, (service) =>
          service.synchronize(
            {
              stationInstallationId: REMOTE,
              hostId: REMOTE_HOST,
            },
            firstPeer,
          )
        ),
      );
      if (desired === undefined) throw new Error("projection not captured");

      const operations: StationApiRequest["op"][] = [];
      const secondPeer = session(
        <R extends StationApiRequest>(request: R) => {
          operations.push(request.op);
          if (request.op === "status") {
            return Effect.succeed(
              status({
                generation: desired!.generation,
                contentSha256: desired!.contentSha256,
                receivedAt: NOW,
              }),
            ) as Effect.Effect<StationApiResponseFor<R>>;
          }
          if (request.op === "report") {
            return Effect.succeed(
              reportResponse(),
            ) as Effect.Effect<StationApiResponseFor<R>>;
          }
          return Effect.die("projection should be unchanged");
        },
      );
      const receipt = await stationRuntime.runPromise(
        Effect.flatMap(StationPropagation, (service) =>
          service.synchronize(
            {
              stationInstallationId: REMOTE,
              hostId: REMOTE_HOST,
            },
            secondPeer,
          )
        ),
      );

      expect(operations).toEqual(["status", "report", "status"]);
      expect(receipt.projection.decision).toBe("unchanged");
    } finally {
      await stationRuntime.dispose();
    }
  });

  it("pages reports until both directions declare convergence", async () => {
    const stationApi = api({
      prepare: (round) =>
        ReportRequest.make({
          protocol: STATION_API_PROTOCOL,
          op: "report",
          senderInstallationId: COMMAND_CENTER,
          targetInstallationId: REMOTE,
          batch: {
            records: [],
            acknowledge: [],
            hasMore: round === 1,
          },
        }),
      integrate: (round) => ({
        accepted: round,
        idempotent: 0,
        rejected: 0,
        receivedThrough: [],
        peerHasMore: round === 1,
      }),
    });
    const peer = session(<R extends StationApiRequest>(request: R) => {
      if (request.op === "status") {
        return Effect.succeed(status()) as Effect.Effect<
          StationApiResponseFor<R>
        >;
      }
      if (request.op === "project") {
        return Effect.succeed(
          ProjectResponse.make({
            protocol: STATION_API_PROTOCOL,
            op: "project",
            stationInstallationId: REMOTE,
            decision: "install",
            active: {
              generation: request.projection.generation,
              contentSha256:
                request.projection.contentSha256,
              receivedAt: NOW,
            },
          }),
        ) as Effect.Effect<StationApiResponseFor<R>>;
      }
      if (request.op === "report") {
        return Effect.succeed(
          reportResponse(request.batch.hasMore),
        ) as Effect.Effect<StationApiResponseFor<R>>;
      }
      return Effect.die("unexpected Station operation");
    });
    const stationRuntime = runtime(stationApi);

    try {
      const receipt = await stationRuntime.runPromise(
        Effect.flatMap(StationPropagation, (service) =>
          service.synchronize(
            {
              stationInstallationId: REMOTE,
              hostId: REMOTE_HOST,
            },
            peer,
          )
        ),
      );

      expect(receipt.report).toMatchObject({
        rounds: 2,
        inboundAccepted: 3,
        hasMoreOutbound: false,
        hasMoreInbound: false,
      });
    } finally {
      await stationRuntime.dispose();
    }
  });

  it("rejects a Remote whose isolated execution plane is degraded", async () => {
    const peer = session(<R extends StationApiRequest>(request: R) => {
      if (request.op === "status") {
        return Effect.succeed(
          status(undefined, {
            database: true,
            workControl: true,
            simulation: false,
            session: true,
          }),
        ) as Effect.Effect<StationApiResponseFor<R>>;
      }
      return Effect.die("degraded Remote must stop after status");
    });
    const stationRuntime = runtime(api());

    try {
      const result = await stationRuntime.runPromise(
        Effect.result(
          Effect.flatMap(StationPropagation, (service) =>
            service.synchronize(
              {
                stationInstallationId: REMOTE,
                hostId: REMOTE_HOST,
              },
              peer,
            )
          ),
        ),
      );

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure).toMatchObject({
          _tag: "StationPropagationInvariantError",
          reason: "simulation-unavailable",
        });
      }
    } finally {
      await stationRuntime.dispose();
    }
  });

  it("compiles and archives one stable desired projection identity per committed authority", async () => {
    const stationRuntime = runtime(api(), repository(), canvases(undefined, "41"));

    try {
      const propagation = await stationRuntime.runPromise(StationPropagation);
      const first = await stationRuntime.runPromise(
        propagation.desiredProjectionForHost(REMOTE_HOST),
      );
      const second = await stationRuntime.runPromise(
        propagation.desiredProjectionForHost(REMOTE_HOST),
      );

      expect(first).toMatchObject({
        scope: "full",
        generation: "1",
        sourceCanvasGeneration: "41",
        sourceIntentSha256: AUTHORITY_SHA256,
      });
      expect(first.contentSha256).toBe(
        stationProjectionContentSha256(first.body),
      );
      // Archiving is idempotent for identical committed content, so the
      // barrier and the next synchronize name the same acknowledgement.
      expect(second.generation).toBe(first.generation);
      expect(second.contentSha256).toBe(first.contentSha256);
    } finally {
      await stationRuntime.dispose();
    }
  });

  it("refuses to compile a desired projection off the Command Center role", async () => {
    const stationRuntime = runtime(api(), repository("remote"));

    try {
      const result = await stationRuntime.runPromise(
        Effect.result(
          Effect.flatMap(StationPropagation, (service) =>
            service.desiredProjectionForHost(REMOTE_HOST)
          ),
        ),
      );

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure).toMatchObject({
          _tag: "StationPropagationInvariantError",
          reason: "command-center-role-required",
        });
      }
    } finally {
      await stationRuntime.dispose();
    }
  });
});
