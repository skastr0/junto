import { Result, Schema } from "effect";
import { FleetPeerCompatibilitySnapshot } from "./fleet-compatibility-snapshot";
import {
  HostCapability,
  HostId,
  HostLabel,
  HostSshEndpoint,
} from "./remote-hosts";
import {
  DisplayTimestamp,
  InstallationId,
  RouteCursor,
  StationProjectionReference,
  StatusResponse,
} from "./station-api";
import { LogicalSequence } from "./work-protocol";
import {
  ActorRef,
  BoundedWorkId,
  WorkCanvasName,
} from "./work-reference";
import {
  StationAppVersion,
  StationProtocolSupport,
  StationProtocolVersion,
  StationStateSchemaVersion,
} from "./station-protocol";

/**
 * Direct-operator control contract.
 *
 * This owner-local socket is separate from every agent control plane. It has
 * no bearer token, identity claim, arbitrary command, path, or database
 * access. Main admits the OS peer only while explicitly launched in operator
 * control mode and rejects registered agent process trees.
 */

export const OPERATOR_PROTOCOL_VERSION = "junto-operator/v1" as const;
export const OPERATOR_DEFAULT_TIMEOUT_MS = 30_000;
export const OPERATOR_SYNC_TIMEOUT_MS = 120_000;
export const OPERATOR_DEPLOY_TIMEOUT_MS = 15 * 60_000;
export const OPERATOR_MAX_REQUEST_BYTES = 16 * 1024;
export const OPERATOR_MAX_RESPONSE_BYTES = 512 * 1024;
export const OPERATOR_MAX_ERROR_BYTES = 4 * 1024;

export const operatorControlDir = (home: string): string =>
  `${home}/.junto/operator`;

export const operatorControlSocketPath = (home: string): string =>
  `${operatorControlDir(home)}/control.sock`;

const RequestId = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(64)),
  Schema.check(Schema.isPattern(/^[A-Za-z0-9._-]+$/u)),
);

const Diagnostic = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(4_096)),
);
const OptionalCode = Schema.optionalKey(Schema.String.pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(64))));
const Stage = Schema.String.pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(1_024)));
const Version = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(128)),
);
const Sha256 = Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-f0-9]{64}$/u)));
const NonNegativeInt = Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThanOrEqualTo(0)));

export const OperatorOpName = Schema.Literals(["station.status", "station.configure-command-center",
"fleet.list",
"fleet.add",
"fleet.test",
"fleet.enable-managed-installs",
"fleet.deploy",
"fleet.qualify",
"fleet.sync",
"fleet.status",
"qualification.work.prepare",
"qualification.work.progress-offline",
"qualification.work.verify",]);
export type OperatorOpName = typeof OperatorOpName.Type;

export const OperatorEmptyArgs = Schema.Struct({});
export type OperatorEmptyArgs = typeof OperatorEmptyArgs.Type;

const UniqueCapabilities = Schema.Array(HostCapability).pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(4)),
  Schema.check(Schema.makeFilter((capabilities) => new Set(capabilities).size === capabilities.length,
  { message: "host capabilities must be unique" },)),
);

export const OperatorFleetAddArgs = Schema.Struct({
  id: HostId,
  label: HostLabel,
  sshEndpoint: HostSshEndpoint,
  capabilities: UniqueCapabilities,
});
export type OperatorFleetAddArgs = typeof OperatorFleetAddArgs.Type;

export const OperatorFleetHostArgs = Schema.Struct({
  id: HostId,
});
export type OperatorFleetHostArgs = typeof OperatorFleetHostArgs.Type;

export const OperatorFleetSelectionArgs = Schema.Struct({
  id: Schema.optionalKey(HostId),
});
export type OperatorFleetSelectionArgs =
  typeof OperatorFleetSelectionArgs.Type;

export const OperatorQualificationRunId = Schema.String.pipe(
  Schema.check(Schema.isMinLength(3)),
  Schema.check(Schema.isMaxLength(32)),
  Schema.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{2,31}$/u)),
);
export type OperatorQualificationRunId =
  typeof OperatorQualificationRunId.Type;

export const OperatorQualificationWorkTargetArgs = Schema.Struct({
  runId: OperatorQualificationRunId,
  hostId: HostId,
});
export type OperatorQualificationWorkTargetArgs =
  typeof OperatorQualificationWorkTargetArgs.Type;

export const OperatorQualificationWorkRunArgs = Schema.Struct({
  runId: OperatorQualificationRunId,
});
export type OperatorQualificationWorkRunArgs =
  typeof OperatorQualificationWorkRunArgs.Type;

