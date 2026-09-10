import { Clock, Context, Effect, Result, Layer, Schema } from "effect";
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
import { resolveNodeHostId } from "@shared/station";
import type { StationTopologyObservation } from "@shared/station-status";
import { resolveSpec, roleOf } from "@shared/physics/kinds";
import { compileEdgeGrant, edgeKindIndex } from "@shared/canvas";
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
    reason: Schema.Literals(["command-center-role-required", "session-identity-mismatch",
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
    "report-round-limit",]),
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
  readonly topology: StationTopologyObservation;
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

export type DesiredProjection = ProjectRequest["projection"];

type CompiledProjectionDraft = Omit<
  DesiredProjection,
  "generation" | "contentSha256"
>;

export const summarizeStationProjectionTopology = (
  documents: CanvasAuthoritySnapshot["documents"],
  commandCenterHostId: string,
  targetHostId: string,
): StationTopologyObservation => {
  let nodeCount = 0;
  let edgeCount = 0;
  let actorCount = 0;
  let sinkCount = 0;
  let schedulerCount = 0;
  let targetNodeCount = 0;
  let targetActorCount = 0;
  let targetSinkCount = 0;
  let targetSchedulerCount = 0;
  let commandCenterNodeCount = 0;
  let otherStationNodeCount = 0;
  let targetInternalAccessEdgeCount = 0;
  let remoteActorToCommandCenterSinkEdgeCount = 0;
  let commandCenterActorToRemoteSinkEdgeCount = 0;
  let stationPeerEdgeCount = 0;
  let danglingEdgeCount = 0;

  for (const document of documents.values()) {
    const nodes = new Map(document.nodes.map((node) => [node.id, node] as const));
    nodeCount += document.nodes.length;
    edgeCount += document.edges.length;

    for (const node of document.nodes) {
      const hostId = resolveNodeHostId(node);
      const role = roleOf(resolveSpec({
        isGroup: node.type === "group",
        kind: node.ether?.entity?.kind,
      }));
      if (role === "actor") actorCount += 1;
      if (role === "sink") sinkCount += 1;
      if (role === "scheduler") schedulerCount += 1;
      if (hostId === targetHostId) {
        targetNodeCount += 1;
        if (role === "actor") targetActorCount += 1;
        if (role === "sink") targetSinkCount += 1;
        if (role === "scheduler") targetSchedulerCount += 1;
      } else if (hostId === commandCenterHostId) {
        commandCenterNodeCount += 1;
      } else {
        otherStationNodeCount += 1;
      }
    }

    const edgeKinds = edgeKindIndex(document);
    for (const edge of document.edges) {
      const from = nodes.get(edge.fromNode);
      const to = nodes.get(edge.toNode);
      if (from === undefined || to === undefined) {
        danglingEdgeCount += 1;
        continue;
      }
      const fromHost = resolveNodeHostId(from);
      const toHost = resolveNodeHostId(to);
      if (
        fromHost !== toHost &&
        fromHost !== commandCenterHostId &&
        toHost !== commandCenterHostId
      ) {
        stationPeerEdgeCount += 1;
      }
      const fromRole = roleOf(resolveSpec({
        isGroup: from.type === "group",
        kind: from.ether?.entity?.kind,
      }));
      const toRole = roleOf(resolveSpec({
        isGroup: to.type === "group",
        kind: to.ether?.entity?.kind,
      }));
      const actor = fromRole === "actor" ? from : toRole === "actor" ? to : undefined;
      const sink = fromRole === "sink" ? from : toRole === "sink" ? to : undefined;
      // An access relationship is one whose verb opens at least one port.
      if (
        actor === undefined ||
        sink === undefined ||
        (compileEdgeGrant(edge, edgeKinds)?.ports.length ?? 0) === 0
      ) continue;
      const actorHost = resolveNodeHostId(actor);
      const sinkHost = resolveNodeHostId(sink);
      if (actorHost === targetHostId && sinkHost === targetHostId) {
        targetInternalAccessEdgeCount += 1;
      } else if (
        actorHost === targetHostId && sinkHost === commandCenterHostId
      ) {
        remoteActorToCommandCenterSinkEdgeCount += 1;
      } else if (
        actorHost === commandCenterHostId && sinkHost === targetHostId
      ) {
        commandCenterActorToRemoteSinkEdgeCount += 1;
      }
    }
  }

  return {
    canvasCount: documents.size,
    nodeCount,
    edgeCount,
    actorCount,
    sinkCount,
    schedulerCount,
    targetNodeCount,
    targetActorCount,
    targetSinkCount,
    targetSchedulerCount,
    commandCenterNodeCount,
    otherStationNodeCount,
    targetInternalAccessEdgeCount,
    remoteActorToCommandCenterSinkEdgeCount,
    commandCenterActorToRemoteSinkEdgeCount,
    stationPeerEdgeCount,
    danglingEdgeCount,
  };
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
  installationByHostId: ReadonlyMap<
    string,
    StationPropagationTarget["stationInstallationId"]
  >,
  commandCenterHostId: string,
  targetHostId: string,
): Effect.Effect<
  { readonly draft: CompiledProjectionDraft; readonly topology: StationTopologyObservation },
  StationPortfolioError | StationPropagationInvariantError
