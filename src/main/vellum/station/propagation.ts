import { Clock, Context, Effect, Either, Layer, Schema } from "effect";
import {
  InstallationId,
  LogicalSequence,
  ProjectRequest,
  ReportRequest,
  STATION_API_MAX_EVENTS_PER_REPORT,
  STATION_API_PROTOCOL,
  compareLogicalSequence,
  type ProjectResponse,
  type StationEventAck,
  type StationProjectionReference,
} from "@shared/station-api";
import { SshEndpoint } from "../ssh/domain";
import {
  CanvasesService,
  type CanvasAuthoritySnapshot,
  type CanvasError,
} from "../canvases";
import {
  StationRepository,
  stationProjectionContentSha256,
  type AcceptInboundResult,
  type StationRepositoryError,
} from "./repository";
import {
  StationPortfolioError,
  compileStationPortfolioBody,
} from "./portfolio";
import {
  StationRemoteApiClient,
  type StationRemoteApiError,
} from "./remote-client";

const ZERO_SEQUENCE = Schema.decodeUnknownSync(LogicalSequence)("0");
export const STATION_PROPAGATION_MAX_REPORT_ROUNDS = 32;

export const StationPropagationTarget = Schema.Struct({
  endpoint: SshEndpoint,
  stationInstallationId: InstallationId,
});
export type StationPropagationTarget =
  typeof StationPropagationTarget.Type;

export class StationPropagationInvariantError extends Schema.TaggedError<StationPropagationInvariantError>()(
  "StationPropagationInvariantError",
  {
    operation: Schema.String,
    reason: Schema.Literal(
      "command-center-role-required",
      "station-identity-mismatch",
      "remote-configuration-required",
      "command-center-mismatch",
      "database-unavailable",
      "invalid-generation",
      "projection-stale",
      "projection-conflict",
      "projection-result-mismatch",
      "event-home-mismatch",
      "ack-home-mismatch",
      "report-round-limit",
    ),
    message: Schema.String,
  },
) {}

export type StationPropagationError =
  | CanvasError
  | StationRepositoryError
  | StationPortfolioError
  | StationRemoteApiError
  | StationPropagationInvariantError;

export type StationProjectionSyncReceipt = {
  readonly decision: "unchanged" | "install" | "idempotent";
  readonly active: StationProjectionReference;
};

export type StationReportSyncReceipt = {
  readonly rounds: number;
  readonly outboundSent: number;
  readonly inboundReceived: number;
  readonly inboundAccepted: number;
  readonly inboundIdempotent: number;
  readonly acknowledgeInbound: ReadonlyArray<StationEventAck>;
  readonly acknowledgeOutbound: ReadonlyArray<StationEventAck>;
  readonly hasMoreOutbound: boolean;
  readonly hasMoreInbound: boolean;
};

export type StationPropagationReceipt = {
  readonly stationInstallationId: InstallationId;
  readonly projection: StationProjectionSyncReceipt;
  readonly report: StationReportSyncReceipt;
};

type DesiredProjection = {
  readonly generation: LogicalSequence;
  readonly body: string;
  readonly contentSha256: ProjectRequest["projection"]["contentSha256"];
  readonly createdAt: string;
};

const invariant = (
  operation: string,
  reason: StationPropagationInvariantError["reason"],
  message: string,
): StationPropagationInvariantError =>
  StationPropagationInvariantError.make({
    operation,
    reason,
    message,
  });

const desiredProjection = (
  snapshot: CanvasAuthoritySnapshot,
): Effect.Effect<
  DesiredProjection,
  StationPortfolioError | StationPropagationInvariantError