export const OperatorDeploySource = Schema.Literals(["stable", "cached"]);
export type OperatorDeploySource = typeof OperatorDeploySource.Type;

export const OperatorFleetDeployArgs = Schema.Struct({
  id: HostId,
  source: OperatorDeploySource,
});
export type OperatorFleetDeployArgs = typeof OperatorFleetDeployArgs.Type;

export const OperatorFleetQualifyArgs = Schema.Struct({
  id: HostId,
});
export type OperatorFleetQualifyArgs = typeof OperatorFleetQualifyArgs.Type;

export const OperatorPublicHost = Schema.Struct({
  id: HostId,
  label: HostLabel,
  kind: Schema.Literals(["local", "remote"]),
  sshEndpoint: Schema.optionalKey(HostSshEndpoint),
  capabilities: Schema.Array(HostCapability).pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(4)),
  ),
  hermesId: Schema.optionalKey(HostId),
});
export type OperatorPublicHost = typeof OperatorPublicHost.Type;

export const OperatorFleetHostsData = Schema.Struct({
  hosts: Schema.Array(OperatorPublicHost).pipe(Schema.check(Schema.isMaxLength(32))),
});
export type OperatorFleetHostsData = typeof OperatorFleetHostsData.Type;

const OperatorProtocolPeer = Schema.Struct({
  appVersion: StationAppVersion,
  stateSchemaVersion: StationStateSchemaVersion,
  support: StationProtocolSupport,
});

export const OperatorProtocolObservation = Schema.Union([Schema.Struct({
  compatibility: Schema.Literals(["compatible", "deprecated"]),
  negotiatedProtocol: StationProtocolVersion,
  local: OperatorProtocolPeer,
  peer: OperatorProtocolPeer,
}),
Schema.Struct({
  compatibility: Schema.Literal("update-required"),
  local: OperatorProtocolPeer,
  peer: OperatorProtocolPeer,
}),]);
export type OperatorProtocolObservation =
  typeof OperatorProtocolObservation.Type;

export const OperatorFleetTestData = Schema.Struct({
  hostId: HostId,
  ok: Schema.Boolean,
  detail: Diagnostic,
  reachability: Schema.optionalKey(Schema.Literals(["reachable", "unreachable", "unknown"])),
  protocol: Schema.optionalKey(OperatorProtocolObservation),
  compatibility: Schema.optionalKey(FleetPeerCompatibilitySnapshot),
  code: OptionalCode,
});
export type OperatorFleetTestData = typeof OperatorFleetTestData.Type;

export const OperatorManagedInstallsData = Schema.Struct({
  remoteManagedInstalls: Schema.Literal(true),
});
export type OperatorManagedInstallsData =
  typeof OperatorManagedInstallsData.Type;

export const OperatorDeployRecoveryAction = Schema.Struct({
  kind: Schema.Literal("close-active-vellum-terminals"),
  activeTerminalSessions: NonNegativeInt,
});
export type OperatorDeployRecoveryAction =
  typeof OperatorDeployRecoveryAction.Type;

const OperatorDeployCommon = {
  detail: Diagnostic,
  code: OptionalCode,
  stages: Schema.Array(Stage).pipe(Schema.check(Schema.isMaxLength(128))),
  version: Schema.optionalKey(Version),
};

export const OperatorFleetDeployData = Schema.Struct({
    status: Schema.Literals(["ready", "failed", "indeterminate"]),
    ok: Schema.Boolean,
    ...OperatorDeployCommon,
    outcome: Schema.optionalKey(Schema.Literals(["ready", "failed", "indeterminate"])),
    packageState: Schema.optionalKey(Schema.Literals(["present", "previous", "unknown"])),
    role: Schema.optionalKey(Schema.Literals(["remote", "previous", "unknown"])),
    lastSeen: Schema.optionalKey(DisplayTimestamp),
    statusRecorded: Schema.optionalKey(Schema.Boolean),
    recoveryAction: Schema.optionalKey(OperatorDeployRecoveryAction),
});
export type OperatorFleetDeployData = typeof OperatorFleetDeployData.Type;

export const OperatorProjectionSyncReceipt = Schema.Struct({
  decision: Schema.Literals(["unchanged", "install", "idempotent"]),
  active: StationProjectionReference,
});

export const OperatorReportSyncReceipt = Schema.Struct({
  rounds: NonNegativeInt,
  outboundSent: NonNegativeInt,
  inboundReceived: NonNegativeInt,
  inboundAccepted: NonNegativeInt,
  inboundIdempotent: NonNegativeInt,
  inboundRejected: NonNegativeInt,
  receivedThrough: Schema.Array(RouteCursor).pipe(Schema.check(Schema.isMaxLength(256))),
  hasMoreOutbound: Schema.Boolean,
  hasMoreInbound: Schema.Boolean,
});

