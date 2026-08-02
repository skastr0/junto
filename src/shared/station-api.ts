import { Schema } from "effect";
import {
  HermesHostKey,
  HostCapability,
  HostId,
  HostLabel,
} from "./remote-hosts";
import { STATION_ROLES } from "./station";
import {
  InstallationId,
  type InstallationId as InstallationIdValue,
} from "./installation-id";
import {
  RouteCursor,
  WorkRecord,
  type RouteCursor as RouteCursorValue,
  type WorkRecord as WorkRecordValue,
  type WorkRecordId as WorkRecordIdValue,
  type WorkRoute as WorkRouteValue,
} from "./work-protocol";
import { STATION_PROTOCOL_BASELINE } from "./station-protocol";

export { InstallationId } from "./installation-id";
export { RouteCursor, WorkRecord } from "./work-protocol";

/**
 * The complete Station API seam between one Command Center and one Remote.
 *
 * Transport authenticates and admits the peer before this contract is
 * decoded. Installation identifiers are exact routing facts, never bearer
 * credentials. Work identity is carried completely by each WorkRecord; no
 * transport adapter may infer or smuggle half of a route.
 */
export const STATION_API_PROTOCOL =
  `vellum/station-api/v${STATION_PROTOCOL_BASELINE}` as const;

export const STATION_API_MAX_PROJECTION_CHARS = 64 * 1024 * 1024;
export const STATION_API_MAX_RECORDS_PER_REPORT = 256;
/**
 * Every admitted Work command can produce a mandatory fact plus disposition.
 * Reserving two response records per command makes a valid request's mandatory
 * response representable under the same fixed ReportBatch record bound.
 */
export const STATION_API_MAX_COMMANDS_PER_REPORT =
  Math.floor(STATION_API_MAX_RECORDS_PER_REPORT / 2);
export const STATION_API_MAX_ACKS_PER_REPORT = 256;
export const STATION_API_MAX_FIRST_DELIVERY_CLAIMS_PER_REPORT = 64;
export const STATION_API_MAX_REPORT_BATCH_BYTES = 8 * 1024 * 1024;
export const STATION_API_MAX_STATUS_CURSORS = 256;

/** User-selected station role. It is never inferred by this protocol. */
export const StationApiRole = Schema.Literals([...STATION_ROLES]);
export type StationApiRole = typeof StationApiRole.Type;

/** Host label used by canvas placement and the local execution plane. */
export const StationHostId = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(64)),
  Schema.check(Schema.isPattern(/^(?!-)[A-Za-z0-9][A-Za-z0-9._-]*$/)),
  Schema.brand("StationHostId"),
);
export type StationHostId = typeof StationHostId.Type;

/**
 * Canonical non-negative projection counter.
 *
 * Work record and cursor sequences use the positive-only LogicalSequence from
 * work-protocol. A missing RouteCursor represents zero received records.
 */
export const LogicalSequence = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^(0|[1-9][0-9]*)$/)),
  Schema.check(Schema.isMaxLength(32)),
  Schema.brand("LogicalSequence"),
);
export type LogicalSequence = typeof LogicalSequence.Type;

export const StationSha256 = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  Schema.brand("StationSha256"),
);
export type StationSha256 = typeof StationSha256.Type;

/**
 * Display-only timestamp carried for operator history. No decision helper in
 * this module accepts it as an ordering input.
 */
export const DisplayTimestamp = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(64)),
);
export type DisplayTimestamp = typeof DisplayTimestamp.Type;

const StationLabel = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(128)),
);

const AppVersion = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(64)),
);

export const PairRequest = Schema.Struct({
  protocol: Schema.Literal(STATION_API_PROTOCOL),
  op: Schema.Literal("pair"),
  commandCenterInstallationId: InstallationId,
  stationInstallationId: InstallationId,
  stationLabel: StationLabel,
  appVersion: AppVersion,
});
export type PairRequest = typeof PairRequest.Type;

export const PairResponse = Schema.Struct({
  protocol: Schema.Literal(STATION_API_PROTOCOL),
  op: Schema.Literal("pair"),
  commandCenterInstallationId: InstallationId,
  stationInstallationId: InstallationId,
  pairedAt: DisplayTimestamp,
});
export type PairResponse = typeof PairResponse.Type;

