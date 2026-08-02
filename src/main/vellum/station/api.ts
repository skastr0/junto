import { Context, Effect, Either, Layer, Schema } from "effect";
import type { CanvasDoc, CanvasNode } from "@shared/canvas";
import type { InstallationId as InstallationIdValue } from "@shared/installation-id";
import { remoteLeaseState } from "../license/remote-lease-state";
import { StationContextTagIds } from "./context-services";
import {
  LogicalSequence,
  ReportBatch,
  ReportRequest,
  ReportResponse,
  STATION_API_MAX_REPORT_BATCH_BYTES,
  STATION_API_MAX_RECORDS_PER_REPORT,
  STATION_API_PROTOCOL,
  StationSha256,
  StatusResponse,
  decideReportBatchAdmission,
  reportResponseSwapsDirection,
  type ProjectRequest,
  type ProjectResponse,
  type ReportBatch as ReportBatchValue,
  type ReportRequest as ReportRequestValue,
  type ReportResponse as ReportResponseValue,
  type StationApiRequest,
  type StationApiResponse,
  type StationApiStatusState,
  type StationReadiness,
} from "@shared/station-api";
import {
  WORK_PROTOCOL_MAX_RECORD_BYTES,
  type ActorRef,
  type MessageAppendDestination,
  type RouteCursor,
  type SinkRef,
  type WorkCommand,
  type WorkFact,
  type WorkRecord,
  type WorkRejectionReason,
  type WorkRoute,
} from "@shared/work-protocol";
import type { WorkOpName } from "@shared/work-control";
import {
  resolveNodeHostId,
  type StationRole,
} from "@shared/station";
import {
  CanvasesService,
  type CanvasError,
} from "../canvases";
import {
  WorkRepository,
  type AcceptRecordsResult,
  type WorkAuthorityError,
  type WorkCommandAuthorization,
  type WorkFactAuthorization,
  type WorkRepositoryError,
  type WorkReplicationError,
} from "../work/repository";
import {
  admitWorkTarget,
  nodeKind,
} from "../work/authz";
import {
  StationFleetTargetRepository,
  type StationFleetTargetRepositoryError,
} from "./fleet-target-repository";
import {
  compileActorSeatRegistry,
  type ProjectedActorSeat,
} from "./actor-seat-compiler";
import { decodeStationPortfolioBody } from "./portfolio";
import {
  StationRepository,
  type StationConfigurationRecord,
  type StationRepositoryError,
  type StationStatusFacts,
} from "./repository";

const strictDecode = { onExcessProperty: "error" } as const;
const ROUTE_PAGE_LIMIT = STATION_API_MAX_RECORDS_PER_REPORT + 1;
const REPORT_RESPONSE_FIXED_RESERVE_BYTES =
  WORK_PROTOCOL_MAX_RECORD_BYTES;
const REPORT_RESPONSE_BYTES_PER_COMMAND =
  WORK_PROTOCOL_MAX_RECORD_BYTES * 2;

export type StationApiPeerContext =
  | {
      /**
       * The fixed helper is running on a Command Center-opened OpenSSH
       * connection. OpenSSH does not channel-bind the CC InstallationId into
       * Electron main; pairing and every request carry and validate it.
       */
      readonly _tag: "command-center-route";
    }
  | {
      /** A Command Center scoped session for this enrolled Remote. */
      readonly _tag: "enrolled-remote";
      readonly installationId: InstallationIdValue;
    };

export class StationApiInvariantError extends Schema.TaggedError<StationApiInvariantError>()(
  "StationApiInvariantError",
  {
    operation: Schema.String,
    reason: Schema.Literal(
      "pairing-required",
      "configuration-required",
      "projection-required",
      "local-role-mismatch",
      "peer-role-mismatch",
      "peer-identity-mismatch",
      "report-direction-mismatch",
      "report-response-mismatch",
      "report-response-command",
      "topology-invalid",
    ),
    message: Schema.String,
  },
) {}

export class StationApiDependencyError extends Schema.TaggedError<StationApiDependencyError>()(
  "StationApiDependencyError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.Defect,
  },
) {}

export type StationApiError =
  | StationRepositoryError
  | StationFleetTargetRepositoryError
  | CanvasError
  | WorkRepositoryError
  | WorkAuthorityError
  | WorkReplicationError
  | StationApiInvariantError
  | StationApiDependencyError;

export type ReportIntegrationResult = {
  readonly accepted: number;
  readonly idempotent: number;
  readonly rejected: number;
  readonly receivedThrough: ReadonlyArray<RouteCursor>;
  readonly peerHasMore: boolean;
};

type CapturedWorkTopology = {
  readonly localInstallationId: InstallationIdValue;
  readonly peerInstallationId: InstallationIdValue;
  readonly localRole: "command-center" | "remote";
  readonly localHostId: string;
  readonly documents: ReadonlyMap<string, CanvasDoc>;
  readonly actorSeats: ReadonlyArray<ProjectedActorSeat>;
  readonly installationByHostId: ReadonlyMap<string, InstallationIdValue>;
};

type StationWorkAdmission = {
  readonly authorizeCommand: (
    command: WorkCommand,
  ) => WorkCommandAuthorization;
  readonly authorizeFact: (
    fact: WorkFact,
  ) => WorkFactAuthorization;
};

const invariant = (
  operation: string,
  reason: StationApiInvariantError["reason"],
  message: string,
): StationApiInvariantError =>
  StationApiInvariantError.make({ operation, reason, message });

const dependency = (
  operation: string,
  message: string,
  cause: unknown,
): StationApiDependencyError =>
  StationApiDependencyError.make({ operation, message, cause });

const sameRef = (
  left: Pick<ActorRef, "canvasName" | "nodeId">,
  right: Pick<ActorRef, "canvasName" | "nodeId">,
): boolean =>
  left.canvasName === right.canvasName && left.nodeId === right.nodeId;