export const OperatorPropagationReceipt = Schema.Struct({
  stationInstallationId: InstallationId,
  remoteStatus: StatusResponse,
  projection: OperatorProjectionSyncReceipt,
  report: OperatorReportSyncReceipt,
});
export type OperatorPropagationReceipt =
  typeof OperatorPropagationReceipt.Type;

export const OperatorFleetFailure = Schema.Struct({
  hostId: HostId,
  stationInstallationId: Schema.optionalKey(InstallationId),
  reason: Schema.Literals(["not-enrolled", "not-running",
  "route-unavailable",
  "connection-failed",
  "update-required",
  "synchronization-failed",
  "deadline",
  "stopped",]),
  causeTag: Schema.optionalKey(Schema.String.pipe(Schema.check(Schema.isMaxLength(128)))),
  message: Diagnostic,
});
export type OperatorFleetFailure = typeof OperatorFleetFailure.Type;

export const OperatorFleetPeerStatus = Schema.Struct({
  hostId: HostId,
  stationInstallationId: InstallationId,
  phase: Schema.Literals(["connecting", "synchronizing",
  "ready",
  "update-required",
  "backoff",
  "stopped",]),
  sessionOpen: Schema.Boolean,
  attempt: NonNegativeInt,
  updatedAt: DisplayTimestamp,
  nextRetryAt: Schema.optionalKey(DisplayTimestamp),
  protocol: Schema.optionalKey(OperatorProtocolObservation),
  lastReceipt: Schema.optionalKey(OperatorPropagationReceipt),
  lastFailure: Schema.optionalKey(OperatorFleetFailure),
});
export type OperatorFleetPeerStatus = typeof OperatorFleetPeerStatus.Type;

export const OperatorFleetSyncResult = Schema.Union([Schema.Struct({
  ok: Schema.Literal(true),
  hostId: HostId,
  stationInstallationId: InstallationId,
  receipt: OperatorPropagationReceipt,
  status: OperatorFleetPeerStatus,
}),
Schema.Struct({
  ok: Schema.Literal(false),
  hostId: HostId,
  stationInstallationId: Schema.optionalKey(InstallationId),
  error: OperatorFleetFailure,
  status: Schema.optionalKey(OperatorFleetPeerStatus),
}),]);
export type OperatorFleetSyncResult = typeof OperatorFleetSyncResult.Type;

export const OperatorFleetSyncData = Schema.Struct({
  results: Schema.Array(OperatorFleetSyncResult).pipe(Schema.check(Schema.isMaxLength(32))),
});
export type OperatorFleetSyncData = typeof OperatorFleetSyncData.Type;

export const OperatorFleetStatusData = Schema.Struct({
  peers: Schema.Array(OperatorFleetPeerStatus).pipe(Schema.check(Schema.isMaxLength(32))),
});
export type OperatorFleetStatusData = typeof OperatorFleetStatusData.Type;

const OperatorQualificationWorkIdentity = {
  runId: OperatorQualificationRunId,
  canvasName: WorkCanvasName,
  hostId: HostId,
  stationInstallationId: InstallationId,
  taskId: BoundedWorkId,
  actor: ActorRef,
  receivedThrough: LogicalSequence,
} as const;

export const OperatorQualificationWorkPrepareData = Schema.Struct({
  ...OperatorQualificationWorkIdentity,
  state: Schema.Literal("working"),
  disposition: Schema.Literals(["prepared", "idempotent"]),
});
export type OperatorQualificationWorkPrepareData =
  typeof OperatorQualificationWorkPrepareData.Type;

export const OperatorQualificationWorkProgressData = Schema.Struct({
  ...OperatorQualificationWorkIdentity,
  before: Schema.Literal("working"),
  after: Schema.Literal("completed"),
  disposition: Schema.Literal("applied"),
});
export type OperatorQualificationWorkProgressData =
  typeof OperatorQualificationWorkProgressData.Type;

export const OperatorQualificationWorkVerifyData = Schema.Struct({
  ...OperatorQualificationWorkIdentity,
  state: Schema.Literal("completed"),
});
export type OperatorQualificationWorkVerifyData =
  typeof OperatorQualificationWorkVerifyData.Type;

const request = <
  Op extends OperatorOpName,
  S extends Schema.Top,
>(
  op: Op,
  args: S,
) =>
  Schema.Struct({
    protocol: Schema.Literal(OPERATOR_PROTOCOL_VERSION),
    id: RequestId,
    op: Schema.Literal(op),
    args,
  });

