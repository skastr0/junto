import { Either, Schema } from "effect";
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

export const OPERATOR_PROTOCOL_VERSION = "vellum-operator/v1" as const;
export const OPERATOR_DEFAULT_TIMEOUT_MS = 30_000;
export const OPERATOR_SYNC_TIMEOUT_MS = 120_000;
export const OPERATOR_DEPLOY_TIMEOUT_MS = 15 * 60_000;
export const OPERATOR_MAX_REQUEST_BYTES = 16 * 1024;
export const OPERATOR_MAX_RESPONSE_BYTES = 512 * 1024;
export const OPERATOR_MAX_ERROR_BYTES = 4 * 1024;
export const OPERATOR_MAX_PASSWORD_BYTES = 256;

export const operatorControlDir = (home: string): string =>
  `${home}/.vellum/operator`;

export const operatorControlSocketPath = (home: string): string =>
  `${operatorControlDir(home)}/control.sock`;

const RequestId = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(64),
  Schema.pattern(/^[A-Za-z0-9._-]+$/u),
);

const Diagnostic = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(4_096),
);
const OptionalCode = Schema.optionalWith(
  Schema.String.pipe(Schema.minLength(1), Schema.maxLength(64)),
  { exact: true },
);
const Stage = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(1_024));
const Version = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(128),
);
const Sha256 = Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/u));
const NonNegativeInt = Schema.Int.pipe(Schema.nonNegative());
const PositiveInt = Schema.Int.pipe(Schema.positive());

export const OperatorOpName = Schema.Literal(
  "station.status",
  "station.configure-command-center",
  "fleet.list",
  "fleet.add",
  "fleet.test",
  "fleet.enable-managed-installs",
  "fleet.deploy",
  "fleet.qualify",
  "fleet.sync",
  "fleet.status",
);
export type OperatorOpName = typeof OperatorOpName.Type;

export const OperatorEmptyArgs = Schema.Struct({});
export type OperatorEmptyArgs = typeof OperatorEmptyArgs.Type;

const UniqueCapabilities = Schema.Array(HostCapability).pipe(
  Schema.minItems(1),
  Schema.maxItems(4),
  Schema.filter(
    (capabilities) => new Set(capabilities).size === capabilities.length,
    { message: () => "host capabilities must be unique" },
  ),
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
  id: Schema.optionalWith(HostId, { exact: true }),
});
export type OperatorFleetSelectionArgs =
  typeof OperatorFleetSelectionArgs.Type;

export const OperatorDeploySource = Schema.Literal("stable", "cached");
export type OperatorDeploySource = typeof OperatorDeploySource.Type;

export const OperatorDeployAuthorizationRequest = Schema.Struct({
  kind: Schema.Literal("linux-administrator-password"),
  hostId: HostId,
  endpoint: HostSshEndpoint,
  version: Schema.String.pipe(
    Schema.pattern(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u),
  ),
  manifestSha256: Sha256,
  debSha256: Sha256,
  inventorySha256: Sha256,
});
export type OperatorDeployAuthorizationRequest =
  typeof OperatorDeployAuthorizationRequest.Type;

export const OperatorAdministratorPassword = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(OPERATOR_MAX_PASSWORD_BYTES),
  Schema.filter(
    (password) =>
      !password.includes("\0") &&
      !password.includes("\r") &&
      !password.includes("\n") &&
      new TextEncoder().encode(password).byteLength <=
        OPERATOR_MAX_PASSWORD_BYTES,
    {
      message: () =>
        `administrator password must be 1-${OPERATOR_MAX_PASSWORD_BYTES} UTF-8 bytes on one line`,
    },
  ),
);

export const OperatorDeployAuthorization = Schema.Struct({
  request: OperatorDeployAuthorizationRequest,
  password: OperatorAdministratorPassword,
});
export type OperatorDeployAuthorization =
  typeof OperatorDeployAuthorization.Type;

