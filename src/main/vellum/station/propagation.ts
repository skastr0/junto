import { Clock, Context, Effect, Either, Layer, Schema } from "effect";
import {
  InstallationId,
  LogicalSequence,
  ProjectRequest,
  STATION_API_PROTOCOL,
  StationHostId,
  StationSha256,
  StatusRequest,
  compareLogicalSequence,
  type ProjectResponse,
  type RouteCursor,
  type StatusResponse,
  type StationProjectionReference,
} from "@shared/station-api";
import {
  CanvasesService,
  type CanvasAuthoritySnapshot,
  type CanvasError,
} from "../canvases";
import {
  StationApiService,
  type StationApiError,
} from "./api";
import { StationContextTagIds } from "./context-services";
import {
  StationFleetTargetRepository,
  type StationFleetTargetRepositoryError,
} from "./fleet-target-repository";
import {
  type StationPeerRequestError,
  type StationPeerSession,
} from "./peer-session";
import {
  StationRepository,
  type StationRepositoryError,
} from "./repository";
import {
  StationPortfolioError,
  compileStationPortfolioBody,
} from "./portfolio";

export const STATION_PROPAGATION_MAX_REPORT_ROUNDS = 32;

/**
 * Stable fleet identity only. Transport locators and credentials belong to
 * the peer-exchange adapter and never enter propagation semantics.
 */
export const StationPropagationTarget = Schema.Struct({
  stationInstallationId: InstallationId,
  hostId: StationHostId,
});
export type StationPropagationTarget =
  typeof StationPropagationTarget.Type;

export class StationPropagationInvariantError extends Schema.TaggedError<StationPropagationInvariantError>()(
  "StationPropagationInvariantError",
  {
    operation: Schema.String,
    reason: Schema.Literal(
      "command-center-role-required",
      "session-identity-mismatch",
      "station-identity-mismatch",
      "remote-configuration-required",
      "station-host-mismatch",
      "command-center-mismatch",
      "database-unavailable",
      "work-control-unavailable",
      "simulation-unavailable",
      "session-unavailable",
      "invalid-generation",
      "invalid-source-intent-hash",
      "projection-stale",
      "projection-conflict",
      "projection-result-mismatch",
      "report-round-limit",
    ),
    message: Schema.String,
  },
) {}

export type StationPropagationError =
  | CanvasError
  | StationRepositoryError
  | StationFleetTargetRepositoryError
  | StationPortfolioError
  | StationApiError
  | StationPeerRequestError
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
  readonly inboundRejected: number;
  readonly receivedThrough: ReadonlyArray<RouteCursor>;
  readonly hasMoreOutbound: boolean;
  readonly hasMoreInbound: boolean;
};

export type StationPropagationReceipt = {
  readonly stationInstallationId:
    StationPropagationTarget["stationInstallationId"];
  /** Exact observation received over this persistent peer session. */
  readonly remoteStatus: StatusResponse;
  readonly projection: StationProjectionSyncReceipt;
  readonly report: StationReportSyncReceipt;
};

type DesiredProjection = ProjectRequest["projection"];

type CompiledProjectionDraft = Omit<
  DesiredProjection,
  "generation" | "contentSha256"
>;

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
  installationByHostId: ReadonlyMap<
    string,
    StationPropagationTarget["stationInstallationId"]
  >,
): Effect.Effect<
  CompiledProjectionDraft,
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
    const intentSha256 = Schema.decodeUnknownEither(StationSha256)(
      snapshot.intentSha256,
    );
    if (Either.isLeft(intentSha256)) {
      return yield* invariant(
        "projection",
        "invalid-source-intent-hash",
        "canvas authority intent hash is not a canonical SHA-256",
      );
    }
    const body = yield* Effect.try({
      try: () =>
        compileStationPortfolioBody(
          snapshot.documents,
          installationByHostId,
        ),
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
      scope: "full",
      sourceCanvasGeneration: generation.right,
      sourceIntentSha256: intentSha256.right,
      body,
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
  session: StationPeerSession,
  target: StationPropagationTarget,
  current: StationProjectionReference | undefined,
  desired: DesiredProjection,
): Effect.Effect<
  StationProjectionSyncReceipt,
  StationPeerRequestError | StationPropagationInvariantError
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

  return session.request(
    ProjectRequest.make({
      protocol: STATION_API_PROTOCOL,
      op: "project",
      stationInstallationId: target.stationInstallationId,
      projection: {
        ...desired,
      },
    }),
  ).pipe(
    Effect.flatMap((response) =>
      ensureProjectionResult(desired, response)
    ),
  );
};

const synchronizeReport = (
  api: Context.Tag.Service<typeof StationApiService>,
  session: StationPeerSession,
  target: StationPropagationTarget,
): Effect.Effect<
  StationReportSyncReceipt,
  StationApiError | StationPeerRequestError | StationPropagationInvariantError