export const OperatorStationStatusRequest = request(
  "station.status",
  OperatorEmptyArgs,
);
export const OperatorConfigureCommandCenterRequest = request(
  "station.configure-command-center",
  OperatorEmptyArgs,
);
export const OperatorFleetListRequest = request(
  "fleet.list",
  OperatorEmptyArgs,
);
export const OperatorFleetAddRequest = request(
  "fleet.add",
  OperatorFleetAddArgs,
);
export const OperatorFleetTestRequest = request(
  "fleet.test",
  OperatorFleetHostArgs,
);
export const OperatorEnableManagedInstallsRequest = request(
  "fleet.enable-managed-installs",
  OperatorEmptyArgs,
);
export const OperatorFleetDeployRequest = request(
  "fleet.deploy",
  OperatorFleetDeployArgs,
);
export const OperatorFleetQualifyRequest = request(
  "fleet.qualify",
  OperatorFleetQualifyArgs,
);
export const OperatorFleetSyncRequest = request(
  "fleet.sync",
  OperatorFleetSelectionArgs,
);
export const OperatorFleetStatusRequest = request(
  "fleet.status",
  OperatorFleetSelectionArgs,
);
export const OperatorQualificationWorkPrepareRequest = request(
  "qualification.work.prepare",
  OperatorQualificationWorkTargetArgs,
);
export const OperatorQualificationWorkProgressRequest = request(
  "qualification.work.progress-offline",
  OperatorQualificationWorkRunArgs,
);
export const OperatorQualificationWorkVerifyRequest = request(
  "qualification.work.verify",
  OperatorQualificationWorkTargetArgs,
);

export const OperatorRequestEnvelope = Schema.Union([OperatorStationStatusRequest,
OperatorConfigureCommandCenterRequest,
OperatorFleetListRequest,
OperatorFleetAddRequest,
OperatorFleetTestRequest,
OperatorEnableManagedInstallsRequest,
OperatorFleetDeployRequest,
OperatorFleetQualifyRequest,
OperatorFleetSyncRequest,
OperatorFleetStatusRequest,
OperatorQualificationWorkPrepareRequest,
OperatorQualificationWorkProgressRequest,
OperatorQualificationWorkVerifyRequest,]);
export type OperatorRequestEnvelope = typeof OperatorRequestEnvelope.Type;

const response = <
  Op extends OperatorOpName,
  S extends Schema.Top,
>(
  op: Op,
  data: S,
) =>
  Schema.Struct({
    protocol: Schema.Literal(OPERATOR_PROTOCOL_VERSION),
    id: RequestId,
    ok: Schema.Literal(true),
    op: Schema.Literal(op),
    data,
  });

export const OperatorStationStatusResponse = response(
  "station.status",
  StatusResponse,
);
export const OperatorConfigureCommandCenterResponse = response(
  "station.configure-command-center",
  StatusResponse,
);
export const OperatorFleetListResponse = response(
  "fleet.list",
  OperatorFleetHostsData,
);
export const OperatorFleetAddResponse = response(
  "fleet.add",
  OperatorFleetHostsData,
);
export const OperatorFleetTestResponse = response(
  "fleet.test",
  OperatorFleetTestData,
);
export const OperatorEnableManagedInstallsResponse = response(
  "fleet.enable-managed-installs",
  OperatorManagedInstallsData,
);
export const OperatorFleetDeployResponse = response(
  "fleet.deploy",
  OperatorFleetDeployData,
);
export const OperatorFleetQualifyResponse = response(
  "fleet.qualify",
  OperatorFleetDeployData,
);
export const OperatorFleetSyncResponse = response(
  "fleet.sync",
  OperatorFleetSyncData,
);
export const OperatorFleetStatusResponse = response(
  "fleet.status",
  OperatorFleetStatusData,
);
export const OperatorQualificationWorkPrepareResponse = response(
  "qualification.work.prepare",
  OperatorQualificationWorkPrepareData,
);
export const OperatorQualificationWorkProgressResponse = response(
  "qualification.work.progress-offline",
  OperatorQualificationWorkProgressData,
);
export const OperatorQualificationWorkVerifyResponse = response(
  "qualification.work.verify",
  OperatorQualificationWorkVerifyData,
);

export const OperatorErrorType = Schema.Literals(["validation", "not_found",
"conflict",
"io",
"runtime_down",
"auth_error",
"protocol_error",
"forbidden",
"shutdown",
"internal_error",]);
export type OperatorErrorType = typeof OperatorErrorType.Type;