export const CommandCenterConfiguration = Schema.Struct({
  role: Schema.Literal("command-center"),
  hostId: StationHostId,
  supervisedPreferred: Schema.Boolean,
});
export type CommandCenterConfiguration = typeof CommandCenterConfiguration.Type;

export const RemoteConfiguration = Schema.Struct({
  role: Schema.Literal("remote"),
  hostId: StationHostId,
  agentHostId: StationHostId,
  commandCenterInstallationId: InstallationId,
  supervisedPreferred: Schema.Boolean,
});
export type RemoteConfiguration = typeof RemoteConfiguration.Type;

/**
 * Exact Command Center enrollment projected onto one Remote installation.
 *
 * SSH routes are deliberately absent: route locators remain Command
 * Center-owned fleet state and are not projected authority.
 */
export const RemoteHostRegistration = Schema.Struct({
  id: HostId,
  label: HostLabel,
  kind: Schema.Literal("remote"),
  capabilities: Schema.Array(HostCapability).pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(4)),
  ),
  hermesId: Schema.optionalKey(HermesHostKey),
}).pipe(
  Schema.check(Schema.makeFilter((host) =>
    new Set(host.capabilities).size === host.capabilities.length ||
    "Remote host capabilities must be unique",)),
);
export type RemoteHostRegistration = typeof RemoteHostRegistration.Type;

export const StationConfiguration = Schema.Union([CommandCenterConfiguration,
RemoteConfiguration,]);
export type StationConfiguration = typeof StationConfiguration.Type;

export const ConfigureRequest = Schema.Struct({
  protocol: Schema.Literal(STATION_API_PROTOCOL),
  op: Schema.Literal("configure"),
  installationId: InstallationId,
  // Command Center authority is selected only on the local installation.
  configuration: RemoteConfiguration,
  host: RemoteHostRegistration,
});
export type ConfigureRequest = typeof ConfigureRequest.Type;

export const ConfigureResponse = Schema.Struct({
  protocol: Schema.Literal(STATION_API_PROTOCOL),
  op: Schema.Literal("configure"),
  installationId: InstallationId,
  configuration: RemoteConfiguration,
  host: RemoteHostRegistration,
  configuredAt: DisplayTimestamp,
});
export type ConfigureResponse = typeof ConfigureResponse.Type;

/** Complete replace-only authorial projection. */
export const StationProjectionBody = Schema.Struct({
  scope: Schema.Literal("full"),
  generation: LogicalSequence,
  sourceCanvasGeneration: LogicalSequence,
  sourceIntentSha256: StationSha256,
  body: Schema.String.pipe(Schema.check(Schema.isMaxLength(STATION_API_MAX_PROJECTION_CHARS))),
  contentSha256: StationSha256,
  createdAt: DisplayTimestamp,
});
export type StationProjectionBody = typeof StationProjectionBody.Type;

export const StationProjectionReference = Schema.Struct({
  generation: LogicalSequence,
  contentSha256: StationSha256,
  receivedAt: DisplayTimestamp,
});
export type StationProjectionReference = typeof StationProjectionReference.Type;

export const ProjectRequest = Schema.Struct({
  protocol: Schema.Literal(STATION_API_PROTOCOL),
  op: Schema.Literal("project"),
  stationInstallationId: InstallationId,
  projection: StationProjectionBody,
});
export type ProjectRequest = typeof ProjectRequest.Type;

export const ProjectionInstallDecision = Schema.Literals(["install", "idempotent",
"stale",
"conflict",]);
export type ProjectionInstallDecision = typeof ProjectionInstallDecision.Type;

export const ProjectResponse = Schema.Struct({
  protocol: Schema.Literal(STATION_API_PROTOCOL),
  op: Schema.Literal("project"),
  stationInstallationId: InstallationId,
  decision: ProjectionInstallDecision,
  active: StationProjectionReference,
});
export type ProjectResponse = typeof ProjectResponse.Type;

export interface ReportBatchCandidate {
  readonly records: ReadonlyArray<WorkRecordValue>;
  readonly acknowledge: ReadonlyArray<RouteCursorValue>;
  readonly hasMore: boolean;
}