const routeKey = (
  route: Pick<RouteCursor, "eventHome" | "entityHome">,
): string => `${route.eventHome}\u0000${route.entityHome}`;

const compareCodeUnits = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const recordKey = (record: WorkRecord): string =>
  `${routeKey(record.id.route)}\u0000${record.id.seq}`;

const mergeCursors = (
  ...groups: ReadonlyArray<ReadonlyArray<RouteCursor>>
): ReadonlyArray<RouteCursor> => {
  const merged = new Map<string, RouteCursor>();
  for (const cursor of groups.flat()) {
    const key = routeKey(cursor);
    const current = merged.get(key);
    if (
      current === undefined ||
      BigInt(cursor.through) > BigInt(current.through)
    ) {
      merged.set(key, cursor);
    }
  }
  return [...merged.values()].sort((left, right) =>
    compareCodeUnits(routeKey(left), routeKey(right))
  );
};

export type StationReportRouteSelection = {
  /**
   * A Remote advertises its own durable facts to Command Center. Command
   * Center never broadcasts its local fact lane to every Remote.
   */
  readonly facts: WorkRoute | undefined;
  /** Live commands are always the exact local -> admitted peer route. */
  readonly commands: WorkRoute;
};

export const selectStationReportRoutes = (
  localRole: StationRole,
  localInstallationId: InstallationIdValue,
  peerInstallationId: InstallationIdValue,
): StationReportRouteSelection => ({
  facts:
    localRole === "remote"
      ? {
          eventHome: localInstallationId,
          entityHome: localInstallationId,
        }
      : undefined,
  commands: {
    eventHome: localInstallationId,
    entityHome: peerInstallationId,
  },
});

const peerReceivedCursors = (
  facts: StationStatusFacts,
  peerInstallationId: InstallationIdValue,
): ReadonlyArray<RouteCursor> =>
  facts.receivedThrough.filter(
    (cursor) => cursor.eventHome === peerInstallationId,
  );

const peerAcknowledgement = (
  facts: StationStatusFacts,
  peerInstallationId: InstallationIdValue,
  eventHome: InstallationIdValue,
  entityHome: InstallationIdValue,
): RouteCursor | undefined =>
  facts.peerAcknowledgedThrough.find(
    (entry) =>
      entry.peerInstallationId === peerInstallationId &&
      entry.acknowledgement.eventHome === eventHome &&
      entry.acknowledgement.entityHome === entityHome,
  )?.acknowledgement;

const expectedSinkKind = (
  kind: WorkRecord["item"]["kind"],
): string | undefined => {
  switch (kind) {
    case "proposal":
      return "task";
    case "task":
      return "task";
    case "request":
      return "requests";
    case "message":
      // Factory physics permits msg.send to an actor inbox and to the logical
      // sinks that expose mailbox ports. The port check below is authoritative.
      return undefined;
    case "artifact":
      return "artifacts";
    case "delivery":
      return undefined;
    case "topic":
    case "post":
      return "board";
  }
};

const operationForActor = (
  operation: WorkRecord["operation"],
  deliveredKind?: WorkRecord["item"]["kind"],
): WorkOpName | undefined => {
  switch (operation) {
    case "proposal.create":
      return "tasks.create";
    case "proposal.approve":
    case "proposal.reject":
      return undefined;
    case "task.claim":
      return "tasks.claim";
    case "task.describe":
    case "task.transition":
      return "tasks.update";
    case "request.create":
    case "request.resolve":
      return "request.escalate";
    case "artifact.publish":
      return "artifact.publish";
    case "delivery.accepted":
      return deliveredKind === "task"
        ? "tasks.claim"
        : deliveredKind === "request"
          ? "request.escalate"
          : deliveredKind === "artifact"
            ? "artifact.publish"
            : deliveredKind === "message"
              ? "msg.list"
              : undefined;
    case "task.create":
    case "message.append":
    case "board.topic.create":
    case "board.post.append":
      return undefined;
  }
};

const rejected = (
  reason: WorkRejectionReason,
  message: string,
): WorkCommandAuthorization => ({
  _tag: "rejected",
  reason,
  message,
});

const admitted = (): WorkCommandAuthorization => ({ _tag: "admitted" });

const findSink = (
  topology: CapturedWorkTopology,
  sink: SinkRef,
  itemKind: WorkRecord["item"]["kind"],
): CanvasNode | WorkCommandAuthorization => {
  const document = topology.documents.get(sink.canvasName);
  if (document === undefined) {
    return rejected(
      "projection-conflict",
      `canvas ${JSON.stringify(sink.canvasName)} is absent from installed intent`,
    );
  }
  const node = document.nodes.find((candidate) => candidate.id === sink.nodeId);
  if (node === undefined) {
    return rejected(
      "missing-entity",
      `sink ${JSON.stringify(`${sink.canvasName}/${sink.nodeId}`)} is absent from installed intent`,
    );
  }
  const expected = expectedSinkKind(itemKind);
  if (expected !== undefined && nodeKind(node) !== expected) {
    return rejected(
      "capability-denied",
      `node ${JSON.stringify(`${sink.canvasName}/${sink.nodeId}`)} is not a ${expected} sink`,
    );
  }
  return node;
};

const authorizeMessageDestination = (
  sink: CanvasNode,
  destination: MessageAppendDestination,
): WorkCommandAuthorization => {
  const actual = nodeKind(sink);
  const expected =
    destination.kind === "mailbox"
      ? "agent"
      : destination.kind === "task"
        ? "task"
        : "requests";
  return actual === expected
    ? admitted()
    : rejected(
        "capability-denied",
        `${destination.kind} message destination does not match projected ${JSON.stringify(actual)} node`,
      );
};

const authorizeArtifactTaskProjection = (
  topology: CapturedWorkTopology,
  fact: WorkFact,
): WorkFactAuthorization => {
  if (
    fact.body.operation !== "artifact.publish" ||
    fact.body.artifact.task === undefined
  ) {
    return admitted();
  }
  const taskSink = findSink(
    topology,
    fact.body.artifact.task.sink,
    "task",
  );
  return "_tag" in taskSink ? taskSink : admitted();
};

