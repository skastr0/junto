import { Effect, Either, Layer, Schema } from "effect";
import { describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import {
  InstallationId,
  LogicalSequence,
  ReportResponse,
  STATION_API_PROTOCOL,
  StationEvent,
  StationHostId,
  StationSha256,
  StatusResponse,
  type StationEventAck,
  type StationEvent as StationEventValue,
  type StatusResponse as StatusResponseValue,
} from "../src/shared/station-api";
import {
  CanvasError,
  CanvasesService,
} from "../src/main/vellum/canvases";
import { SshEndpoint } from "../src/main/vellum/ssh/domain";
import {
  StationRepository,
  stationEventContentSha256,
  stationProjectionContentSha256,
  type StationStatusFacts,
} from "../src/main/vellum/station/repository";
import {
  compileStationPortfolioBody,
} from "../src/main/vellum/station/portfolio";
import {
  StationRemoteApiClient,
} from "../src/main/vellum/station/remote-client";
import {
  StationPropagation,
  StationPropagationInvariantError,
  StationPropagationLive,
} from "../src/main/vellum/station/propagation";

const decodeInstallationId = Schema.decodeUnknownSync(InstallationId);
const decodeSequence = Schema.decodeUnknownSync(LogicalSequence);
const decodeHostId = Schema.decodeUnknownSync(StationHostId);
const decodeEndpoint = Schema.decodeUnknownSync(SshEndpoint);
const decodeSha256 = Schema.decodeUnknownSync(StationSha256);

const COMMAND_CENTER = decodeInstallationId("command-center");
const STATION = decodeInstallationId("station-studio");
const ENDPOINT = decodeEndpoint("studio-mini");
const NOW = "2026-07-27T12:00:00.000Z";

const document: CanvasDoc = {
  nodes: [
    {
      id: "agent",
      type: "text",
      x: 0,
      y: 0,
      width: 240,
      height: 100,
      text: "worker",
    },
  ],
  edges: [],
};

const documents = new Map([["portfolio", document]]);
const portfolioBody = compileStationPortfolioBody(documents);
const portfolioHash = stationProjectionContentSha256(portfolioBody);

const event = (
  home: typeof InstallationId.Type,
  sequence: string,
  body: string,
): StationEventValue =>
  StationEvent.make({
    identity: {
      home,
      sequence: decodeSequence(sequence),
    },
    kind: "work.transition",
    body,
    contentSha256: stationEventContentSha256(
      "work.transition",
      body,
    ),
    originAt: NOW,
  });

const commandCenterConfiguration = {
  configuration: {
    role: "command-center" as const,
    hostId: decodeHostId("command"),
    supervisedPreferred: true,
  },
  configuredAt: NOW,
};

const remoteStatus = (
  overrides: Partial<StatusResponseValue> = {},
): StatusResponseValue =>
  StatusResponse.make({
    protocol: STATION_API_PROTOCOL,
    op: "status",
    installationId: STATION,
    state: "ready",
    configuration: {
      role: "remote",
      hostId: decodeHostId("studio"),
      agentHostId: decodeHostId("studio"),
      commandCenterInstallationId: COMMAND_CENTER,
      commandCenterRef: "command.tailnet",
      supervisedPreferred: true,
    },
    receivedThrough: [],
    readiness: {
      database: true,
      workControl: true,
      simulation: true,
    },
    observedAt: NOW,
    ...overrides,
  });

const makeCanvases = () =>
  CanvasesService.of({
    doctor: Effect.succeed({
      id: "canvases",
      label: "Canvases",
      status: "ok",
      detail: "test",
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
    liveDocuments: () => Effect.succeed([]),
    liveAuthorityGeneration: () => Effect.succeed("5"),
    authoritySnapshot: () =>
      Effect.succeed({
        generation: "5",
        documents,
      }),
  });

type RepositoryOptions = {
  readonly outbound?: ReadonlyArray<StationEventValue>;
  readonly receivedThrough?: ReadonlyArray<StationEventAck>;
};

const makeRepository = (
  options: RepositoryOptions = {},
): {
  readonly service: typeof StationRepository.Service;
  readonly eventQueries: Array<{
    readonly home: typeof InstallationId.Type;
    readonly through: typeof LogicalSequence.Type;
  }>;
  readonly advanced: Array<{
    readonly peer: typeof InstallationId.Type;
    readonly acknowledgements: ReadonlyArray<StationEventAck>;
  }>;
  readonly accepted: StationEventValue[];
} => {
  const eventQueries: Array<{
    readonly home: typeof InstallationId.Type;
    readonly through: typeof LogicalSequence.Type;
  }> = [];
  const advanced: Array<{
    readonly peer: typeof InstallationId.Type;
    readonly acknowledgements: ReadonlyArray<StationEventAck>;
  }> = [];
  const accepted: StationEventValue[] = [];
  const facts: StationStatusFacts = {
    installationId: COMMAND_CENTER,
    configuration: commandCenterConfiguration.configuration,
    configuredAt: commandCenterConfiguration.configuredAt,
    receivedThrough: options.receivedThrough ?? [],
    peerAcknowledgedThrough: [],
  };

  return {
    eventQueries,
    advanced,
    accepted,
    service: StationRepository.of({
      installationId: Effect.succeed(COMMAND_CENTER),
      pairing: Effect.succeed(undefined),
      configuration: Effect.succeed(commandCenterConfiguration),
      projection: Effect.succeed(undefined),
      pair: () => Effect.die("unused"),
      configure: () => Effect.die("unused"),
      installProjection: () => Effect.die("unused"),
      appendOutbound: () => Effect.die("unused"),
      eventsAfter: (home, through) =>
        Effect.sync(() => {
          eventQueries.push({ home, through });
          return options.outbound ?? [];
        }),
      acceptInbound: (events) =>
        Effect.sync(() => {
          accepted.push(...events);
          return {
            accepted: events.length,
            idempotent: 0,
            acknowledge: [],
          };
        }),
      advancePeerAcks: (peer, acknowledgements) =>
        Effect.sync(() => {
          advanced.push({ peer, acknowledgements });
          return acknowledgements.map((cursor) => ({
            _tag: "advanced" as const,
            cursor,
          }));
        }),
      statusFacts: Effect.succeed(facts),
    }),
  };
};

const runPropagation = (
  repository: typeof StationRepository.Service,
  remote: typeof StationRemoteApiClient.Service,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const propagation = yield* StationPropagation;
      return yield* propagation.synchronize({
        endpoint: ENDPOINT,
        stationInstallationId: STATION,
      });
    }).pipe(
      Effect.provide(
        StationPropagationLive.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(CanvasesService, makeCanvases()),
              Layer.succeed(StationRepository, repository),
              Layer.succeed(StationRemoteApiClient, remote),
            ),
          ),
        ),
      ),
    ),
  );