export type ReportBatchAdmissionDecision =
  | {
      readonly _tag: "admitted";
      readonly encodedBytes: number;
      readonly commands: number;
      readonly firstDeliveryClaims: number;
    }
  | {
      readonly _tag: "record-limit";
      readonly actual: number;
      readonly limit: number;
    }
  | {
      readonly _tag: "acknowledgement-limit";
      readonly actual: number;
      readonly limit: number;
    }
  | {
      readonly _tag: "command-response-capacity-limit";
      readonly actual: number;
      readonly limit: number;
    }
  | {
      readonly _tag: "first-delivery-claim-limit";
      readonly actual: number;
      readonly limit: number;
    }
  | {
      readonly _tag: "not-json";
    }
  | {
      readonly _tag: "encoded-byte-limit";
      readonly actual: number;
      readonly limit: number;
    };

/**
 * Pure encoded-size witness shared by schema admission and page builders.
 *
 * Counting the exact JSON bytes prevents transport adapters from quietly
 * inventing different limits. It never mutates or normalizes the candidate.
 */
export const reportBatchEncodedByteLength = (
  candidate: unknown,
): number | undefined => {
  try {
    const encoded = JSON.stringify(candidate);
    return encoded === undefined
      ? undefined
      : new TextEncoder().encode(encoded).byteLength;
  } catch {
    return undefined;
  }
};

export const isFirstDeliveryTaskClaim = (
  record: WorkRecordValue,
): boolean =>
  record.recordType === "command" &&
  record.operation === "task.claim" &&
  record.predecessor === null;

/**
 * One canonical report-batch admission decision.
 *
 * Replayed task.claim commands are indistinguishable from first delivery at
 * this pure wire boundary, so the conservative bound applies to every
 * task.claim command in a batch. The repository later distinguishes exact
 * replay through durable identity and content.
 */
export const decideReportBatchAdmission = (
  candidate: ReportBatchCandidate,
): ReportBatchAdmissionDecision => {
  if (candidate.records.length > STATION_API_MAX_RECORDS_PER_REPORT) {
    return {
      _tag: "record-limit",
      actual: candidate.records.length,
      limit: STATION_API_MAX_RECORDS_PER_REPORT,
    };
  }
  if (candidate.acknowledge.length > STATION_API_MAX_ACKS_PER_REPORT) {
    return {
      _tag: "acknowledgement-limit",
      actual: candidate.acknowledge.length,
      limit: STATION_API_MAX_ACKS_PER_REPORT,
    };
  }
  const commands = candidate.records.reduce(
    (count, record) => count + (record.recordType === "command" ? 1 : 0),
    0,
  );
  if (commands > STATION_API_MAX_COMMANDS_PER_REPORT) {
    return {
      _tag: "command-response-capacity-limit",
      actual: commands,
      limit: STATION_API_MAX_COMMANDS_PER_REPORT,
    };
  }
  const firstDeliveryClaims = candidate.records.reduce(
    (count, record) => count + (isFirstDeliveryTaskClaim(record) ? 1 : 0),
    0,
  );
  if (
    firstDeliveryClaims >
      STATION_API_MAX_FIRST_DELIVERY_CLAIMS_PER_REPORT
  ) {
    return {
      _tag: "first-delivery-claim-limit",
      actual: firstDeliveryClaims,
      limit: STATION_API_MAX_FIRST_DELIVERY_CLAIMS_PER_REPORT,
    };
  }
  const encodedBytes = reportBatchEncodedByteLength(candidate);
  if (encodedBytes === undefined) return { _tag: "not-json" };
  if (encodedBytes > STATION_API_MAX_REPORT_BATCH_BYTES) {
    return {
      _tag: "encoded-byte-limit",
      actual: encodedBytes,
      limit: STATION_API_MAX_REPORT_BATCH_BYTES,
    };
  }
  return {
    _tag: "admitted",
    encodedBytes,
    commands,
    firstDeliveryClaims,
  };
};