const seatForRef = (
  topology: CapturedWorkTopology,
  actor: ActorRef,
): ProjectedActorSeat | undefined =>
  topology.actorSeats.find(
    (seat) =>
      seat.seatId === actor.seatId &&
      seat.refs.some((ref) => sameRef(ref, actor)),
  );

const actorRefForSeat = (
  topology: CapturedWorkTopology,
  seatId: ActorRef["seatId"],
  canvasName: string,
): ActorRef | undefined => {
  const seat = topology.actorSeats.find(
    (candidate) => candidate.seatId === seatId,
  );
  const ref = seat?.refs.find(
    (candidate) => candidate.canvasName === canvasName,
  );
  return seat === undefined || ref === undefined
    ? undefined
    : {
        seatId: seat.seatId,
        canvasName: ref.canvasName,
        nodeId: ref.nodeId,
      };
};

const authorizeActor = (
  topology: CapturedWorkTopology,
  actor: ActorRef,
  expectedAuthority: InstallationIdValue,
  sink: SinkRef,
  operation: WorkOpName,
): WorkCommandAuthorization => {
  const seat = seatForRef(topology, actor);
  if (seat === undefined) {
    return rejected(
      "locality-mismatch",
      `actor ${JSON.stringify(`${actor.canvasName}/${actor.nodeId}`)} does not resolve to its projected seat`,
    );
  }
  if (seat.authorityInstallationId !== expectedAuthority) {
    return rejected(
      "locality-mismatch",
      `actor seat ${JSON.stringify(actor.seatId)} is not homed on the required installation`,
    );
  }
  if (actor.canvasName !== sink.canvasName) {
    return rejected(
      "capability-denied",
      "actor and sink are on different canvas capability surfaces",
    );
  }
  const document = topology.documents.get(sink.canvasName);
  if (document === undefined) {
    return rejected(
      "projection-conflict",
      "actor canvas is absent from installed intent",
    );
  }
  const decision = admitWorkTarget(
    document,
    actor.nodeId,
    sink.nodeId,
    operation,
  );
  return Either.isRight(decision)
    ? admitted()
    : rejected(
        "capability-denied",
        decision.left.message,
      );
};

const sinkAuthority = (
  topology: CapturedWorkTopology,
  sink: CanvasNode,
): InstallationIdValue | undefined => {
  const hostId = resolveNodeHostId(sink);
  const exact = topology.installationByHostId.get(hostId);
  if (exact !== undefined) return exact;

  // A Remote intentionally receives no peer-Remote topology. Under its
  // complete projection, the only non-local authority it may accept records
  // from is its paired Command Center.
  return topology.localRole === "remote" &&
      hostId !== topology.localHostId
    ? topology.peerInstallationId
    : undefined;
};

const actorFromFact = (
  topology: CapturedWorkTopology,
  fact: WorkFact,
): ActorRef | undefined => {
  switch (fact.body.operation) {
    case "proposal.create":
      return fact.body.proposal.proposedBy;
    case "proposal.approve":
    case "proposal.reject":
      return undefined;
    case "task.claim":
      return fact.body.claimedBy;
    case "task.describe":
    case "task.transition":
      return fact.body.task.claimedBy === undefined
        ? undefined
        : actorRefForSeat(
            topology,
            fact.body.task.claimedBy,
            fact.item.sink.canvasName,
          );
    case "request.create":
    case "request.resolve":
      return fact.body.request.claimedBy === undefined
        ? undefined
        : actorRefForSeat(
            topology,
            fact.body.request.claimedBy,
            fact.item.sink.canvasName,
          );
    case "artifact.publish":
      return fact.body.publishedBy;
    case "delivery.accepted":
      return fact.body.receipt.actor;
    case "task.create":
    case "message.append":
    case "board.topic.create":
    case "board.post.append":
      return undefined;
  }
};

const authorizeFactRoute = (
  topology: CapturedWorkTopology,
  fact: WorkFact,
): WorkFactAuthorization => {
  const sender = fact.id.route.eventHome;
  return sender === topology.peerInstallationId &&
      fact.id.route.entityHome === topology.peerInstallationId
    ? admitted()
    : rejected(
        "authority-mismatch",
        "fact route does not belong to the admitted peer authority",
      );
};

/**
 * Capture mutable intent before entering WorkRepository's SQLite transaction,
 * then hand it only pure admission callbacks. No callback yields, reads
 * SQLite, consults a clock, or reaches a transport.
 */
