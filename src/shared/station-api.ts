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
} from "./installation-id";
import { RouteCursor } from "./work-protocol";
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
  `junto/station-api/v${STATION_PROTOCOL_BASELINE}` as const;

export const STATION_API_MAX_PROJECTION_CHARS = 64 * 1024 * 1024;
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