const reportBatchAdmissionMessage = (
  decision: Exclude<ReportBatchAdmissionDecision, { readonly _tag: "admitted" }>,
): string => {
  switch (decision._tag) {
    case "record-limit":
      return `Report batch has ${decision.actual} records; maximum is ${decision.limit}`;
    case "acknowledgement-limit":
      return `Report batch has ${decision.actual} acknowledgements; maximum is ${decision.limit}`;
    case "command-response-capacity-limit":
      return `Report batch has ${decision.actual} commands; maximum is ${decision.limit} so every mandatory fact and disposition fits its response`;
    case "first-delivery-claim-limit":
      return `Report batch has ${decision.actual} task.claim commands; maximum is ${decision.limit}`;
    case "not-json":
      return "Report batch must be JSON-serializable";
    case "encoded-byte-limit":
      return `Report batch is ${decision.actual} encoded bytes; maximum is ${decision.limit}`;
  }
};

const ReportBatchShape = Schema.Struct({
  records: Schema.Array(WorkRecord).pipe(
    Schema.check(Schema.isMaxLength(STATION_API_MAX_RECORDS_PER_REPORT)),
  ),
  acknowledge: Schema.Array(RouteCursor).pipe(
    Schema.check(Schema.isMaxLength(STATION_API_MAX_ACKS_PER_REPORT)),
  ),
  hasMore: Schema.Boolean,
});

export const ReportBatch = ReportBatchShape.pipe(
  Schema.check(Schema.makeFilter((candidate) => {
    const decision = decideReportBatchAdmission(candidate);
    return decision._tag === "admitted"
      ? true
      : reportBatchAdmissionMessage(decision);
  })),
);
export type ReportBatch = typeof ReportBatch.Type;

export interface ReportDirectionCandidate {
  readonly senderInstallationId: InstallationIdValue;
  readonly targetInstallationId: InstallationIdValue;
  readonly batch: ReportBatchCandidate;
}

export type ReportDirectionDecision =
  | { readonly _tag: "valid" }
  | { readonly _tag: "same-installation" }
  | {
      readonly _tag: "record-event-home-mismatch";
      readonly record: WorkRecordIdValue;
    }
  | {
      readonly _tag: "record-entity-home-mismatch";
      readonly record: WorkRecordIdValue;
      readonly expectedEntityHome: InstallationIdValue;
    }
  | {
      readonly _tag: "acknowledgement-event-home-mismatch";
      readonly cursor: RouteCursorValue;
    };

/**
 * Validate direction without consulting an SSH route or array position.
 *
 * Commands address the target authority. Facts and dispositions are emitted
 * by their entity authority and therefore remain sender-homed. Every ACK
 * describes records originally emitted by the target.
 */
export const decideReportDirection = (
  candidate: ReportDirectionCandidate,
): ReportDirectionDecision => {
  const {
    senderInstallationId: sender,
    targetInstallationId: target,
    batch,
  } = candidate;
  if (sender === target) return { _tag: "same-installation" };

  for (const record of batch.records) {
    if (record.id.route.eventHome !== sender) {
      return {
        _tag: "record-event-home-mismatch",
        record: record.id,
      };
    }
    const expectedEntityHome =
      record.recordType === "command" ? target : sender;
    if (record.id.route.entityHome !== expectedEntityHome) {
      return {
        _tag: "record-entity-home-mismatch",
        record: record.id,
        expectedEntityHome,
      };
    }
  }
  for (const cursor of batch.acknowledge) {
    if (cursor.eventHome !== target) {
      return {
        _tag: "acknowledgement-event-home-mismatch",
        cursor,
      };
    }
  }
  return { _tag: "valid" };
};

const reportDirectionMessage = (
  decision: Exclude<ReportDirectionDecision, { readonly _tag: "valid" }>,
): string => {
  switch (decision._tag) {
    case "same-installation":
      return "Report sender and target installations must differ";
    case "record-event-home-mismatch":
      return "Every report record eventHome must equal senderInstallationId";
    case "record-entity-home-mismatch":
      return `Report record entityHome must equal ${decision.expectedEntityHome}`;
    case "acknowledgement-event-home-mismatch":
      return "Every report acknowledgement eventHome must equal targetInstallationId";
  }
};

const reportDirectionFilter = (
  candidate: ReportDirectionCandidate,
): boolean | string => {
  const decision = decideReportDirection(candidate);
  return decision._tag === "valid"
    ? true
    : reportDirectionMessage(decision);
};

const ReportRequestShape = Schema.Struct({
  protocol: Schema.Literal(STATION_API_PROTOCOL),
  op: Schema.Literal("report"),
  senderInstallationId: InstallationId,
  targetInstallationId: InstallationId,
  batch: ReportBatch,
});