export const OperatorErrorBody = Schema.Struct({
  type: OperatorErrorType,
  message: Diagnostic,
  details: Schema.optionalKey(Schema.Struct({
    path: Schema.optionalKey(Schema.String.pipe(Schema.check(Schema.isMaxLength(128)))),
    next_step: Schema.optionalKey(Schema.String.pipe(Schema.check(Schema.isMaxLength(1_024)))),
    retryable: Schema.optionalKey(Schema.Boolean),
  })),
});
export type OperatorErrorBody = typeof OperatorErrorBody.Type;

export const OperatorErrorResponse = Schema.Struct({
  protocol: Schema.Literal(OPERATOR_PROTOCOL_VERSION),
  id: Schema.optionalKey(RequestId),
  ok: Schema.Literal(false),
  op: Schema.optionalKey(OperatorOpName),
  error: OperatorErrorBody,
});
export type OperatorErrorResponse = typeof OperatorErrorResponse.Type;

export const OperatorResponseEnvelope = Schema.Union([OperatorStationStatusResponse,
OperatorConfigureCommandCenterResponse,
OperatorFleetListResponse,
OperatorFleetAddResponse,
OperatorFleetTestResponse,
OperatorEnableManagedInstallsResponse,
OperatorFleetDeployResponse,
OperatorFleetQualifyResponse,
OperatorFleetSyncResponse,
OperatorFleetStatusResponse,
OperatorQualificationWorkPrepareResponse,
OperatorQualificationWorkProgressResponse,
OperatorQualificationWorkVerifyResponse,
OperatorErrorResponse,]);
export type OperatorResponseEnvelope = typeof OperatorResponseEnvelope.Type;

export interface OperatorArgsByOp {
  readonly "station.status": OperatorEmptyArgs;
  readonly "station.configure-command-center": OperatorEmptyArgs;
  readonly "fleet.list": OperatorEmptyArgs;
  readonly "fleet.add": OperatorFleetAddArgs;
  readonly "fleet.test": OperatorFleetHostArgs;
  readonly "fleet.enable-managed-installs": OperatorEmptyArgs;
  readonly "fleet.deploy": OperatorFleetDeployArgs;
  readonly "fleet.qualify": OperatorFleetQualifyArgs;
  readonly "fleet.sync": OperatorFleetSelectionArgs;
  readonly "fleet.status": OperatorFleetSelectionArgs;
  readonly "qualification.work.prepare": OperatorQualificationWorkTargetArgs;
  readonly "qualification.work.progress-offline": OperatorQualificationWorkRunArgs;
  readonly "qualification.work.verify": OperatorQualificationWorkTargetArgs;
}

export interface OperatorDataByOp {
  readonly "station.status": typeof StatusResponse.Type;
  readonly "station.configure-command-center": typeof StatusResponse.Type;
  readonly "fleet.list": OperatorFleetHostsData;
  readonly "fleet.add": OperatorFleetHostsData;
  readonly "fleet.test": OperatorFleetTestData;
  readonly "fleet.enable-managed-installs": OperatorManagedInstallsData;
  readonly "fleet.deploy": OperatorFleetDeployData;
  readonly "fleet.qualify": OperatorFleetDeployData;
  readonly "fleet.sync": OperatorFleetSyncData;
  readonly "fleet.status": OperatorFleetStatusData;
  readonly "qualification.work.prepare": OperatorQualificationWorkPrepareData;
  readonly "qualification.work.progress-offline": OperatorQualificationWorkProgressData;
  readonly "qualification.work.verify": OperatorQualificationWorkVerifyData;
}

export const decodeOperatorRequest = Schema.decodeUnknownResult(
  OperatorRequestEnvelope,
  { onExcessProperty: "error" },
);

export const decodeOperatorResponse = Schema.decodeUnknownResult(
  OperatorResponseEnvelope,
  { onExcessProperty: "error" },
);

export const encodeOperatorFrame = (
  value: unknown,
  maxBytes = OPERATOR_MAX_RESPONSE_BYTES,
): string => {
  const frame = `${JSON.stringify(value)}\n`;
  if (new TextEncoder().encode(frame).byteLength > maxBytes) {
    throw new Error(`operator control frame exceeds ${maxBytes} bytes`);
  }
  return frame;
};

export const decodeOperatorJsonLine = (
  line: string,
): Result.Result<unknown, string> => {
  try {
    return Result.succeed(JSON.parse(line) as unknown);
  } catch {
    return Result.fail("malformed JSON frame");
  }
};

/** Operator requests contain only public deployment selection facts. */
export const redactOperatorRequestForLog = (
  value: OperatorRequestEnvelope,
): unknown => value;