export const makeStationWorkAdmission = (
  topology: CapturedWorkTopology,
): StationWorkAdmission => {
  const authorizeCommand = (
    command: WorkCommand,
  ): WorkCommandAuthorization => {
    const sink = findSink(topology, command.item.sink, command.item.kind);
    if ("_tag" in sink) return sink;
    if (command.body.operation === "message.append") {
      const destination = authorizeMessageDestination(
        sink,
        command.body.destination,
      );
      if (destination._tag === "rejected") return destination;
    }
    if (
      command.id.route.eventHome !== topology.peerInstallationId ||
      command.id.route.entityHome !== topology.localInstallationId
    ) {
      return rejected(
        "authority-mismatch",
        "command route does not cross from the admitted peer to this installation",
      );
    }

    if (topology.localRole === "command-center") {
      if (command.body.operation === "message.append") {
        return authorizeActor(
          topology,
          command.body.sentBy,
          topology.peerInstallationId,
          command.item.sink,
          "msg.send",
        );
      }
      if (command.body.operation === "proposal.create") {
        return sinkAuthority(topology, sink) !== topology.localInstallationId
          ? rejected(
              "locality-mismatch",
              "proposal command targets a queue not homed on Command Center",
            )
          : authorizeActor(
              topology,
              command.body.proposal.proposedBy,
              topology.peerInstallationId,
              command.item.sink,
              "tasks.create",
            );
      }
      if (
        command.body.operation === "board.topic.create" ||
        command.body.operation === "board.post.append"
      ) {
        // Board is a CC-homed global sink (mailbox residency). Remote agents
        // enqueue actor-authored writes; operator authoring stays CC-local.
        // Ports stay distinct: create_topic vs post (attenuation must hold).
        const author = command.body.createdBy;
        if (
          author.kind !== "actor" ||
          author.seatId === undefined ||
          author.nodeId === undefined
        ) {
          return rejected(
            "authority-mismatch",
            "remote board writes require an actor author with seat and node",
          );
        }
        return authorizeActor(
          topology,
          {
            seatId: author.seatId,
            canvasName: command.item.sink.canvasName,
            nodeId: author.nodeId,
          },
          topology.peerInstallationId,
          command.item.sink,
          command.body.operation === "board.topic.create"
            ? "board.create_topic"
            : "board.post",
        );
      }
      return rejected(
        "authority-mismatch",
        `${command.body.operation} is Command Center intent and cannot be commanded by a Remote`,
      );
    }

    switch (command.body.operation) {
      case "proposal.approve":
      case "proposal.reject":
        return admitted();
      case "proposal.create":
        return rejected(
          "authority-mismatch",
          "a Remote cannot command another Remote to create a proposal",
        );
      case "task.claim": {
        if (
          command.body.targetHome !== topology.localInstallationId ||
          command.body.sourceQueueHome !== topology.peerInstallationId
        ) {
          return rejected(
            "authority-mismatch",
            "task claim does not cross from the admitted peer to this installation",
          );
        }
        const declaredSinkHome = sinkAuthority(topology, sink);
        if (declaredSinkHome !== command.body.sourceQueueHome) {
          return rejected(
            "locality-mismatch",
            "task claim source queue does not match projected sink authority",
          );
        }
        return authorizeActor(
          topology,
          command.body.actor,
          topology.localInstallationId,
          command.item.sink,
          "tasks.claim",
        );
      }
      case "task.create":
        return sinkAuthority(topology, sink) === topology.localInstallationId
          ? admitted()
          : rejected(
              "locality-mismatch",
              "task creation command targets a queue not homed on this installation",
            );
      case "task.describe":
      case "task.transition":
      case "request.resolve":
        // Only the admitted Command Center can reach this Remote branch. The
        // repository proves entityHome and the exact local predecessor; the
        // sink may intentionally be CC-placed while its claimed/request row is
        // single-homed here.
        return admitted();
      case "request.create":
      case "artifact.publish":
      case "delivery.accepted":
      case "board.topic.create":
      case "board.post.append":
        return rejected(
          "locality-mismatch",
          `${command.body.operation} must originate as a local actor fact or CC-homed command`,
        );
      case "message.append": {
        if (command.body.destination.kind === "mailbox") {
          return rejected(
            "authority-mismatch",
            "actor mailboxes remain Command Center-homed",
          );
        }
        return authorizeActor(
          topology,
          command.body.sentBy,
          topology.peerInstallationId,
          command.item.sink,
          "msg.send",
        );
      }
    }
  };

  const authorizeFact = (fact: WorkFact): WorkFactAuthorization => {
    const route = authorizeFactRoute(topology, fact);
    if (route._tag === "rejected") return route;
    const sink = findSink(topology, fact.item.sink, fact.item.kind);
    if ("_tag" in sink) return sink;
    if (fact.body.operation === "message.append") {
      const destination = authorizeMessageDestination(
        sink,
        fact.body.destination,
      );
      if (destination._tag === "rejected") return destination;
    }
    if (fact.body.operation === "artifact.publish") {
      const taskProjection = authorizeArtifactTaskProjection(
        topology,
        fact,
      );
      if (taskProjection._tag === "rejected") return taskProjection;
    }
    const sender = fact.id.route.eventHome;

    if (topology.localRole === "remote") {
      if (fact.body.operation === "message.append") {
        return authorizeActor(
            topology,
            fact.body.sentBy,
            topology.localInstallationId,
            fact.item.sink,
            "msg.send",
          );
      }
      // Remote accepts only command-correlated facts from CC (applied
      // disposition path). CC-homed board/mailbox material rows are not
      // rematerialized on Remote — see WorkRepository acceptRecords.
      return fact.basis.kind === "command"
        ? admitted()
        : rejected(
          "authority-mismatch",
          `Command Center may return only command-correlated facts to a Remote, not ${fact.body.operation}`,
        );
    }

    if (fact.body.operation === "message.append") {
      return fact.body.destination.kind === "mailbox"
        ? rejected(
            "authority-mismatch",
            "mailbox material state is Command Center-homed, never emitted by a Remote",
          )
        : authorizeActor(
            topology,
            fact.body.sentBy,
            sender,
            fact.item.sink,
            "msg.send",
          );
    }

    if (fact.body.operation === "task.create") {
      return sinkAuthority(topology, sink) === sender
        ? admitted()
        : rejected(
            "locality-mismatch",
            "submitted task fact does not come from the projected queue authority",
          );
    }

    const actor = actorFromFact(topology, fact);
    if (actor === undefined) {
      if (
        (fact.body.operation === "task.describe" ||
          fact.body.operation === "task.transition") &&
        fact.body.task.claimedBy === undefined &&
        sinkAuthority(topology, sink) === sender
      ) {
        return admitted();
      }
      return rejected(
        "locality-mismatch",
        `${fact.body.operation} does not resolve to a projected actor seat`,
      );
    }

    const deliveredKind =
      fact.body.operation === "delivery.accepted"
        ? fact.body.receipt.deliveredItem.kind
        : undefined;
    const operation = operationForActor(fact.operation, deliveredKind);
    return operation === undefined
      ? rejected(
          "capability-denied",
          `no capability port represents ${fact.operation}`,
        )
      : authorizeActor(
          topology,
          actor,
          sender,
          fact.item.sink,
          operation,
        );
  };

  return { authorizeCommand, authorizeFact };
};

