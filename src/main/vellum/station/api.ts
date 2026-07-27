import { Context, Effect, Layer, Schema } from "effect";
import {
  LogicalSequence,
  ReportResponse,
  STATION_API_MAX_EVENTS_PER_REPORT,
  STATION_API_PROTOCOL,
  type InstallationId,
  type ProjectRequest,
  type ProjectResponse,
  type ReportRequest,
  type StationApiRequest,
  type StationApiResponse,
  type StationApiStatusState,
  type StationReadiness,
  StatusResponse,
} from "@shared/station-api";
import {
  StationRepository,
  type StationRepositoryError,
  type StationStatusFacts,
} from "./repository";
import {
  WorkRepository,
  WorkRepositoryError,
  WorkReplicationError,
  stationEventFromWorkEvent,
} from "../work/repository";

export class StationApiInvariantError extends Schema.TaggedError<StationApiInvariantError>()(
  "StationApiInvariantError",
  {
    operation: Schema.String,
    reason: Schema.Literal(
      "pairing-required",
      "station-identity-mismatch",
      "event-home-mismatch",
      "ack-home-mismatch",
      "remote-configuration-required",
    ),
    message: Schema.String,
  },
) {}

export type StationApiError =
  | StationRepositoryError
  | WorkRepositoryError
  | WorkReplicationError
  | StationApiInvariantError;

const ZERO_SEQUENCE = Schema.decodeUnknownSync(LogicalSequence)("0");

export const stationApiStatusState = (
  facts: StationStatusFacts,
  readiness: StationReadiness,
): StationApiStatusState => {
  if (facts.configuration === undefined) {
    return facts.pairing === undefined ? "unenrolled" : "paired";
  }

  const durableReady =
    facts.configuration.role === "command-center" ||
    facts.projection !== undefined;
  if (!durableReady) return "configured";

  return readiness.database &&
      readiness.workControl &&
      readiness.simulation
    ? "ready"
    : "degraded";
};

const requireReportTarget = (
  request: ReportRequest,
  localInstallationId: InstallationId,
): Effect.Effect<void, StationApiInvariantError> =>
  request.stationInstallationId === localInstallationId
    ? Effect.void
    : StationApiInvariantError.make({
        operation: "report",
        reason: "station-identity-mismatch",
        message: "report target does not match this installation",
      });

const handleReport = (
  repository: Context.Tag.Service<typeof StationRepository>,
  work: Context.Tag.Service<typeof WorkRepository>,
  request: ReportRequest,
): Effect.Effect<ReportResponse, StationApiError> =>
  Effect.gen(function* () {
    const localInstallationId = yield* repository.installationId;
    yield* requireReportTarget(request, localInstallationId);

    const configuration = yield* repository.configuration;
    if (configuration?.configuration.role !== "remote") {
      return yield* StationApiInvariantError.make({
        operation: "report",
        reason: "remote-configuration-required",
        message: "report exchange requires a Remote configuration",
      });
    }
    const pairing = yield* repository.pairing;
    if (pairing === undefined) {
      return yield* StationApiInvariantError.make({
        operation: "report",
        reason: "pairing-required",
        message: "report exchange requires an admitted Command Center",
      });
    }

    for (const event of request.outbound) {
      if (
        event.identity.home !== pairing.commandCenterInstallationId
      ) {
        return yield* StationApiInvariantError.make({
          operation: "report",
          reason: "event-home-mismatch",
          message: "report contains an event from an unpaired installation",
        });
      }
    }
    for (const acknowledgement of request.acknowledgeInbound) {
      if (acknowledgement.home !== localInstallationId) {
        return yield* StationApiInvariantError.make({
          operation: "report",
          reason: "ack-home-mismatch",
          message: "report acknowledgement does not name this installation",
        });
      }
    }

    // Materialization and the receive cursor commit together. A transport
    // retry can never observe an ACK for work that was not durably applied.
    yield* work.acceptReplicated({
      localEventHome: localInstallationId,
      eventHome: pairing.commandCenterInstallationId,
      entityHome: configuration.configuration.hostId,
      events: request.outbound,
      causalConflict: "reject-command",
    });
    yield* repository.advancePeerAcks(
      pairing.commandCenterInstallationId,
      configuration.configuration.hostId,
      request.acknowledgeInbound,
    );

    const facts = yield* repository.statusFacts;
    const peerCursor = facts.peerAcknowledgedThrough.find(
      (entry) =>
        entry.peerInstallationId ===
          pairing.commandCenterInstallationId &&
        entry.acknowledgement.home === localInstallationId,
    )?.acknowledgement.through ?? ZERO_SEQUENCE;

    const inbound = (
      yield* work.eventsAfter({
        eventHome: localInstallationId,
        entityHome: configuration.configuration.hostId,
        afterSeq: peerCursor,
        limit: STATION_API_MAX_EVENTS_PER_REPORT,
      })
    ).map(stationEventFromWorkEvent);
    const acknowledgeOutbound = facts.receivedThrough.filter(
      (acknowledgement) =>
        acknowledgement.home === pairing.commandCenterInstallationId,
    );

    return ReportResponse.make({
      protocol: STATION_API_PROTOCOL,
      op: "report",
      stationInstallationId: localInstallationId,
      inbound,
      acknowledgeOutbound,
    });
  }).pipe(Effect.withSpan("station-api.report"));

