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
  STATION_PROPAGATION_MAX_REPORT_ROUNDS,
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

const eventRange = (
  home: typeof InstallationId.Type,
  first: number,
  last: number,
): ReadonlyArray<StationEventValue> =>
  Array.from(
    { length: last - first + 1 },
    (_, index) => {
      const sequence = first + index;
      return event(
        home,
        String(sequence),
        `{"sequence":${sequence}}`,
      );
    },
  );

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
  readonly eventsAfter?: (
    home: typeof InstallationId.Type,
    through: typeof LogicalSequence.Type,
  ) => ReadonlyArray<StationEventValue>;
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
  let receivedThrough = [...(options.receivedThrough ?? [])];
  const admitted = new Set<string>();
  const facts = (): StationStatusFacts => ({
    installationId: COMMAND_CENTER,
    configuration: commandCenterConfiguration.configuration,
    configuredAt: commandCenterConfiguration.configuredAt,
    receivedThrough,
    peerAcknowledgedThrough: [],
  });

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
          return options.eventsAfter?.(home, through) ??
            options.outbound ??
            [];
        }),
      acceptInbound: (events) =>
        Effect.sync(() => {
          accepted.push(...events);
          let acceptedCount = 0;
          let idempotent = 0;
          for (const item of events) {
            const key =
              `${item.identity.home}\u0000${item.identity.sequence}`;
            if (admitted.has(key)) {
              idempotent += 1;
            } else {
              admitted.add(key);
              acceptedCount += 1;
            }
          }
          for (const home of new Set(
            events.map((item) => item.identity.home),
          )) {
            const last = events
              .filter((item) => item.identity.home === home)
              .at(-1);
            if (last === undefined) continue;
            receivedThrough = [
              ...receivedThrough.filter(
                (acknowledgement) =>
                  acknowledgement.home !== home,
              ),
              {
                home,
                through: last.identity.sequence,
              },
            ];
          }
          return {
            accepted: acceptedCount,
            idempotent,
            acknowledge: receivedThrough,
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
      statusFacts: Effect.sync(facts),
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

  it("drains subsequent outbound and inbound pages from returned logical ACKs", async () => {
    const outbound = eventRange(COMMAND_CENTER, 1, 257);
    const inbound = eventRange(STATION, 1, 257);
    const repository = makeRepository({
      eventsAfter: (_home, through) => {
        const offset = Number(through);
        return outbound.slice(
          offset,
          offset + 256,
        );
      },
    });
    const requests: Array<
      Parameters<typeof StationRemoteApiClient.Service["report"]>[1]
    > = [];
    let projectCalls = 0;
    const remote = StationRemoteApiClient.of({
      status: () =>
        Effect.succeed(
          remoteStatus({
            projection: {
              generation: decodeSequence("5"),
              contentSha256: portfolioHash,
              receivedAt: NOW,
            },
          }),
        ),
      pair: () => Effect.die("unused"),
      configure: () => Effect.die("unused"),
      project: () =>
        Effect.sync(() => {
          projectCalls += 1;
          throw new Error("projection must run only when needed");
        }),
      report: (_endpoint, request) => {
        requests.push(request);
        const round = requests.length;
        const through = round === 1 ? 256 : 257;
        return Effect.succeed(
          ReportResponse.make({
            protocol: STATION_API_PROTOCOL,
            op: "report",
            stationInstallationId: STATION,
            inbound: round === 1
              ? inbound.slice(0, 256)
              : inbound.slice(256),
            acknowledgeOutbound: [{
              home: COMMAND_CENTER,
              through: decodeSequence(String(through)),
            }],
          }),
        );
      },
    });

    const receipt = await runPropagation(repository.service, remote);

    expect(projectCalls).toBe(0);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.outbound).toHaveLength(256);
    expect(requests[0]?.outbound[0]?.identity.sequence).toBe("1");
    expect(requests[0]?.acknowledgeInbound).toEqual([]);
    expect(requests[1]?.outbound).toHaveLength(1);
    expect(requests[1]?.outbound[0]?.identity.sequence).toBe("257");
    expect(requests[1]?.acknowledgeInbound).toEqual([{
      home: STATION,
      through: decodeSequence("256"),
    }]);
    expect(repository.eventQueries).toEqual([
      {
        home: COMMAND_CENTER,
        through: decodeSequence("0"),
      },
      {
        home: COMMAND_CENTER,
        through: decodeSequence("256"),
      },
    ]);
    expect(receipt.report).toMatchObject({
      rounds: 2,
      outboundSent: 257,
      inboundReceived: 257,
      inboundAccepted: 257,
      inboundIdempotent: 0,
      hasMoreOutbound: false,
      hasMoreInbound: false,
    });
  });

  it("fails with a typed bound error when full report pages never converge", async () => {
    const fullOutbound = eventRange(COMMAND_CENTER, 1, 256);
    const fullInbound = eventRange(STATION, 1, 256);
    const repository = makeRepository({
      outbound: fullOutbound,
    });
    let projectCalls = 0;
    let reportCalls = 0;
    const remote = StationRemoteApiClient.of({
      status: () => Effect.succeed(remoteStatus()),
      pair: () => Effect.die("unused"),
      configure: () => Effect.die("unused"),
      project: (_endpoint, request) =>
        Effect.sync(() => {
          projectCalls += 1;
          return {
            protocol: STATION_API_PROTOCOL,
            op: "project",
            stationInstallationId: STATION,
            decision: "install",
            active: {
              generation: request.projection.generation,
              contentSha256: request.projection.contentSha256,
              receivedAt: NOW,
            },
          };
        }),
      report: () =>
        Effect.sync(() => {
          reportCalls += 1;
          return ReportResponse.make({
            protocol: STATION_API_PROTOCOL,
            op: "report",
            stationInstallationId: STATION,
            inbound: fullInbound,
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
        operation: "report",
        reason: "report-round-limit",
      });
    }
    expect(projectCalls).toBe(1);
    expect(reportCalls).toBe(
      STATION_PROPAGATION_MAX_REPORT_ROUNDS,
    );
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