export const OperatorFleetDeployArgs = Schema.Struct({
  id: HostId,
  source: OperatorDeploySource,
  authorization: Schema.optionalWith(OperatorDeployAuthorization, {
    exact: true,
  }),
});
export type OperatorFleetDeployArgs = typeof OperatorFleetDeployArgs.Type;

export const OperatorFleetQualifyArgs = Schema.Struct({
  id: HostId,
  authorization: Schema.optionalWith(OperatorDeployAuthorization, {
    exact: true,
  }),
});
export type OperatorFleetQualifyArgs = typeof OperatorFleetQualifyArgs.Type;

export const OperatorPublicHost = Schema.Struct({
  id: HostId,
  label: HostLabel,
  kind: Schema.Literal("local", "remote"),
  sshEndpoint: Schema.optionalWith(HostSshEndpoint, { exact: true }),
  capabilities: Schema.Array(HostCapability).pipe(
    Schema.minItems(1),
    Schema.maxItems(4),
  ),
  hermesId: Schema.optionalWith(HostId, { exact: true }),
});
export type OperatorPublicHost = typeof OperatorPublicHost.Type;

export const OperatorFleetHostsData = Schema.Struct({
  hosts: Schema.Array(OperatorPublicHost).pipe(Schema.maxItems(32)),
});
export type OperatorFleetHostsData = typeof OperatorFleetHostsData.Type;

const OperatorProtocolPeer = Schema.Struct({
  appVersion: StationAppVersion,
  stateSchemaVersion: StationStateSchemaVersion,
  support: StationProtocolSupport,
});

export const OperatorProtocolObservation = Schema.Union(
  Schema.Struct({
    compatibility: Schema.Literal("compatible", "deprecated"),
    negotiatedProtocol: StationProtocolVersion,
    local: OperatorProtocolPeer,
    peer: OperatorProtocolPeer,
  }),
  Schema.Struct({
    compatibility: Schema.Literal("update-required"),
    local: OperatorProtocolPeer,
    peer: OperatorProtocolPeer,
  }),
);
export type OperatorProtocolObservation =
  typeof OperatorProtocolObservation.Type;

export const OperatorFleetTestData = Schema.Struct({
  hostId: HostId,
  ok: Schema.Boolean,
  detail: Diagnostic,
  reachability: Schema.optionalWith(
    Schema.Literal("reachable", "unreachable", "unknown"),
    { exact: true },
  ),
  protocol: Schema.optionalWith(OperatorProtocolObservation, { exact: true }),
  code: OptionalCode,
});
export type OperatorFleetTestData = typeof OperatorFleetTestData.Type;

export const OperatorManagedInstallsData = Schema.Struct({
  remoteManagedInstalls: Schema.Literal(true),
});
export type OperatorManagedInstallsData =
  typeof OperatorManagedInstallsData.Type;

export const OperatorDeployRecoveryAction = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("close-active-vellum-terminals"),
    activeTerminalSessions: NonNegativeInt,
  }),
  Schema.Struct({
    kind: Schema.Literal("restore-terminal-live-work-observation"),
  }),
  Schema.Struct({
    kind: Schema.Literal("bootstrap-linux-release-installer"),
  }),
  Schema.Struct({
    kind: Schema.Literal("repair-linux-release-transaction"),
  }),
  Schema.Struct({
    kind: Schema.Literal("retry-linux-release-install"),
  }),
);
export type OperatorDeployRecoveryAction =
  typeof OperatorDeployRecoveryAction.Type;

const OperatorDeployCommon = {
  detail: Diagnostic,
  code: OptionalCode,
  stages: Schema.Array(Stage).pipe(Schema.maxItems(128)),
  version: Schema.optionalWith(Version, { exact: true }),
};