export const ReportRequest = ReportRequestShape.pipe(
  Schema.check(Schema.makeFilter(reportDirectionFilter)),
);
export type ReportRequest = typeof ReportRequest.Type;

const ReportResponseShape = Schema.Struct({
  protocol: Schema.Literal(STATION_API_PROTOCOL),
  op: Schema.Literal("report"),
  senderInstallationId: InstallationId,
  targetInstallationId: InstallationId,
  batch: ReportBatch,
});

export const ReportResponse = ReportResponseShape.pipe(
  Schema.check(Schema.makeFilter(reportDirectionFilter)),
);
export type ReportResponse = typeof ReportResponse.Type;

/** A correlated response must swap the request direction exactly. */
export const reportResponseSwapsDirection = (
  request: Pick<
    ReportRequest,
    "senderInstallationId" | "targetInstallationId"
  >,
  response: Pick<
    ReportResponse,
    "senderInstallationId" | "targetInstallationId"
  >,
): boolean =>
  response.senderInstallationId === request.targetInstallationId &&
  response.targetInstallationId === request.senderInstallationId;

export const StatusRequest = Schema.Struct({
  protocol: Schema.Literal(STATION_API_PROTOCOL),
  op: Schema.Literal("status"),
});
export type StatusRequest = typeof StatusRequest.Type;

export const StationApiStatusState = Schema.Literals(["unenrolled", "paired",
"configured",
"ready",
"degraded",]);
export type StationApiStatusState = typeof StationApiStatusState.Type;

export const StationReadiness = Schema.Struct({
  database: Schema.Boolean,
  workControl: Schema.Boolean,
  simulation: Schema.Boolean,
  session: Schema.Boolean,
});
export type StationReadiness = typeof StationReadiness.Type;

export const StatusResponse = Schema.Struct({
  protocol: Schema.Literal(STATION_API_PROTOCOL),
  op: Schema.Literal("status"),
  installationId: InstallationId,
  state: StationApiStatusState,
  configuration: Schema.optionalKey(StationConfiguration),
  configuredAt: Schema.optionalKey(DisplayTimestamp),
  projection: Schema.optionalKey(StationProjectionReference),
  receivedThrough: Schema.Array(RouteCursor).pipe(
    Schema.check(Schema.isMaxLength(STATION_API_MAX_STATUS_CURSORS)),
  ),
  /**
   * What the admitted peer has cumulatively acknowledged from this
   * installation. A Station status response is a self-report to exactly one
   * admitted peer, so that peer is the response counterpart and is not
   * repeated here. A repository or aggregate fleet view must still key these
   * cursors by peer installation identity.
   */
  peerAcknowledgedThrough: Schema.Array(RouteCursor).pipe(
    Schema.check(Schema.isMaxLength(STATION_API_MAX_STATUS_CURSORS)),
  ),
  readiness: StationReadiness,
  observedAt: DisplayTimestamp,
});
export type StatusResponse = typeof StatusResponse.Type;

export const StationApiRequest = Schema.Union([PairRequest,
ConfigureRequest,
ProjectRequest,
ReportRequest,
StatusRequest,]);
export type StationApiRequest = typeof StationApiRequest.Type;

export const StationApiResponse = Schema.Union([PairResponse,
ConfigureResponse,
ProjectResponse,
ReportResponse,
StatusResponse,]);
export type StationApiResponse = typeof StationApiResponse.Type;

/** BigInt comparison for decimal projection counters. */
export const compareLogicalSequence = (
  left: LogicalSequence,
  right: LogicalSequence,
): number => {
  const a = BigInt(left);
  const b = BigInt(right);
  if (a === b) return 0;
  return a < b ? -1 : 1;
};

export const decideProjectionInstall = (
  current:
    | Pick<StationProjectionReference, "generation" | "contentSha256">
    | undefined,
  incoming: Pick<StationProjectionBody, "generation" | "contentSha256">,
): ProjectionInstallDecision => {
  if (current === undefined) return "install";

  const generationOrder = compareLogicalSequence(
    incoming.generation,
    current.generation,
  );
  if (generationOrder > 0) return "install";
  if (generationOrder < 0) return "stale";
  return incoming.contentSha256 === current.contentSha256
    ? "idempotent"
    : "conflict";
};