> =>
  Effect.gen(function* () {
    let outboundSent = 0;
    let inboundReceived = 0;
    let inboundAccepted = 0;
    let inboundIdempotent = 0;
    let inboundRejected = 0;
    let receivedThrough: ReadonlyArray<RouteCursor> = [];

    for (
      let round = 1;
      round <= STATION_PROPAGATION_MAX_REPORT_ROUNDS;
      round += 1
    ) {
      const request = yield* api.prepareReport(
        target.stationInstallationId,
      );
      const response = yield* session.request(request);
      const integrated = yield* api.acceptReportResponse(
        target.stationInstallationId,
        request,
        response,
      );

      outboundSent += request.batch.records.length;
      inboundReceived += response.batch.records.length;
      inboundAccepted += integrated.accepted;
      inboundIdempotent += integrated.idempotent;
      inboundRejected += integrated.rejected;
      receivedThrough = integrated.receivedThrough;

      if (!request.batch.hasMore && !integrated.peerHasMore) {
        return {
          rounds: round,
          outboundSent,
          inboundReceived,
          inboundAccepted,
          inboundIdempotent,
          inboundRejected,
          receivedThrough,
          hasMoreOutbound: false,
          hasMoreInbound: false,
        };
      }
    }

    return yield* invariant(
      "report",
      "report-round-limit",
      `Station report did not converge within ${STATION_PROPAGATION_MAX_REPORT_ROUNDS} rounds`,
    );
  }).pipe(Effect.withSpan("station.propagation.report"));

// S4-station: single canonical Context.Tag (effect@3.21). V4 → Context.Service.
export class StationPropagation extends Context.Tag(
  StationContextTagIds.propagation,
)<
  StationPropagation,
  {
    readonly synchronize: (
      target: StationPropagationTarget,
      session: StationPeerSession,
    ) => Effect.Effect<StationPropagationReceipt, StationPropagationError>;
  }
>() {}

export const StationPropagationLive = Layer.effect(
  StationPropagation,
  Effect.gen(function* () {
    const canvases = yield* CanvasesService;
    const repository = yield* StationRepository;
    const api = yield* StationApiService;
    const fleetTargets = yield* StationFleetTargetRepository;

    const synchronize = Effect.fn("StationPropagation.synchronize")(
      function* (
        target: StationPropagationTarget,
        session: StationPeerSession,
      ) {
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
        if (
          session.localInstallationId !== commandCenterInstallationId ||
          session.peerInstallationId !== target.stationInstallationId
        ) {
          return yield* invariant(
            "synchronize",
            "session-identity-mismatch",
            "Station session does not match the local Command Center and enrolled Remote",
          );
        }

        const status = yield* session.request(
          StatusRequest.make({
            protocol: STATION_API_PROTOCOL,
            op: "status",
          }),
        );
        if (status.installationId !== target.stationInstallationId) {
          return yield* invariant(
            "status",
            "station-identity-mismatch",
            "Remote status does not match the enrolled Station identity",
          );
        }
        if (status.configuration?.role !== "remote") {
          return yield* invariant(
            "status",
            "remote-configuration-required",
            "fleet propagation requires a configured Remote",
          );
        }
        if (status.configuration.hostId !== target.hostId) {
          return yield* invariant(
            "status",
            "station-host-mismatch",
            "Remote configuration host does not match the enrolled fleet route",
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
        if (!status.readiness.workControl) {
          return yield* invariant(
            "status",
            "work-control-unavailable",
            "Remote work control is not ready for propagation",
          );
        }
        if (!status.readiness.simulation) {
          return yield* invariant(
            "status",
            "simulation-unavailable",
            "Remote simulation is not ready for propagation",
          );
        }
        if (!status.readiness.session) {
          return yield* invariant(
            "status",
            "session-unavailable",
            "Remote persistent Station session is not ready",
          );
        }

        const [snapshot, enrolledTargets] = yield* Effect.all([
          canvases.authoritySnapshot(),
          fleetTargets.list,
        ]);
        const installationByHostId = new Map<
          string,
          StationPropagationTarget["stationInstallationId"]
        >([
          [
            localConfiguration.configuration.hostId,
            commandCenterInstallationId,
          ],
        ]);
        for (const enrolled of enrolledTargets) {
          installationByHostId.set(
            enrolled.hostId,
            enrolled.stationInstallationId,
          );
        }
        const compiled = yield* desiredProjection(
          snapshot,
          installationByHostId,
        );
        const desired = yield* repository.archiveProjection(compiled);
        const projection = yield* synchronizeProjection(
          session,
          target,
          status.projection,
          desired,
        );
        const report = yield* synchronizeReport(api, session, target);
        const finalStatus = yield* session.request(
          StatusRequest.make({
            protocol: STATION_API_PROTOCOL,
            op: "status",
          }),
        );
        if (
          finalStatus.installationId !== target.stationInstallationId
        ) {
          return yield* invariant(
            "status",
            "station-identity-mismatch",
            "Final Remote status does not match the enrolled Station identity",
          );
        }

        return {
          stationInstallationId: target.stationInstallationId,
          remoteStatus: finalStatus,
          projection,
          report,
        };
      },
    );

    return StationPropagation.of({ synchronize });
  }),
);
