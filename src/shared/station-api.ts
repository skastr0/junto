import { Schema } from "effect";
import { STATION_ROLES } from "./station";
import { StationBrowserPinnedTrustRecord } from "./station-browser";

/**
 * Station API v1.
 *
 * This is the shared seam between a Command Center and a Remote installation.
 * It deliberately contains no bearer tokens, route tokens, filesystem paths,
 * or other credentials. The transport authenticates the peer before decoding
 * one of these messages; identifiers in this contract are routing facts, not
 * authority.
 */
export const STATION_API_PROTOCOL = "vellum/station-api/v1" as const;

export const STATION_API_MAX_PROJECTION_CHARS = 64 * 1024 * 1024;
export const STATION_API_MAX_EVENT_CHARS = 256 * 1024;
export const STATION_API_MAX_EVENTS_PER_REPORT = 256;
export const STATION_API_MAX_ACKS_PER_REPORT = 256;
export const STATION_API_MAX_STATUS_CURSORS = 256;

/** Stable identity of one Vellum database installation. */
export const InstallationId = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(128),
  Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  Schema.brand("InstallationId"),
);
export type InstallationId = typeof InstallationId.Type;

/** User-selected station role. It is never inferred by this protocol. */
export const StationApiRole = Schema.Literal(...STATION_ROLES);
export type StationApiRole = typeof StationApiRole.Type;

/** Host label used by canvas placement and the local execution plane. */
export const StationHostId = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(64),
  Schema.pattern(/^(?!-)[A-Za-z0-9][A-Za-z0-9._-]*$/),
  Schema.brand("StationHostId"),
);
export type StationHostId = typeof StationHostId.Type;

/**
 * Canonical non-negative decimal logical number.
 *
 * It remains a string on the wire and in the domain. Ordering converts to
 * BigInt; Number and wall-clock timestamps never participate.
 */
export const LogicalSequence = Schema.String.pipe(
  Schema.pattern(/^(0|[1-9][0-9]*)$/),
  Schema.maxLength(32),
  Schema.brand("LogicalSequence"),
);
export type LogicalSequence = typeof LogicalSequence.Type;

export const StationSha256 = Schema.String.pipe(
  Schema.pattern(/^[a-f0-9]{64}$/),
  Schema.brand("StationSha256"),
);
export type StationSha256 = typeof StationSha256.Type;

/**
 * Display-only timestamp carried for operator history. No decision helper in
 * this module accepts it as an ordering input.
 */
export const DisplayTimestamp = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(64),
);
export type DisplayTimestamp = typeof DisplayTimestamp.Type;

const StationLabel = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(128),
);

const AppVersion = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(64),
);

const CommandCenterRef = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(255),
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
  commandCenterRef: CommandCenterRef,
  supervisedPreferred: Schema.Boolean,
  browserTrust: Schema.optionalWith(StationBrowserPinnedTrustRecord, {
    exact: true,
  }),
});
export type RemoteConfiguration = typeof RemoteConfiguration.Type;

/**
 * Role-specific topology. A Remote cannot be configured without its Command
 * Center identity and reachability; a Command Center cannot accidentally
 * retain Remote-only fields in its decoded configuration.
 */
export const StationConfiguration = Schema.Union(
  CommandCenterConfiguration,
  RemoteConfiguration,
);
export type StationConfiguration = typeof StationConfiguration.Type;

export const ConfigureRequest = Schema.Struct({
  protocol: Schema.Literal(STATION_API_PROTOCOL),
  op: Schema.Literal("configure"),
  installationId: InstallationId,
  // The fleet wire can only establish a Remote. Command Center authority is
  // selected locally in the Electron main process and is not representable in
  // an SSH Station request.
  configuration: RemoteConfiguration,
});
export type ConfigureRequest = typeof ConfigureRequest.Type;

export const ConfigureResponse = Schema.Struct({
  protocol: Schema.Literal(STATION_API_PROTOCOL),
  op: Schema.Literal("configure"),
  installationId: InstallationId,
  configuration: RemoteConfiguration,
  configuredAt: DisplayTimestamp,
});
export type ConfigureResponse = typeof ConfigureResponse.Type;