const sameWorkRoute = (
  left: Pick<WorkRouteValue, "eventHome" | "entityHome">,
  right: Pick<WorkRouteValue, "eventHome" | "entityHome">,
): boolean =>
  left.eventHome === right.eventHome &&
  left.entityHome === right.entityHome;

export type RouteCursorAdvanceDecision =
  | {
      readonly _tag: "advanced";
      readonly cursor: RouteCursorValue;
    }
  | {
      readonly _tag: "idempotent";
      readonly cursor: RouteCursorValue;
    }
  | {
      readonly _tag: "regression";
      readonly cursor: RouteCursorValue;
      readonly rejected: RouteCursorValue;
    }
  | {
      readonly _tag: "route-mismatch";
      readonly cursor: RouteCursorValue;
      readonly rejected: RouteCursorValue;
    };

/** Decide a cumulative full-route ACK update without mutating current state. */
export const decideRouteCursorAdvance = (
  current: RouteCursorValue | undefined,
  proposed: RouteCursorValue,
): RouteCursorAdvanceDecision => {
  if (current === undefined) {
    return { _tag: "advanced", cursor: proposed };
  }
  if (!sameWorkRoute(current, proposed)) {
    return { _tag: "route-mismatch", cursor: current, rejected: proposed };
  }

  const proposedSequence = BigInt(proposed.through);
  const currentSequence = BigInt(current.through);
  if (proposedSequence > currentSequence) {
    return { _tag: "advanced", cursor: proposed };
  }
  if (proposedSequence === currentSequence) {
    return { _tag: "idempotent", cursor: current };
  }
  return { _tag: "regression", cursor: current, rejected: proposed };
};

/**
 * Advance one exact route through a contiguous run.
 *
 * Cursor absence is the only representation of zero. If sequence one is not
 * present, this returns the original absent cursor.
 */
export const contiguousRouteCursor = (
  route: WorkRouteValue,
  current: RouteCursorValue | undefined,
  received: ReadonlyArray<WorkRecordIdValue>,
): RouteCursorValue | undefined => {
  if (current !== undefined && !sameWorkRoute(current, route)) return current;

  const sequences = new Map<string, WorkRecordIdValue["seq"]>();
  for (const identity of received) {
    if (!sameWorkRoute(identity.route, route)) continue;
    sequences.set(identity.seq, identity.seq);
  }

  let next = current === undefined ? 1n : BigInt(current.through) + 1n;
  let through = current?.through;
  while (true) {
    const admitted = sequences.get(next.toString());
    if (admitted === undefined) break;
    through = admitted;
    next += 1n;
  }
  return through === undefined
    ? current
    : {
        eventHome: route.eventHome,
        entityHome: route.entityHome,
        through,
      };
};

export type CoalesceWorkRecordsDecision =
  | {
      readonly _tag: "accepted";
      readonly records: ReadonlyArray<WorkRecordValue>;
    }
  | {
      readonly _tag: "identity-conflict";
      readonly identity: WorkRecordIdValue;
      readonly admittedContentSha256: WorkRecordValue["contentSha256"];
      readonly rejectedContentSha256: WorkRecordValue["contentSha256"];
    };

const workRecordIdentityKey = (identity: WorkRecordIdValue): string =>
  `${identity.route.eventHome}\u0000${identity.route.entityHome}\u0000${identity.seq}`;

/** Collapse exact WorkRecord retries and reject route-identity content reuse. */
export const coalesceWorkRecords = (
  records: ReadonlyArray<WorkRecordValue>,
): CoalesceWorkRecordsDecision => {
  const byIdentity = new Map<string, WorkRecordValue>();
  for (const record of records) {
    const key = workRecordIdentityKey(record.id);
    const admitted = byIdentity.get(key);
    if (admitted === undefined) {
      byIdentity.set(key, record);
      continue;
    }
    if (admitted.contentSha256 !== record.contentSha256) {
      return {
        _tag: "identity-conflict",
        identity: record.id,
        admittedContentSha256: admitted.contentSha256,
        rejectedContentSha256: record.contentSha256,
      };
    }
  }
  return { _tag: "accepted", records: [...byIdentity.values()] };
};