const projectionBasisKey = (
  basis: Extract<WorkFact["basis"], { readonly kind: "projected-intent" }>,
): string => `${basis.generation}\u0000${basis.contentSha256}`;

const topologyFromHistoricalProjection = (
  current: CapturedWorkTopology,
  body: string,
): Effect.Effect<CapturedWorkTopology, StationApiError> =>
  Effect.gen(function* () {
    const portfolio = yield* Effect.try({
      try: () => decodeStationPortfolioBody(body),
      catch: (cause) =>
        dependency(
          "report-topology",
          "historical Station projection could not be decoded",
          cause,
        ),
    });
    const installationByHostId =
      new Map<string, InstallationIdValue>([
        [current.localHostId, current.localInstallationId],
      ]);
    for (const seat of portfolio.actorSeats) {
      const established = installationByHostId.get(seat.hostId);
      if (
        established !== undefined &&
        established !== seat.authorityInstallationId
      ) {
        return yield* invariant(
          "report",
          "topology-invalid",
          `historical host ${JSON.stringify(seat.hostId)} resolves to conflicting installations`,
        );
      }
      installationByHostId.set(
        seat.hostId,
        seat.authorityInstallationId,
      );
    }
    return {
      ...current,
      documents: portfolio.documents,
      actorSeats: portfolio.actorSeats,
      installationByHostId,
    };
  });

/**
 * New commands are judged against current intent. Facts are different:
 * projected facts name the immutable projection that admitted their action,
 * while command facts name the exact delegated command enforced inside the
 * WorkRepository transaction.
 */
const historicalFactAuthorization = (
  current: CapturedWorkTopology,
  projected: ReadonlyMap<string, StationWorkAdmission>,
): ((fact: WorkFact) => WorkFactAuthorization) =>
  (fact) => {
    const route = authorizeFactRoute(current, fact);
    if (route._tag === "rejected") return route;
    switch (fact.basis.kind) {
      case "command":
        return admitted();
      case "authorial-intent":
        return rejected(
          "authority-mismatch",
          "authorial Command Center facts are not replicated to a Station peer",
        );
      case "projected-intent": {
        if (current.localRole !== "command-center") {
          return rejected(
            "authority-mismatch",
            "only Command Center accepts a Remote projected-intent fact",
          );
        }
        const admission = projected.get(projectionBasisKey(fact.basis));
        return admission === undefined
          ? rejected(
              "projection-conflict",
              "fact names no immutable projection retained by this Command Center",
            )
          : admission.authorizeFact(fact);
      }
    }
  };

const loadHistoricalFactAdmissions = (
  repository: Context.Tag.Service<typeof StationRepository>,
  topology: CapturedWorkTopology,
  records: ReadonlyArray<WorkRecord>,
): Effect.Effect<
  ReadonlyMap<string, StationWorkAdmission>,
  StationApiError
> =>
  Effect.gen(function* () {
    const references = new Map<
      string,
      Extract<
        WorkFact["basis"],
        { readonly kind: "projected-intent" }
      >
    >();
    for (const record of records) {
      if (
        record.recordType === "fact" &&
        record.basis.kind === "projected-intent"
      ) {
        references.set(projectionBasisKey(record.basis), record.basis);
      }
    }
    const admissions = new Map<string, StationWorkAdmission>();
    for (const [key, reference] of references) {
      const projection = yield* repository.projectionByReference({
        generation: Schema.decodeUnknownSync(LogicalSequence)(
          reference.generation,
        ),
        contentSha256: Schema.decodeUnknownSync(StationSha256)(
          reference.contentSha256,
        ),
      });
      if (projection === undefined) continue;
      const historical = yield* topologyFromHistoricalProjection(
        topology,
        projection.body,
      );
      admissions.set(key, makeStationWorkAdmission(historical));
    }
    return admissions;
  });

const stationApiStatusState = (
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
      readiness.simulation &&
      readiness.session
    ? "ready"
    : "degraded";
};

const requireRemoteInbound = (
  operation: string,
  peer: StationApiPeerContext,
): Effect.Effect<void, StationApiInvariantError> =>
  peer._tag === "command-center-route"
    ? Effect.void
    : invariant(
        operation,
        "peer-role-mismatch",
        `${operation} may be initiated only by Command Center`,
      );

const requireReportIdentity = (
  request: ReportRequestValue,
  localInstallationId: InstallationIdValue,
  peerInstallationId: InstallationIdValue,
): Effect.Effect<void, StationApiInvariantError> =>
  request.senderInstallationId === peerInstallationId &&
    request.targetInstallationId === localInstallationId
    ? Effect.void
    : invariant(
        "report",
        "report-direction-mismatch",
        "report sender/target do not match this admitted peer session",
      );

const reportBatch = (
  records: ReadonlyArray<WorkRecord>,
  acknowledge: ReadonlyArray<RouteCursor>,
  hasMore: boolean,
): ReportBatchValue =>
  Schema.decodeUnknownSync(ReportBatch, strictDecode)({
    records,
    acknowledge,
    hasMore,
  });

/**
 * Reserve the worst-case mandatory response before a command enters a page.
 *
 * Any admitted command can emit one maximum-size fact and one maximum-size
 * disposition. One additional record-sized reserve covers the response
 * envelope, cumulative route acknowledgements, and JSON array separators.
 * Actual response paging remains governed by ReportBatch admission.
 */
export const mandatoryReportResponseReservationBytes = (
  records: ReadonlyArray<WorkRecord>,
): number =>
  REPORT_RESPONSE_FIXED_RESERVE_BYTES +
  records.reduce(
    (bytes, record) =>
      bytes +
      (record.recordType === "command"
        ? REPORT_RESPONSE_BYTES_PER_COMMAND
        : 0),
    0,
  );