export const OperatorFleetDeployData = Schema.Union(
  Schema.Struct({
    status: Schema.Literal("authorization-required"),
    ok: Schema.Literal(false),
    ...OperatorDeployCommon,
    authorizationRequest: OperatorDeployAuthorizationRequest,
  }),
  Schema.Struct({
    status: Schema.Literal("ready", "failed", "indeterminate"),
    ok: Schema.Boolean,
    ...OperatorDeployCommon,
    outcome: Schema.optionalWith(
      Schema.Literal("ready", "failed", "indeterminate"),
      { exact: true },
    ),
    packageState: Schema.optionalWith(
      Schema.Literal("present", "previous", "unknown"),
      { exact: true },
    ),
    role: Schema.optionalWith(
      Schema.Literal("remote", "previous", "unknown"),
      { exact: true },
    ),
    lastSeen: Schema.optionalWith(DisplayTimestamp, { exact: true }),
    statusRecorded: Schema.optionalWith(Schema.Boolean, { exact: true }),
    recoveryAction: Schema.optionalWith(OperatorDeployRecoveryAction, {
      exact: true,
    }),
  }),
);
export type OperatorFleetDeployData = typeof OperatorFleetDeployData.Type;

export const OperatorProjectionSyncReceipt = Schema.Struct({
  decision: Schema.Literal("unchanged", "install", "idempotent"),
  active: StationProjectionReference,
});

export const OperatorReportSyncReceipt = Schema.Struct({
  rounds: NonNegativeInt,
  outboundSent: NonNegativeInt,
  inboundReceived: NonNegativeInt,
  inboundAccepted: NonNegativeInt,
  inboundIdempotent: NonNegativeInt,
  inboundRejected: NonNegativeInt,
  receivedThrough: Schema.Array(RouteCursor).pipe(Schema.maxItems(256)),
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
  stationInstallationId: Schema.optionalWith(InstallationId, { exact: true }),
  reason: Schema.Literal(
    "not-enrolled",
    "not-running",
    "route-unavailable",
    "connection-failed",
    "update-required",
    "synchronization-failed",
    "deadline",
    "stopped",
  ),
  causeTag: Schema.optionalWith(
    Schema.String.pipe(Schema.maxLength(128)),
    { exact: true },
  ),
  message: Diagnostic,
});
export type OperatorFleetFailure = typeof OperatorFleetFailure.Type;

export const OperatorFleetPeerStatus = Schema.Struct({
  hostId: HostId,
  stationInstallationId: InstallationId,
  phase: Schema.Literal(
    "connecting",
    "synchronizing",
    "ready",
    "update-required",
    "backoff",
    "stopped",
  ),
  sessionOpen: Schema.Boolean,
  attempt: PositiveInt,
  updatedAt: DisplayTimestamp,
  nextRetryAt: Schema.optionalWith(DisplayTimestamp, { exact: true }),
  protocol: Schema.optionalWith(OperatorProtocolObservation, { exact: true }),
  lastReceipt: Schema.optionalWith(OperatorPropagationReceipt, { exact: true }),
  lastFailure: Schema.optionalWith(OperatorFleetFailure, { exact: true }),
});
export type OperatorFleetPeerStatus = typeof OperatorFleetPeerStatus.Type;

export const OperatorFleetSyncResult = Schema.Union(
  Schema.Struct({
    ok: Schema.Literal(true),
    hostId: HostId,
    stationInstallationId: InstallationId,
    receipt: OperatorPropagationReceipt,
    status: OperatorFleetPeerStatus,
  }),
  Schema.Struct({
    ok: Schema.Literal(false),
    hostId: HostId,
    stationInstallationId: Schema.optionalWith(InstallationId, {
      exact: true,
    }),
    error: OperatorFleetFailure,
    status: Schema.optionalWith(OperatorFleetPeerStatus, { exact: true }),
  }),
);
export type OperatorFleetSyncResult = typeof OperatorFleetSyncResult.Type;

export const OperatorFleetSyncData = Schema.Struct({
  results: Schema.Array(OperatorFleetSyncResult).pipe(Schema.maxItems(32)),
});
export type OperatorFleetSyncData = typeof OperatorFleetSyncData.Type;