const handleProject = (
  repository: Context.Tag.Service<typeof StationRepository>,
  request: ProjectRequest,
): Effect.Effect<ProjectResponse, StationApiError> =>
  Effect.gen(function* () {
    const configuration = yield* repository.configuration;
    if (configuration?.configuration.role !== "remote") {
      return yield* StationApiInvariantError.make({
        operation: "project",
        reason: "remote-configuration-required",
        message: "projection install requires a Remote configuration",
      });
    }
    return yield* repository.installProjection(request);
  }).pipe(Effect.withSpan("station-api.project"));

const handleStatus = (
  repository: Context.Tag.Service<typeof StationRepository>,
  readiness: StationReadiness,
): Effect.Effect<StatusResponse, StationRepositoryError> =>
  repository.statusFacts.pipe(
    Effect.map((facts) => StatusResponse.make({
      protocol: STATION_API_PROTOCOL,
      op: "status",
      installationId: facts.installationId,
      state: stationApiStatusState(facts, readiness),
      ...(facts.configuration === undefined
        ? {}
        : { configuration: facts.configuration }),
      ...(facts.configuredAt === undefined
        ? {}
        : { configuredAt: facts.configuredAt }),
      ...(facts.projection === undefined
        ? {}
        : { projection: facts.projection }),
      receivedThrough: facts.receivedThrough,
      readiness,
      observedAt: new Date().toISOString(),
    })),
    Effect.withSpan("station-api.status"),
  );

export class StationApiService extends Context.Tag("@vellum/StationApiService")<
  StationApiService,
  {
    readonly handle: (
      request: StationApiRequest,
      readiness: StationReadiness,
    ) => Effect.Effect<StationApiResponse, StationApiError>;
  }
>() {}

export const StationApiLive = Layer.effect(
  StationApiService,
  Effect.gen(function* () {
    const repository = yield* StationRepository;
    const work = yield* WorkRepository;

    const handle = Effect.fn("StationApiService.handle")((
      request: StationApiRequest,
      readiness: StationReadiness,
    ): Effect.Effect<StationApiResponse, StationApiError> => {
      switch (request.op) {
        case "pair":
          return repository.pair(request);
        case "configure":
          return repository.configureRemote(request);
        case "project":
          return handleProject(repository, request);
        case "report":
          return handleReport(repository, work, request);
        case "status":
          return handleStatus(repository, readiness);
      }
    });

    return StationApiService.of({ handle });
  }),
);