> =>
  Effect.gen(function* () {
    const generation = Schema.decodeUnknownEither(LogicalSequence)(
      snapshot.generation,
    );
    if (Either.isLeft(generation)) {
      return yield* invariant(
        "projection",
        "invalid-generation",
        "canvas authority generation is not a canonical logical sequence",
      );
    }
    const body = yield* Effect.try({
      try: () => compileStationPortfolioBody(snapshot.documents),
      catch: (error) =>
        error instanceof StationPortfolioError
          ? error
          : StationPortfolioError.make({
              operation: "compile",
              message: "station portfolio could not be compiled",
            }),
    });
    const now = yield* Clock.currentTimeMillis;
    return {
      generation: generation.right,
      body,
      contentSha256: stationProjectionContentSha256(body),
      createdAt: new Date(now).toISOString(),
    };
  });

const ensureProjectionResult = (
  desired: DesiredProjection,
  response: ProjectResponse,
): Effect.Effect<
  StationProjectionSyncReceipt,
  StationPropagationInvariantError
> => {
  if (response.decision === "stale") {
    return Effect.fail(
      invariant(
        "projection",
        "projection-stale",
        "Remote rejected the Command Center projection as stale",
      ),
    );
  }
  if (response.decision === "conflict") {
    return Effect.fail(
      invariant(
        "projection",
        "projection-conflict",
        "Remote holds different content for the Command Center generation",
      ),
    );
  }
  if (
    response.active.generation !== desired.generation ||
    response.active.contentSha256 !== desired.contentSha256
  ) {
    return Effect.fail(
      invariant(
        "projection",
        "projection-result-mismatch",
        "Remote did not activate the projection it acknowledged",
      ),
    );
  }
  return Effect.succeed({
    decision: response.decision,
    active: response.active,
  });
};

const synchronizeProjection = (
  remote: Context.Tag.Service<typeof StationRemoteApiClient>,
  target: StationPropagationTarget,
  current: StationProjectionReference | undefined,
  desired: DesiredProjection,
): Effect.Effect<
  StationProjectionSyncReceipt,
  StationRemoteApiError | StationPropagationInvariantError
> => {
  if (current !== undefined) {
    const order = compareLogicalSequence(
      current.generation,
      desired.generation,
    );
    if (order > 0) {
      return Effect.fail(
        invariant(
          "projection",
          "projection-stale",
          "Remote projection is ahead of Command Center authority",
        ),
      );
    }
    if (
      order === 0 &&
      current.contentSha256 !== desired.contentSha256
    ) {
      return Effect.fail(
        invariant(
          "projection",
          "projection-conflict",
          "Remote holds different content for the Command Center generation",
        ),
      );
    }
    if (order === 0) {
      return Effect.succeed({
        decision: "unchanged",
        active: current,
      });
    }
  }

  return remote
    .project(
      target.endpoint,
      ProjectRequest.make({
        protocol: STATION_API_PROTOCOL,
        op: "project",
        stationInstallationId: target.stationInstallationId,
        projection: {
          scope: "full",
          generation: desired.generation,
          body: desired.body,
          contentSha256: desired.contentSha256,
          createdAt: desired.createdAt,
        },
      }),
    )
    .pipe(
      Effect.flatMap((response) =>
        ensureProjectionResult(desired, response)
      ),
    );
};

const requireEventHomes = (
  operation: string,
  events: ReadonlyArray<{
    readonly identity: { readonly home: InstallationId };
  }>,
  expected: InstallationId,
): Effect.Effect<void, StationPropagationInvariantError> =>
  events.every((event) => event.identity.home === expected)
    ? Effect.void
    : Effect.fail(
        invariant(
          operation,
          "event-home-mismatch",
          "Station report crossed a single-home event boundary",
        ),
      );

const requireAckHomes = (
  operation: string,
  acknowledgements: ReadonlyArray<StationEventAck>,
  expected: InstallationId,
): Effect.Effect<void, StationPropagationInvariantError> =>
  acknowledgements.every(
      (acknowledgement) => acknowledgement.home === expected,
    ) &&
    acknowledgements.length <= 1
    ? Effect.void
    : Effect.fail(
        invariant(
          operation,
          "ack-home-mismatch",
          "Station report crossed or duplicated a single-home acknowledgement boundary",
        ),
      );