const admitTransactionalResponse = (
  existingAcknowledge: ReadonlyArray<RouteCursor>,
) =>
  (candidate: {
    readonly emitted: ReadonlyArray<WorkRecord>;
    readonly acknowledge: ReadonlyArray<RouteCursor>;
  }):
    | { readonly _tag: "admitted" }
    | { readonly _tag: "rejected"; readonly message: string } => {
    const decision = decideReportBatchAdmission({
      records: candidate.emitted,
      acknowledge: mergeCursors(
        existingAcknowledge,
        candidate.acknowledge,
      ),
      hasMore: false,
    });
    return decision._tag === "admitted"
      ? { _tag: "admitted" }
      : {
          _tag: "rejected",
          message:
            `mandatory report response violates ${decision._tag}`,
        };
  };

const captureTopology = (
  repository: Context.Tag.Service<typeof StationRepository>,
  canvases: Context.Tag.Service<typeof CanvasesService>,
  fleetTargets: Context.Tag.Service<typeof StationFleetTargetRepository>,
  configuration: StationConfigurationRecord,
  localInstallationId: InstallationIdValue,
  peerInstallationId: InstallationIdValue,
): Effect.Effect<CapturedWorkTopology, StationApiError> =>
  Effect.gen(function* () {
    if (configuration.configuration.role === "remote") {
      const projection = yield* repository.projection;
      if (projection === undefined) {
        return yield* invariant(
          "report",
          "projection-required",
          "Remote work exchange requires an installed projection",
        );
      }
      const portfolio = yield* Effect.try({
        try: () => decodeStationPortfolioBody(projection.body),
        catch: (cause) =>
          dependency(
            "report-topology",
            "installed Remote projection could not be decoded",
            cause,
          ),
      });
      const installationByHostId =
        new Map<string, InstallationIdValue>([
          [
            configuration.configuration.hostId,
            localInstallationId,
          ],
        ]);
      for (const seat of portfolio.actorSeats) {
        const established = installationByHostId.get(seat.hostId);
        if (
          established !== undefined &&
          established !== seat.authorityInstallationId
        ) {
          return yield* invariant(
            "report",
            "topology-invalid",
            `host ${JSON.stringify(seat.hostId)} resolves to conflicting installations`,
          );
        }
        installationByHostId.set(
          seat.hostId,
          seat.authorityInstallationId,
        );
      }
      return {
        localInstallationId,
        peerInstallationId,
        localRole: "remote" as const,
        localHostId: configuration.configuration.hostId,
        documents: portfolio.documents,
        actorSeats: portfolio.actorSeats,
        installationByHostId,
      };
    }

    const [authority, targets] = yield* Effect.all([
      canvases.authoritySnapshot(),
      fleetTargets.list,
    ]);
    const installationByHostId =
      new Map<string, InstallationIdValue>([
        [
          configuration.configuration.hostId,
          localInstallationId,
        ],
      ]);
    for (const target of targets) {
      const established = installationByHostId.get(target.hostId);
      if (
        established !== undefined &&
        established !== target.stationInstallationId
      ) {
        return yield* invariant(
          "report",
          "topology-invalid",
          `host ${JSON.stringify(target.hostId)} resolves to conflicting installations`,
        );
      }
      installationByHostId.set(
        target.hostId,
        target.stationInstallationId,
      );
    }
    if (
      !targets.some(
        (target) =>
          target.stationInstallationId === peerInstallationId,
      )
    ) {
      return yield* invariant(
        "report",
        "peer-identity-mismatch",
        "report peer is not an active enrolled Remote",
      );
    }
    const actorSeats = yield* Effect.try({
      try: () =>
        compileActorSeatRegistry(
          authority.documents,
          installationByHostId,
        ),
      catch: (cause) =>
        dependency(
          "report-topology",
          "Command Center actor topology could not be compiled",
          cause,
        ),
    });
    return {
      localInstallationId,
      peerInstallationId,
      localRole: "command-center" as const,
      localHostId: configuration.configuration.hostId,
      documents: authority.documents,
      actorSeats,
      installationByHostId,
    };
  });

export const pageStationReport = (
  work: Context.Tag.Service<typeof WorkRepository>,
  facts: StationStatusFacts,
  localInstallationId: InstallationIdValue,
  peerInstallationId: InstallationIdValue,
  acknowledge: ReadonlyArray<RouteCursor>,
  mandatory: ReadonlyArray<WorkRecord>,
  localRole: StationRole,
  includeCommands: boolean,
): Effect.Effect<ReportBatchValue, StationApiError> =>
  Effect.gen(function* () {
    const routes = selectStationReportRoutes(
      localRole,
      localInstallationId,
      peerInstallationId,
    );
    const localAck =
      routes.facts === undefined
        ? undefined
        : peerAcknowledgement(
            facts,
            peerInstallationId,
            routes.facts.eventHome,
            routes.facts.entityHome,
          );
    const peerAck = peerAcknowledgement(
      facts,
      peerInstallationId,
      routes.commands.eventHome,
      routes.commands.entityHome,
    );
    const [localRecords, commandRecords] = yield* Effect.all([
      routes.facts !== undefined
        ? work.recordsAfter({
            route: routes.facts,
            ...(localAck === undefined ? {} : { after: localAck.through }),
            limit: ROUTE_PAGE_LIMIT,
          })
        : Effect.succeed<ReadonlyArray<WorkRecord>>([]),
      includeCommands
        ? work.recordsAfter({
            route: routes.commands,
            ...(peerAck === undefined ? {} : { after: peerAck.through }),
            limit: ROUTE_PAGE_LIMIT,
          })
        : Effect.succeed<ReadonlyArray<WorkRecord>>([]),
    ]);

    const records = [...mandatory];
    const seen = new Set(records.map(recordKey));
    let localIndex = 0;
    let commandIndex = 0;
    let capacityReached = false;

    while (
      !capacityReached &&
      (localIndex < localRecords.length ||
        commandIndex < commandRecords.length)
    ) {
      const candidates = [
        localRecords[localIndex],
        commandRecords[commandIndex],
      ];
      if (localRecords[localIndex] !== undefined) localIndex += 1;
      if (commandRecords[commandIndex] !== undefined) commandIndex += 1;

      for (const candidate of candidates) {
        if (candidate === undefined || seen.has(recordKey(candidate))) {
          continue;
        }
        const candidateRecords = [...records, candidate];
        if (
          mandatoryReportResponseReservationBytes(candidateRecords) >
            STATION_API_MAX_REPORT_BATCH_BYTES
        ) {
          capacityReached = true;
          break;
        }
        const decision = decideReportBatchAdmission({
          records: candidateRecords,
          acknowledge,
          hasMore: true,
        });
        if (decision._tag !== "admitted") {
          capacityReached = true;
          break;
        }
        records.push(candidate);
        seen.add(recordKey(candidate));
      }
    }

    const hasMore =
      capacityReached ||
      localIndex < localRecords.length ||
      commandIndex < commandRecords.length ||
      localRecords.length === ROUTE_PAGE_LIMIT ||
      commandRecords.length === ROUTE_PAGE_LIMIT;
    return reportBatch(records, acknowledge, hasMore);
  });