describe("StationPropagation", () => {
  it("skips an identical projection and exchanges events from logical cursors", async () => {
    const outbound = event(COMMAND_CENTER, "3", "{\"state\":\"done\"}");
    const inbound = event(STATION, "5", "{\"state\":\"working\"}");
    const repository = makeRepository({
      outbound: [outbound],
      receivedThrough: [{
        home: STATION,
        through: decodeSequence("4"),
      }],
    });
    let projectCalls = 0;
    let reportRequest: Parameters<
      typeof StationRemoteApiClient.Service["report"]
    >[1] | undefined;
    const remote = StationRemoteApiClient.of({
      status: () =>
        Effect.succeed(
          remoteStatus({
            projection: {
              generation: decodeSequence("5"),
              contentSha256: portfolioHash,
              receivedAt: NOW,
            },
            receivedThrough: [{
              home: COMMAND_CENTER,
              through: decodeSequence("2"),
            }],
          }),
        ),
      pair: () => Effect.die("unused"),
      configure: () => Effect.die("unused"),
      project: () =>
        Effect.sync(() => {
          projectCalls += 1;
          throw new Error("projection should have been skipped");
        }),
      report: (_endpoint, request) => {
        reportRequest = request;
        return Effect.succeed(
          ReportResponse.make({
            protocol: STATION_API_PROTOCOL,
            op: "report",
            stationInstallationId: STATION,
            inbound: [inbound],
            acknowledgeOutbound: [{
              home: COMMAND_CENTER,
              through: decodeSequence("3"),
            }],
          }),
        );
      },
    });

    const receipt = await runPropagation(repository.service, remote);

    expect(receipt.projection.decision).toBe("unchanged");
    expect(projectCalls).toBe(0);
    expect(repository.eventQueries).toEqual([{
      home: COMMAND_CENTER,
      through: decodeSequence("2"),
    }]);
    expect(reportRequest).toMatchObject({
      outbound: [outbound],
      acknowledgeInbound: [{
        home: STATION,
        through: decodeSequence("4"),
      }],
    });
    expect(repository.accepted).toEqual([inbound]);
    expect(repository.advanced).toEqual([
      {
        peer: STATION,
        acknowledgements: [{
          home: COMMAND_CENTER,
          through: decodeSequence("2"),
        }],
      },
      {
        peer: STATION,
        acknowledgements: [{
          home: COMMAND_CENTER,
          through: decodeSequence("3"),
        }],
      },
    ]);
    expect(receipt.report).toMatchObject({
      outboundSent: 1,
      inboundReceived: 1,
      inboundAccepted: 1,
      inboundIdempotent: 0,
      hasMoreOutbound: false,
      hasMoreInbound: false,
    });
  });

  it("installs a complete deterministic projection before reporting", async () => {
    const repository = makeRepository();
    let projected:
      | Parameters<typeof StationRemoteApiClient.Service["project"]>[1]
      | undefined;
    const order: string[] = [];
    const remote = StationRemoteApiClient.of({
      status: () => Effect.succeed(remoteStatus()),
      pair: () => Effect.die("unused"),
      configure: () => Effect.die("unused"),
      project: (_endpoint, request) => {
        projected = request;
        order.push("project");
        return Effect.succeed({
          protocol: STATION_API_PROTOCOL,
          op: "project",
          stationInstallationId: STATION,
          decision: "install",
          active: {
            generation: request.projection.generation,
            contentSha256: request.projection.contentSha256,
            receivedAt: NOW,
          },
        });
      },
      report: () => {
        order.push("report");
        return Effect.succeed(
          ReportResponse.make({
            protocol: STATION_API_PROTOCOL,
            op: "report",
            stationInstallationId: STATION,
            inbound: [],
            acknowledgeOutbound: [],
          }),
        );
      },
    });

    const receipt = await runPropagation(repository.service, remote);

    expect(order).toEqual(["project", "report"]);
    expect(projected?.projection).toMatchObject({
      scope: "full",
      generation: decodeSequence("5"),
      body: portfolioBody,
      contentSha256: portfolioHash,
    });
    expect(receipt.projection.decision).toBe("install");
  });

  it("rejects an unexpected Station identity before projection or report", async () => {
    const repository = makeRepository();
    let mutations = 0;
    const remote = StationRemoteApiClient.of({
      status: () =>
        Effect.succeed(
          remoteStatus({
            installationId: decodeInstallationId("other-station"),
          }),
        ),
      pair: () => Effect.die("unused"),
      configure: () => Effect.die("unused"),
      project: () =>
        Effect.sync(() => {
          mutations += 1;
          return {
            protocol: STATION_API_PROTOCOL,
            op: "project",
            stationInstallationId: STATION,
            decision: "conflict",
            active: {
              generation: decodeSequence("5"),
              contentSha256: decodeSha256("b".repeat(64)),
              receivedAt: NOW,
            },
          };
        }),
      report: () =>
        Effect.sync(() => {
          mutations += 1;
          return ReportResponse.make({
            protocol: STATION_API_PROTOCOL,
            op: "report",
            stationInstallationId: STATION,
            inbound: [],
            acknowledgeOutbound: [],
          });
        }),
    });

    const result = await Effect.runPromise(
      Effect.either(
        Effect.gen(function* () {
          const propagation = yield* StationPropagation;
          return yield* propagation.synchronize({
            endpoint: ENDPOINT,
            stationInstallationId: STATION,
          });
        }).pipe(
          Effect.provide(
            StationPropagationLive.pipe(
              Layer.provide(
                Layer.mergeAll(
                  Layer.succeed(CanvasesService, makeCanvases()),
                  Layer.succeed(StationRepository, repository.service),
                  Layer.succeed(StationRemoteApiClient, remote),
                ),
              ),
            ),
          ),
        ),
      ),
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(
        StationPropagationInvariantError,
      );
      expect(result.left).toMatchObject({
        reason: "station-identity-mismatch",
      });
    }
    expect(mutations).toBe(0);
  });

  it("fails closed on equal-generation content conflicts", async () => {
    const repository = makeRepository();
    let mutations = 0;
    const remote = StationRemoteApiClient.of({
      status: () =>
        Effect.succeed(
          remoteStatus({
            projection: {
              generation: decodeSequence("5"),
              contentSha256: decodeSha256("b".repeat(64)),
              receivedAt: NOW,
            },
          }),
        ),
      pair: () => Effect.die("unused"),
      configure: () => Effect.die("unused"),
      project: () =>
        Effect.sync(() => {
          mutations += 1;
          throw new Error("conflicting projection must not be sent");
        }),
      report: () =>
        Effect.sync(() => {
          mutations += 1;
          throw new Error("report must not run after a projection conflict");
        }),
    });

    const result = await Effect.runPromise(
      Effect.either(
        Effect.gen(function* () {
          const propagation = yield* StationPropagation;
          return yield* propagation.synchronize({
            endpoint: ENDPOINT,
            stationInstallationId: STATION,
          });
        }).pipe(
          Effect.provide(
            StationPropagationLive.pipe(
              Layer.provide(
                Layer.mergeAll(
                  Layer.succeed(CanvasesService, makeCanvases()),
                  Layer.succeed(StationRepository, repository.service),
                  Layer.succeed(StationRemoteApiClient, remote),
                ),
              ),
            ),
          ),
        ),
      ),
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toMatchObject({
        _tag: "StationPropagationInvariantError",
        reason: "projection-conflict",
      });
    }
    expect(mutations).toBe(0);
  });
});