type StationReportRoundReceipt = Omit<
  StationReportSyncReceipt,
  "rounds"
>;

const synchronizeReportRound = (
  repository: Context.Tag.Service<typeof StationRepository>,
  remote: Context.Tag.Service<typeof StationRemoteApiClient>,
  target: StationPropagationTarget,
  commandCenterInstallationId: InstallationId,
  remoteReceivedThrough: ReadonlyArray<StationEventAck>,
): Effect.Effect<
  StationReportRoundReceipt,
  | StationRepositoryError
  | StationRemoteApiError
  | StationPropagationInvariantError
> =>
  Effect.gen(function* () {
    yield* requireAckHomes(
      "status",
      remoteReceivedThrough,
      commandCenterInstallationId,
    );
    if (remoteReceivedThrough.length > 0) {
      yield* repository.advancePeerAcks(
        target.stationInstallationId,
        remoteReceivedThrough,
      );
    }

    const remoteCursor =
      remoteReceivedThrough.find(
        (acknowledgement) =>
          acknowledgement.home === commandCenterInstallationId,
      )?.through ?? ZERO_SEQUENCE;
    const outbound = yield* repository.eventsAfter(
      commandCenterInstallationId,
      remoteCursor,
      STATION_API_MAX_EVENTS_PER_REPORT,
    );
    yield* requireEventHomes(
      "report-outbound",
      outbound,
      commandCenterInstallationId,
    );

    const localFacts = yield* repository.statusFacts;
    const acknowledgeInbound = localFacts.receivedThrough.filter(
      (acknowledgement) =>
        acknowledgement.home === target.stationInstallationId,
    );
    yield* requireAckHomes(
      "report-request",
      acknowledgeInbound,
      target.stationInstallationId,
    );

    const response = yield* remote.report(
      target.endpoint,
      ReportRequest.make({
        protocol: STATION_API_PROTOCOL,
        op: "report",
        stationInstallationId: target.stationInstallationId,
        outbound,
        acknowledgeInbound,
      }),
    );
    yield* requireEventHomes(
      "report-inbound",
      response.inbound,
      target.stationInstallationId,
    );
    yield* requireAckHomes(
      "report-response",
      response.acknowledgeOutbound,
      commandCenterInstallationId,
    );

    const accepted: AcceptInboundResult = yield* repository.acceptInbound(
      response.inbound,
    );
    if (response.acknowledgeOutbound.length > 0) {
      yield* repository.advancePeerAcks(
        target.stationInstallationId,
        response.acknowledgeOutbound,
      );
    }

    return {
      outboundSent: outbound.length,
      inboundReceived: response.inbound.length,
      inboundAccepted: accepted.accepted,
      inboundIdempotent: accepted.idempotent,
      acknowledgeInbound,
      acknowledgeOutbound: response.acknowledgeOutbound,
      hasMoreOutbound:
        outbound.length === STATION_API_MAX_EVENTS_PER_REPORT,
      hasMoreInbound:
        response.inbound.length === STATION_API_MAX_EVENTS_PER_REPORT,
    };
  }).pipe(Effect.withSpan("station.propagation.report-round"));

const synchronizeReport = (
  repository: Context.Tag.Service<typeof StationRepository>,
  remote: Context.Tag.Service<typeof StationRemoteApiClient>,
  target: StationPropagationTarget,
  commandCenterInstallationId: InstallationId,
  initialRemoteReceivedThrough: ReadonlyArray<StationEventAck>,
): Effect.Effect<
  StationReportSyncReceipt,
  | StationRepositoryError
  | StationRemoteApiError
  | StationPropagationInvariantError