const acceptInboundBatch = (
  repository: Context.Tag.Service<typeof StationRepository>,
  work: Context.Tag.Service<typeof WorkRepository>,
  topology: CapturedWorkTopology,
  batch: ReportBatchValue,
): Effect.Effect<
  {
    readonly accepted: AcceptRecordsResult;
    readonly acknowledge: ReadonlyArray<RouteCursor>;
    readonly facts: StationStatusFacts;
  },
  StationApiError
> =>
  Effect.gen(function* () {
    const initialFacts = yield* repository.statusFacts;
    const existingAcknowledge = peerReceivedCursors(
      initialFacts,
      topology.peerInstallationId,
    );
    const currentAuthorization = makeStationWorkAdmission(topology);
    const historicalAdmissions = yield* loadHistoricalFactAdmissions(
      repository,
      topology,
      batch.records,
    );
    const accepted = yield* work.acceptRecords({
      senderInstallationId: topology.peerInstallationId,
      records: batch.records,
      peerAcknowledgements: batch.acknowledge,
      authorizeCommand: currentAuthorization.authorizeCommand,
      authorizeFact: historicalFactAuthorization(
        topology,
        historicalAdmissions,
      ),
      admitResponse:
        admitTransactionalResponse(existingAcknowledge),
    });
    const facts = yield* repository.statusFacts;
    return {
      accepted,
      acknowledge: mergeCursors(
        existingAcknowledge,
        accepted.acknowledge,
      ),
      facts,
    };
  });

const requireConfiguredPeer = (
  repository: Context.Tag.Service<typeof StationRepository>,
  peerInstallationId: InstallationIdValue,
): Effect.Effect<
  {
    readonly localInstallationId: InstallationIdValue;
    readonly configuration: StationConfigurationRecord;
  },
  StationApiError
> =>
  Effect.gen(function* () {
    const localInstallationId = yield* repository.installationId;
    const configuration = yield* repository.configuration;
    if (configuration === undefined) {
      return yield* invariant(
        "report",
        "configuration-required",
        "report exchange requires a configured installation role",
      );
    }
    if (configuration.configuration.role === "remote") {
      const pairing = yield* repository.pairing;
      if (pairing === undefined) {
        return yield* invariant(
          "report",
          "pairing-required",
          "Remote report exchange requires a paired Command Center",
        );
      }
      if (pairing.commandCenterInstallationId !== peerInstallationId) {
        return yield* invariant(
          "report",
          "peer-identity-mismatch",
          "report peer does not match the paired Command Center",
        );
      }
    }
    return { localInstallationId, configuration };
  });

const handleProject = (
  repository: Context.Tag.Service<typeof StationRepository>,
  request: ProjectRequest,
): Effect.Effect<ProjectResponse, StationApiError> =>
  Effect.gen(function* () {
    const configuration = yield* repository.configuration;
    if (configuration?.configuration.role !== "remote") {
      return yield* invariant(
        "project",
        "local-role-mismatch",
        "projection install requires a Remote installation",
      );
    }
    const pairing = yield* repository.pairing;
    if (pairing === undefined) {
      return yield* invariant(
        "project",
        "pairing-required",
        "projection install requires a paired Command Center",
      );
    }
    const installed = yield* repository.installProjection(request);
    // Successful CC projection renews the Remote product lease (3-day TTL).
    remoteLeaseState.stamp();
    return installed;
  }).pipe(Effect.withSpan("station-api.project"));

const handleStatus = (
  repository: Context.Tag.Service<typeof StationRepository>,
  readiness: StationReadiness,
): Effect.Effect<StatusResponse, StationApiError> =>
  Effect.gen(function* () {
    const facts = yield* repository.statusFacts;
    if (facts.configuration?.role === "command-center") {
      return yield* invariant(
        "status",
        "local-role-mismatch",
        "a Remote may not initiate Station status against Command Center",
      );
    }
    const peerAcknowledgedThrough =
      facts.pairing === undefined
        ? []
        : facts.peerAcknowledgedThrough
            .filter(
              (entry) =>
                entry.peerInstallationId ===
                  facts.pairing?.commandCenterInstallationId,
            )
            .map((entry) => entry.acknowledgement);
    return StatusResponse.make({
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
      peerAcknowledgedThrough,
      readiness,
      observedAt: new Date().toISOString(),
    });
  }).pipe(Effect.withSpan("station-api.status"));

// S4-station: single canonical Context.Tag (effect@3.21). V4 → Context.Service.
export class StationApiService extends Context.Tag(StationContextTagIds.api)<
  StationApiService,
  {
    readonly handle: (
      request: StationApiRequest,
      readiness: StationReadiness,
      peer: StationApiPeerContext,
    ) => Effect.Effect<StationApiResponse, StationApiError>;
    readonly prepareReport: (
      peerInstallationId: InstallationIdValue,
    ) => Effect.Effect<ReportRequestValue, StationApiError>;
    readonly acceptReportResponse: (
      peerInstallationId: InstallationIdValue,
      request: ReportRequestValue,
      response: ReportResponseValue,
    ) => Effect.Effect<ReportIntegrationResult, StationApiError>;
  }
