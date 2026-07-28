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
} from "../src/main/vellum/canvases";
import {
  StationApiService,
} from "../src/main/vellum/station/api";
import {
  StationFleetTargetRepository,
  type StationFleetTarget,
} from "../src/main/vellum/station/fleet-target-repository";
import type {
  StationApiResponseFor,
  StationPeerSession,
} from "../src/main/vellum/station/peer-session";
import {
  StationPropagation,
  StationPropagationLive,
} from "../src/main/vellum/station/propagation";
import {
  StationRepository,
  stationProjectionContentSha256,
} from "../src/main/vellum/station/repository";

const installationId = Schema.decodeUnknownSync(InstallationId);
const stationHostId = Schema.decodeUnknownSync(StationHostId);

const COMMAND_CENTER = installationId("command-center");
const REMOTE = installationId("remote-one");
const LOCAL_HOST = stationHostId("local");
const REMOTE_HOST = stationHostId("remote-one");
const NOW = "2026-07-27T12:00:00.000Z";

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
        [...documents].map(([canvasName, doc]) => ({
          canvasName,
          doc,
        })),
      ),
    liveAuthorityGeneration: () => Effect.succeed(generation),
    authoritySnapshot: () =>
      Effect.succeed({ generation, documents }),
    activeActorRefs: () => Effect.succeed([]),
  });

const repository = (
  role: "command-center" | "remote" = "command-center",
) =>
  StationRepository.of({
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
    pair: () => Effect.die("unused"),
    configureRemote: () => Effect.die("unused"),
    installProjection: () => Effect.die("unused"),
    advancePeerAcks: () => Effect.die("unused"),
    statusFacts: Effect.die("unused"),
  });

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
    ),
  );

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
    const stationRuntime = runtime(api());

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
        Effect.either(
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

      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect(result.left).toMatchObject({
          _tag: "StationPropagationInvariantError",
          reason: "simulation-unavailable",
        });
      }
    } finally {
      await stationRuntime.dispose();
    }
  });
});