> =>
  Effect.gen(function* () {
    let remoteReceivedThrough = initialRemoteReceivedThrough;
    let outboundSent = 0;
    let inboundReceived = 0;
    let inboundAccepted = 0;
    let inboundIdempotent = 0;

    for (
      let round = 1;
      round <= STATION_PROPAGATION_MAX_REPORT_ROUNDS;
      round += 1
    ) {
      const receipt = yield* synchronizeReportRound(
        repository,
        remote,
        target,
        commandCenterInstallationId,
        remoteReceivedThrough,
      );
      outboundSent += receipt.outboundSent;
      inboundReceived += receipt.inboundReceived;
      inboundAccepted += receipt.inboundAccepted;
      inboundIdempotent += receipt.inboundIdempotent;

      if (!receipt.hasMoreOutbound && !receipt.hasMoreInbound) {
        return {
          rounds: round,
          outboundSent,
          inboundReceived,
          inboundAccepted,
          inboundIdempotent,
          acknowledgeInbound: receipt.acknowledgeInbound,
          acknowledgeOutbound: receipt.acknowledgeOutbound,
          hasMoreOutbound: false,
          hasMoreInbound: false,
        };
      }

      // The response ACK is the only admissible cursor for the next outbound
      // page. It was already persisted by the completed round; carrying it
      // here also makes a lost outer receipt harmless on retry.
      remoteReceivedThrough = receipt.acknowledgeOutbound;
    }

    return yield* invariant(
      "report",
      "report-round-limit",
      `Station report did not converge within ${STATION_PROPAGATION_MAX_REPORT_ROUNDS} rounds`,
    );
  }).pipe(Effect.withSpan("station.propagation.report"));

export class StationPropagation extends Context.Tag(
  "@vellum/StationPropagation",
)<
  StationPropagation,
  {
    readonly synchronize: (
      target: StationPropagationTarget,
    ) => Effect.Effect<StationPropagationReceipt, StationPropagationError>;
  }
>() {}

export const StationPropagationLive = Layer.effect(
  StationPropagation,
  Effect.gen(function* () {
    const canvases = yield* CanvasesService;
    const repository = yield* StationRepository;
    const remote = yield* StationRemoteApiClient;

    const synchronize = Effect.fn("StationPropagation.synchronize")(
      function* (target: StationPropagationTarget) {
        const commandCenterInstallationId =
          yield* repository.installationId;
        const localConfiguration = yield* repository.configuration;
        if (
          localConfiguration?.configuration.role !== "command-center"
        ) {
          return yield* invariant(
            "synchronize",
            "command-center-role-required",
            "only a configured Command Center may propagate fleet state",
          );
        }

        const status = yield* remote.status(target.endpoint);
        if (status.installationId !== target.stationInstallationId) {
          return yield* invariant(
            "status",
            "station-identity-mismatch",
            "remote status does not match the enrolled Station identity",
          );
        }
        if (status.configuration?.role !== "remote") {
          return yield* invariant(
            "status",
            "remote-configuration-required",
            "fleet propagation requires a configured Remote",
          );
        }
        if (
          status.configuration.commandCenterInstallationId !==
            commandCenterInstallationId
        ) {
          return yield* invariant(
            "status",
            "command-center-mismatch",
            "Remote is paired to a different Command Center",
          );
        }
        if (!status.readiness.database) {
          return yield* invariant(
            "status",
            "database-unavailable",
            "Remote database is not ready for propagation",
          );
        }

        const snapshot = yield* canvases.authoritySnapshot();
        const desired = yield* desiredProjection(snapshot);
        const projection = yield* synchronizeProjection(
          remote,
          target,
          status.projection,
          desired,
        );
        const report = yield* synchronizeReport(
          repository,
          remote,
          target,
          commandCenterInstallationId,
          status.receivedThrough,
        );

        return {
          stationInstallationId: target.stationInstallationId,
          projection,
          report,
        };
      },
    );

    return StationPropagation.of({ synchronize });
  }),
);