>() {}

export const StationApiLive = Layer.effect(
  StationApiService,
  Effect.gen(function* () {
    const repository = yield* StationRepository;
    const work = yield* WorkRepository;
    const canvases = yield* CanvasesService;
    const fleetTargets = yield* StationFleetTargetRepository;

    const topologyForPeer = Effect.fn("StationApi.topologyForPeer")(
      function* (peerInstallationId: InstallationIdValue) {
        const { localInstallationId, configuration } =
          yield* requireConfiguredPeer(repository, peerInstallationId);
        const topology = yield* captureTopology(
          repository,
          canvases,
          fleetTargets,
          configuration,
          localInstallationId,
          peerInstallationId,
        );
        return { localInstallationId, configuration, topology };
      },
    );

    const prepareReport = Effect.fn("StationApi.prepareReport")(
      function* (peerInstallationId: InstallationIdValue) {
        const { localInstallationId, configuration } =
          yield* topologyForPeer(peerInstallationId);
        const facts = yield* repository.statusFacts;
        const acknowledge = peerReceivedCursors(
          facts,
          peerInstallationId,
        );
        const batch = yield* pageStationReport(
          work,
          facts,
          localInstallationId,
          peerInstallationId,
          acknowledge,
          [],
          configuration.configuration.role,
          true,
        );
        return ReportRequest.make({
          protocol: STATION_API_PROTOCOL,
          op: "report",
          senderInstallationId: localInstallationId,
          targetInstallationId: peerInstallationId,
          batch,
        });
      },
    );

    const acceptReportResponse = Effect.fn(
      "StationApi.acceptReportResponse",
    )(function* (
      peerInstallationId: InstallationIdValue,
      request: ReportRequestValue,
      response: ReportResponseValue,
    ) {
      const { localInstallationId, topology } =
        yield* topologyForPeer(peerInstallationId);
      if (
        request.senderInstallationId !== localInstallationId ||
        request.targetInstallationId !== peerInstallationId ||
        !reportResponseSwapsDirection(request, response)
      ) {
        return yield* invariant(
          "report-response",
          "report-response-mismatch",
          "report response does not correlate to the exact peer request",
        );
      }
      if (
        response.batch.records.some(
          (record) => record.recordType === "command",
        )
      ) {
        return yield* invariant(
          "report-response",
          "report-response-command",
          "Station commands are carried only in Command Center-initiated report requests",
        );
      }
      const result = yield* acceptInboundBatch(
        repository,
        work,
        topology,
        response.batch,
      );
      if (result.accepted.emitted.length > 0) {
        return yield* invariant(
          "report-response",
          "report-response-command",
          "a command-free report response unexpectedly emitted a command outcome",
        );
      }
      return {
        accepted: result.accepted.accepted,
        idempotent: result.accepted.idempotent,
        rejected: result.accepted.rejected,
        receivedThrough: result.acknowledge,
        peerHasMore: response.batch.hasMore,
      };
    });

    const handleReport = Effect.fn("StationApi.handleReport")(
      function* (
        request: ReportRequestValue,
        peer: StationApiPeerContext,
      ) {
        const declaredPeer =
          peer._tag === "enrolled-remote"
            ? peer.installationId
            : request.senderInstallationId;
        const { localInstallationId, topology } =
          yield* topologyForPeer(declaredPeer);
        yield* requireReportIdentity(
          request,
          localInstallationId,
          declaredPeer,
        );
        if (
          topology.localRole === "command-center" &&
          peer._tag !== "enrolled-remote"
        ) {
          return yield* invariant(
            "report",
            "peer-role-mismatch",
            "Command Center accepts reports only from an enrolled Remote session",
          );
        }
        if (
          topology.localRole === "remote" &&
          peer._tag !== "command-center-route"
        ) {
          return yield* invariant(
            "report",
            "peer-role-mismatch",
            "Remote accepts reports only on its Command Center-opened session",
          );
        }

        const result = yield* acceptInboundBatch(
          repository,
          work,
          topology,
          request.batch,
        );
        const batch = yield* pageStationReport(
          work,
          result.facts,
          localInstallationId,
          declaredPeer,
          result.acknowledge,
          result.accepted.emitted,
          topology.localRole,
          false,
        );
        return ReportResponse.make({
          protocol: STATION_API_PROTOCOL,
          op: "report",
          senderInstallationId: localInstallationId,
          targetInstallationId: declaredPeer,
          batch,
        });
      },
    );

    const handle = Effect.fn("StationApiService.handle")((
      request: StationApiRequest,
      readiness: StationReadiness,
      peer: StationApiPeerContext,
    ): Effect.Effect<StationApiResponse, StationApiError> => {
      switch (request.op) {
        case "pair":
          return requireRemoteInbound("pair", peer).pipe(
            Effect.flatMap(() => repository.pair(request)),
            Effect.tap(() => Effect.sync(() => remoteLeaseState.stamp())),
          );
        case "configure":
          return requireRemoteInbound("configure", peer).pipe(
            Effect.flatMap(() => repository.configureRemote(request)),
            Effect.tap(() => Effect.sync(() => remoteLeaseState.stamp())),
          );
        case "project":
          return requireRemoteInbound("project", peer).pipe(
            Effect.flatMap(() => handleProject(repository, request)),
          );
        case "report":
          return handleReport(request, peer);
        case "status":
          return requireRemoteInbound("status", peer).pipe(
            Effect.flatMap(() => handleStatus(repository, readiness)),
            Effect.tap(() => Effect.sync(() => remoteLeaseState.stamp())),
          );
      }
    });

    return StationApiService.of({
      handle,
      prepareReport,
      acceptReportResponse,
    });
  }),
);