/** Complete projection body. Each accepted generation replaces the prior one. */
export const StationProjectionBody = Schema.Struct({
  scope: Schema.Literal("full"),
  generation: LogicalSequence,
  body: Schema.String.pipe(Schema.maxLength(STATION_API_MAX_PROJECTION_CHARS)),
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

export const ProjectionInstallDecision = Schema.Literal(
  "install",
  "idempotent",
  "stale",
  "conflict",
);
export type ProjectionInstallDecision = typeof ProjectionInstallDecision.Type;

export const ProjectResponse = Schema.Struct({
  protocol: Schema.Literal(STATION_API_PROTOCOL),
  op: Schema.Literal("project"),
  stationInstallationId: InstallationId,
  decision: ProjectionInstallDecision,
  active: StationProjectionReference,
});
export type ProjectResponse = typeof ProjectResponse.Type;

/**
 * Identity in one authenticated Station route.
 *
 * `home` is the source installation and `sequence` is monotonic for the
 * source→target route. The report target supplies the other half of that
 * identity, so two Remotes may each originate sequence 1 without collision.
 */
export const StationEventIdentity = Schema.Struct({
  home: InstallationId,
  sequence: LogicalSequence,
});
export type StationEventIdentity = typeof StationEventIdentity.Type;

/**
 * A cumulative transport acknowledgement: every event for `home` through
 * `sequence` has been handled contiguously. A Remote command is handled only
 * after an ordered durable applied/rejected disposition exists. Gaps may never
 * be skipped; ACK timing never decides material authority.
 */
export const StationEventAck = Schema.Struct({
  home: InstallationId,
  through: LogicalSequence,
});
export type StationEventAck = typeof StationEventAck.Type;

export const StationEvent = Schema.Struct({
  identity: StationEventIdentity,
  kind: Schema.String.pipe(
    Schema.minLength(1),
    Schema.maxLength(64),
    Schema.pattern(/^[A-Za-z][A-Za-z0-9._:-]*$/),
  ),
  body: Schema.String.pipe(Schema.maxLength(STATION_API_MAX_EVENT_CHARS)),
  /** Hash of the event's canonical semantic content, excluding timestamps. */
  contentSha256: StationSha256,
  originAt: DisplayTimestamp,
  receivedAt: Schema.optionalWith(DisplayTimestamp, { exact: true }),
});
export type StationEvent = typeof StationEvent.Type;

/**
 * Command Center → Station half of the duplex report exchange.
 *
 * `outbound` carries CC-originated events for this Station beyond its ACK.
 * `acknowledgeInbound` cumulatively ACKs Station-homed events accepted by CC.
 */
export const ReportRequest = Schema.Struct({
  protocol: Schema.Literal(STATION_API_PROTOCOL),
  op: Schema.Literal("report"),
  stationInstallationId: InstallationId,
  outbound: Schema.Array(StationEvent).pipe(
    Schema.maxItems(STATION_API_MAX_EVENTS_PER_REPORT),
  ),
  acknowledgeInbound: Schema.Array(StationEventAck).pipe(
    Schema.maxItems(STATION_API_MAX_ACKS_PER_REPORT),
  ),
});
export type ReportRequest = typeof ReportRequest.Type;

/**
 * Station → Command Center half of the duplex report exchange.
 *
 * `inbound` carries Station-originated events beyond CC's last ACK.
 * `acknowledgeOutbound` cumulatively ACKs CC-originated events accepted by
 * this Station.
 */
export const ReportResponse = Schema.Struct({
  protocol: Schema.Literal(STATION_API_PROTOCOL),
  op: Schema.Literal("report"),
  stationInstallationId: InstallationId,
  inbound: Schema.Array(StationEvent).pipe(
    Schema.maxItems(STATION_API_MAX_EVENTS_PER_REPORT),
  ),
  acknowledgeOutbound: Schema.Array(StationEventAck).pipe(
    Schema.maxItems(STATION_API_MAX_ACKS_PER_REPORT),
  ),
});
export type ReportResponse = typeof ReportResponse.Type;

export const StatusRequest = Schema.Struct({
  protocol: Schema.Literal(STATION_API_PROTOCOL),
  op: Schema.Literal("status"),
});
export type StatusRequest = typeof StatusRequest.Type;

export const StationApiStatusState = Schema.Literal(
  "unenrolled",
  "paired",
  "configured",
  "ready",
  "degraded",
);
export type StationApiStatusState = typeof StationApiStatusState.Type;

export const StationReadiness = Schema.Struct({
  database: Schema.Boolean,
  workControl: Schema.Boolean,
  simulation: Schema.Boolean,
});
export type StationReadiness = typeof StationReadiness.Type;

export const StatusResponse = Schema.Struct({
  protocol: Schema.Literal(STATION_API_PROTOCOL),
  op: Schema.Literal("status"),
  installationId: InstallationId,
  state: StationApiStatusState,
  configuration: Schema.optionalWith(StationConfiguration, { exact: true }),
  configuredAt: Schema.optionalWith(DisplayTimestamp, { exact: true }),
  projection: Schema.optionalWith(StationProjectionReference, { exact: true }),
  receivedThrough: Schema.Array(StationEventAck).pipe(
    Schema.maxItems(STATION_API_MAX_STATUS_CURSORS),
  ),
  readiness: StationReadiness,
  observedAt: DisplayTimestamp,
});
export type StatusResponse = typeof StatusResponse.Type;

export const StationApiRequest = Schema.Union(
  PairRequest,
  ConfigureRequest,
  ProjectRequest,
  ReportRequest,
  StatusRequest,
);
export type StationApiRequest = typeof StationApiRequest.Type;

export const StationApiResponse = Schema.Union(
  PairResponse,
  ConfigureResponse,
  ProjectResponse,
  ReportResponse,
  StatusResponse,
);
export type StationApiResponse = typeof StationApiResponse.Type;

/** BigInt comparison for decimal logical numbers. */
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

export type AckAdvanceDecision =
  | {
      readonly _tag: "advanced";
      readonly cursor: StationEventAck;
    }
  | {
      readonly _tag: "idempotent";
      readonly cursor: StationEventAck;
    }
  | {
      readonly _tag: "regression";
      readonly cursor: StationEventAck;
      readonly rejected: StationEventAck;
    }
  | {
      readonly _tag: "home-mismatch";
      readonly cursor: StationEventAck;
      readonly rejected: StationEventAck;
    };

/**
 * Decide a cumulative ACK update without mutating the current cursor.
 * Regressions and cross-home substitutions retain the admitted cursor.
 */
export const decideAckAdvance = (
  current: StationEventAck | undefined,
  proposed: StationEventAck,
): AckAdvanceDecision => {
  if (current === undefined) {
    return { _tag: "advanced", cursor: proposed };
  }
  if (current.home !== proposed.home) {
    return { _tag: "home-mismatch", cursor: current, rejected: proposed };
  }

  const order = compareLogicalSequence(proposed.through, current.through);
  if (order > 0) return { _tag: "advanced", cursor: proposed };
  if (order === 0) return { _tag: "idempotent", cursor: current };
  return { _tag: "regression", cursor: current, rejected: proposed };
};

/**
 * Advance one home's cursor only across a contiguous run. Duplicate and stale
 * identities are harmless; identities for other homes are irrelevant.
 */
export const contiguousReceivedThrough = (
  current: StationEventAck,
  received: ReadonlyArray<StationEventIdentity>,
): StationEventAck => {
  const sequences = new Map<string, LogicalSequence>();
  for (const identity of received) {
    if (identity.home !== current.home) continue;
    sequences.set(identity.sequence, identity.sequence);
  }

  let next = BigInt(current.through) + 1n;
  let through = current.through;
  while (true) {
    const admitted = sequences.get(next.toString());
    if (admitted === undefined) break;
    through = admitted;
    next += 1n;
  }
  return through === current.through
    ? current
    : { home: current.home, through };
};

export type CoalesceStationEventsDecision =
  | {
      readonly _tag: "accepted";
      readonly events: ReadonlyArray<StationEvent>;
    }
  | {
      readonly _tag: "identity-conflict";
      readonly identity: StationEventIdentity;
      readonly admittedContentSha256: StationSha256;
      readonly rejectedContentSha256: StationSha256;
    };

const stationEventIdentityKey = (identity: StationEventIdentity): string =>
  `${identity.home}\u0000${identity.sequence}`;

/**
 * Collapse idempotent report retries by `(home, sequence)`.
 *
 * Reusing an identity for different semantic content is an explicit conflict,
 * not last-write-wins ordering.
 */
export const coalesceStationEvents = (
  events: ReadonlyArray<StationEvent>,
): CoalesceStationEventsDecision => {
  const byIdentity = new Map<string, StationEvent>();
  for (const event of events) {
    const key = stationEventIdentityKey(event.identity);
    const admitted = byIdentity.get(key);
    if (admitted === undefined) {
      byIdentity.set(key, event);
      continue;
    }
    if (admitted.contentSha256 !== event.contentSha256) {
      return {
        _tag: "identity-conflict",
        identity: event.identity,
        admittedContentSha256: admitted.contentSha256,
        rejectedContentSha256: event.contentSha256,
      };
    }
  }
  return { _tag: "accepted", events: [...byIdentity.values()] };
};