> =>
  Effect.gen(function* () {
    const generation = Schema.decodeUnknownResult(LogicalSequence)(
      snapshot.generation,
    );
    if (Result.isFailure(generation)) {
      return yield* invariant(
        "projection",
        "invalid-generation",
        "canvas authority generation is not a canonical logical sequence",
      );
    }
    const intentSha256 = Schema.decodeUnknownResult(StationSha256)(
      snapshot.intentSha256,
    );
    if (Result.isFailure(intentSha256)) {
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
      draft: {
        scope: "full",
        sourceCanvasGeneration: generation.success,
        sourceIntentSha256: intentSha256.success,
        body,
        createdAt: new Date(now).toISOString(),
      },
      topology: summarizeStationProjectionTopology(
        snapshot.documents,
        commandCenterHostId,
        targetHostId,
      ),
    };
  });

const ensureProjectionResult = (
  desired: DesiredProjection,
  response: ProjectResponse,
): Effect.Effect<
  Omit<StationProjectionSyncReceipt, "topology">,
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
  topology: StationTopologyObservation,
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
        topology,
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
    Effect.map((receipt) => ({ ...receipt, topology })),
  );
};

const synchronizeReport = (
  api: Context.Service.Shape<typeof StationApiService>,
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

// Station plane: canonical Context.Service (effect v4).
export class StationPropagation extends Context.Service<StationPropagation,
  {
    readonly synchronize: (
      target: StationPropagationTarget,
      session: StationPeerSession,
    ) => Effect.Effect<StationPropagationReceipt, StationPropagationError>;
    /**
     * Compile and archive the projection this Command Center currently wants
     * the target host to hold, from committed canvas authority only. The
     * returned generation and content hash are exactly what the next
     * synchronize sends (archiving is idempotent for identical content), so
     * callers can await that precise acknowledgement.
     */
    readonly desiredProjectionForHost: (
      targetHostId: string,
    ) => Effect.Effect<DesiredProjection, StationPropagationError>;
  }>()(StationContextTagIds.propagation) {}

export const StationPropagationLive = Layer.effect(
  StationPropagation,
  Effect.gen(function* () {
    const canvases = yield* CanvasesService;
    const repository = yield* StationRepository;
    const api = yield* StationApiService;
    const fleetTargets = yield* StationFleetTargetRepository;

    /**
     * One compile path for synchronize and for barrier callers: committed
     * canvas authority -> compiled portfolio -> archived projection identity.
     */
    const compileDesired = Effect.fn("StationPropagation.compileDesired")(
      function* (
        commandCenterHostId: string,
        commandCenterInstallationId:
          StationPropagationTarget["stationInstallationId"],
        targetHostId: string,
      ) {
        const [snapshot, enrolledTargets] = yield* Effect.all([
          canvases.authoritySnapshot(),
          fleetTargets.list,
        ]);
        const installationByHostId = new Map<
          string,
          StationPropagationTarget["stationInstallationId"]
        >([
          [commandCenterHostId, commandCenterInstallationId],
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
          commandCenterHostId,
          targetHostId,
        );
        const desired = yield* repository.archiveProjection(compiled.draft);
        return { desired, topology: compiled.topology };
      },
    );

    const desiredProjectionForHost = Effect.fn(
      "StationPropagation.desiredProjectionForHost",
    )(function* (targetHostId: string) {
      const commandCenterInstallationId = yield* repository.installationId;
      const localConfiguration = yield* repository.configuration;
      if (localConfiguration?.configuration.role !== "command-center") {
        return yield* invariant(
          "desired-projection",
          "command-center-role-required",
          "only a configured Command Center compiles fleet projections",
        );
      }
      const { desired } = yield* compileDesired(
        localConfiguration.configuration.hostId,
        commandCenterInstallationId,
        targetHostId,
      );
      return desired;
    });

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

        const { desired, topology } = yield* compileDesired(
          localConfiguration.configuration.hostId,
          commandCenterInstallationId,
          target.hostId,
        );
        const projection = yield* synchronizeProjection(
          session,
          target,
          status.projection,
          desired,
          topology,
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

    return StationPropagation.of({ synchronize, desiredProjectionForHost });
  }),
);