export const OperatorFleetStatusData = Schema.Struct({
  peers: Schema.Array(OperatorFleetPeerStatus).pipe(Schema.maxItems(32)),
});
export type OperatorFleetStatusData = typeof OperatorFleetStatusData.Type;

const request = <
  Op extends OperatorOpName,
  S extends Schema.Schema.AnyNoContext,
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

export const OperatorRequestEnvelope = Schema.Union(
  OperatorStationStatusRequest,
  OperatorConfigureCommandCenterRequest,
  OperatorFleetListRequest,
  OperatorFleetAddRequest,
  OperatorFleetTestRequest,
  OperatorEnableManagedInstallsRequest,
  OperatorFleetDeployRequest,
  OperatorFleetQualifyRequest,
  OperatorFleetSyncRequest,
  OperatorFleetStatusRequest,
);
export type OperatorRequestEnvelope = typeof OperatorRequestEnvelope.Type;

const response = <
  Op extends OperatorOpName,
  S extends Schema.Schema.AnyNoContext,
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

export const OperatorErrorType = Schema.Literal(
  "validation",
  "not_found",
  "conflict",
  "io",
  "runtime_down",
  "auth_error",
  "protocol_error",
  "forbidden",
  "shutdown",
  "internal_error",
);
export type OperatorErrorType = typeof OperatorErrorType.Type;

export const OperatorErrorBody = Schema.Struct({
  type: OperatorErrorType,
  message: Diagnostic,
  details: Schema.optionalWith(
    Schema.Struct({
      path: Schema.optionalWith(
        Schema.String.pipe(Schema.maxLength(128)),
        { exact: true },
      ),
      next_step: Schema.optionalWith(
        Schema.String.pipe(Schema.maxLength(1_024)),
        { exact: true },
      ),
      retryable: Schema.optionalWith(Schema.Boolean, { exact: true }),
    }),
    { exact: true },
  ),
});
export type OperatorErrorBody = typeof OperatorErrorBody.Type;

export const OperatorErrorResponse = Schema.Struct({
  protocol: Schema.Literal(OPERATOR_PROTOCOL_VERSION),
  id: Schema.optionalWith(RequestId, { exact: true }),
  ok: Schema.Literal(false),
  op: Schema.optionalWith(OperatorOpName, { exact: true }),
  error: OperatorErrorBody,
});
export type OperatorErrorResponse = typeof OperatorErrorResponse.Type;

export const OperatorResponseEnvelope = Schema.Union(
  OperatorStationStatusResponse,
  OperatorConfigureCommandCenterResponse,
  OperatorFleetListResponse,
  OperatorFleetAddResponse,
  OperatorFleetTestResponse,
  OperatorEnableManagedInstallsResponse,
  OperatorFleetDeployResponse,
  OperatorFleetQualifyResponse,
  OperatorFleetSyncResponse,
  OperatorFleetStatusResponse,
  OperatorErrorResponse,
);
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
}

export const decodeOperatorRequest = Schema.decodeUnknownEither(
  OperatorRequestEnvelope,
  { onExcessProperty: "error" },
);

export const decodeOperatorResponse = Schema.decodeUnknownEither(
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
): Either.Either<unknown, string> => {
  try {
    return Either.right(JSON.parse(line) as unknown);
  } catch {
    return Either.left("malformed JSON frame");
  }
};

/** Safe diagnostic projection; never log an unredacted deployment request. */
export const redactOperatorRequestForLog = (
  value: OperatorRequestEnvelope,
): unknown => {
  if (
    (value.op !== "fleet.deploy" && value.op !== "fleet.qualify") ||
    value.args.authorization === undefined
  ) {
    return value;
  }
  return {
    ...value,
    args: {
      ...value.args,
      authorization: {
        ...value.args.authorization,
        password: "[redacted]",
      },
    },
  };
};
