/**
 * Main-owned Fleet compatibility projection.
 *
 * The shape is shared because Electron IPC, owner-local operator control, and
 * renderer consumers must agree on one snapshot. Only Main derives it from
 * observations. Missing producer evidence stays explicit and can never become
 * an Exact compatibility claim.
 */

import { Schema } from "effect";
import type { HostDeployJobSnapshot } from "./deploy-job";
import type {
  SemanticCompatibilityStatus,
  SemanticDifference,
} from "./semantic-compatibility-adapter";
import type { StationProjectionReference } from "./station-api";
import {
  CURRENT_STATION_PROTOCOL_SUPPORT,
  StationProtocolSupport,
  StationProtocolVersion,
} from "./station-protocol";
import type { StationRemoteObservation } from "./station-status";

export const FLEET_EVIDENCE_STALE_AFTER_MS = 5 * 60 * 1_000;

const BoundedText = Schema.String.pipe(Schema.check(Schema.isMaxLength(4_096)));
const BoundedId = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(512)),
);
const NonNegativeInteger = Schema.Number.pipe(
  Schema.check(Schema.isInt()),
  Schema.check(Schema.isGreaterThanOrEqualTo(0)),
);
const NonNegativeNumber = Schema.Number.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(0)),
);

export const FleetCompatibilityStatus = Schema.Literals([
  "exact",
  "warning-exact",
  "restricted-hold",
  "unsupported",
  "no-common",
  "stale-evidence",
  "checking",
  "unreachable",
]);
export type FleetCompatibilityStatus = typeof FleetCompatibilityStatus.Type;

export const FleetEvidence = Schema.Union([
  Schema.Struct({ state: Schema.Literal("missing") }),
  Schema.Struct({
    state: Schema.Literals(["fresh", "stale"]),
    observedAt: Schema.String,
    source: Schema.optionalKey(Schema.Literals(["live", "last-acknowledged"])),
  }),
]);
export type FleetEvidence = typeof FleetEvidence.Type;

export const FleetProtocolStatus = Schema.Struct({
  state: Schema.Literals(["missing", "selected", "no-common"]),
  negotiated: Schema.optionalKey(StationProtocolVersion),
  localSupport: StationProtocolSupport,
  peerSupport: Schema.optionalKey(StationProtocolSupport),
  isDeprecated: Schema.optionalKey(Schema.Boolean),
});
export type FleetProtocolStatus = typeof FleetProtocolStatus.Type;

const FleetSemanticDifference = Schema.Struct({
  aspect: Schema.Literals([
    "grant",
    "effect",
    "transition",
    "operation",
    "acceptance",
    "field",
  ]),
  detail: BoundedText,
});

export const FleetSemanticStatus = Schema.Struct({
  state: Schema.Literals(["missing", "known"]),
  status: Schema.optionalKey(
    Schema.Literals(["exact", "restricted", "unsupported"]),
  ),
  withheldSemantics: Schema.optionalKey(
    Schema.Array(FleetSemanticDifference).pipe(
      Schema.check(Schema.isMaxLength(256)),
    ),
  ),
  reasons: Schema.optionalKey(
    Schema.Array(BoundedText).pipe(Schema.check(Schema.isMaxLength(256))),
  ),
});
export type FleetSemanticStatus = typeof FleetSemanticStatus.Type;

export const FleetProjectionStatus = Schema.Struct({
  state: Schema.Literals(["missing", "known"]),
  generation: Schema.optionalKey(Schema.String),
  contentSha256: Schema.optionalKey(Schema.String),
  receivedAt: Schema.optionalKey(Schema.String),
  isLastValidRetained: Schema.optionalKey(Schema.Boolean),
  freshness: Schema.Literals(["fresh", "stale", "missing"]),
});
export type FleetProjectionStatus = typeof FleetProjectionStatus.Type;

export const FleetHeldRouteHead = Schema.Struct({
  eventHome: BoundedId,
  entityHome: BoundedId,
  seq: BoundedId,
  reason: BoundedText,
});
export type FleetHeldRouteHead = typeof FleetHeldRouteHead.Type;

export const FleetRouteBacklog = Schema.Struct({
  state: Schema.Literals(["missing", "known"]),
  pendingCount: Schema.optionalKey(NonNegativeInteger),
  heldRouteHead: Schema.optionalKey(FleetHeldRouteHead),
});
export type FleetRouteBacklog = typeof FleetRouteBacklog.Type;

export const FleetUpdateStatus = Schema.Struct({
  state: Schema.Literals(["missing", "known"]),
  phase: Schema.optionalKey(
    Schema.Literals(["running", "succeeded", "failed", "auth-required"]),
  ),
  jobId: Schema.optionalKey(BoundedId),
  detail: Schema.optionalKey(BoundedText),
  percent: Schema.optionalKey(NonNegativeNumber),
  targetVersion: Schema.optionalKey(BoundedId),
  updatedAt: Schema.optionalKey(Schema.String),
  recovery: Schema.optionalKey(
    Schema.Struct({
      required: Schema.Literal(true),
      hint: Schema.optionalKey(BoundedText),
    }),
  ),
});
export type FleetUpdateStatus = typeof FleetUpdateStatus.Type;

export const FleetPeerCompatibilitySnapshot = Schema.Struct({
  hostId: BoundedId,
  installationId: Schema.optionalKey(BoundedId),
  status: FleetCompatibilityStatus,
  headline: BoundedText,
  detail: BoundedText,
  reachability: Schema.Literals([
    "reachable",
    "unreachable",
    "probing",
    "unknown",
  ]),
  protocol: FleetProtocolStatus,
  semantic: FleetSemanticStatus,
  projection: FleetProjectionStatus,
  workBacklog: FleetRouteBacklog,
  affectedNodes: Schema.optionalKey(
    Schema.Array(BoundedId).pipe(Schema.check(Schema.isMaxLength(4_096))),
  ),
  update: FleetUpdateStatus,
  evidence: FleetEvidence,
});
export type FleetPeerCompatibilitySnapshot =
  typeof FleetPeerCompatibilitySnapshot.Type;

export type FleetSemanticCompatibilityObservation = {
  readonly status: SemanticCompatibilityStatus;
  readonly withheldSemantics?: ReadonlyArray<SemanticDifference>;
  readonly reasons?: ReadonlyArray<string>;
};

export type FleetKnownRouteBacklog = {
  readonly pendingCount: number;
  readonly heldRouteHead?: FleetHeldRouteHead;
};

export interface DeriveFleetCompatibilityInput {
  readonly hostId: string;
  readonly installationId?: string;
  readonly remoteObservation?: StationRemoteObservation;
  /** Local Remote projection receipt, when Doctor has no peer observation. */
  readonly projectionReceipt?: StationProjectionReference;
  /** Only a real proof-carrying analyzer result may populate this field. */
  readonly semanticObservation?: FleetSemanticCompatibilityObservation;
  /** Only a production repository query may populate this field. */
  readonly workBacklog?: FleetKnownRouteBacklog;
  /** Exact operator-impact nodes, when a producer has computed them. */
  readonly affectedNodes?: ReadonlyArray<string>;
  /** Real Main-owned deploy job. Absence means missing, not idle or success. */
  readonly deployJob?: HostDeployJobSnapshot;
  readonly nowMs?: number;
}

const timestampFreshness = (
  value: string | undefined,
  nowMs: number,
): "fresh" | "stale" | "missing" => {
  if (value === undefined) return "missing";
  const observedAt = Date.parse(value);
  if (!Number.isFinite(observedAt) || !Number.isFinite(nowMs)) return "missing";
  if (observedAt > nowMs || nowMs - observedAt > FLEET_EVIDENCE_STALE_AFTER_MS) {
    return "stale";
  }
  return "fresh";
};

const protocolFromObservation = (
  observation: StationRemoteObservation["protocol"],
): FleetProtocolStatus => {
  if (observation === undefined) {
    return {
      state: "missing",
      localSupport: CURRENT_STATION_PROTOCOL_SUPPORT,
    };
  }
  if (observation.compatibility === "update-required") {
    return {
      state: "no-common",
      localSupport: observation.local.support,
      peerSupport: observation.peer.support,
    };
  }
  return {
    state: "selected",
    negotiated: observation.negotiatedProtocol,
    localSupport: observation.local.support,
    peerSupport: observation.peer.support,
    isDeprecated: observation.compatibility === "deprecated",
  };
};

const semanticFromObservation = (
  observation: FleetSemanticCompatibilityObservation | undefined,
): FleetSemanticStatus =>
  observation === undefined
    ? { state: "missing" }
    : {
        state: "known",
        status: observation.status,
        withheldSemantics: [...(observation.withheldSemantics ?? [])],
        reasons: [...(observation.reasons ?? [])],
      };

const updateFromDeployJob = (
  job: HostDeployJobSnapshot | undefined,
  hostId: string,
): FleetUpdateStatus => {
  if (job === undefined || job.hostId !== hostId) return { state: "missing" };
  const recoveryRequired =
    job.status === "auth_required" || job.recoveryHint !== undefined;
  return {
    state: "known",
    phase:
      job.status === "auth_required"
        ? "auth-required"
        : job.status === "running"
          ? "running"
          : job.status === "succeeded"
            ? "succeeded"
            : "failed",
    jobId: job.jobId,
    detail: job.detail,
    percent: job.percent,
    ...(job.version === undefined ? {} : { targetVersion: job.version }),
    updatedAt: job.updatedAt,
    ...(recoveryRequired
      ? {
          recovery: {
            required: true as const,
            ...(job.recoveryHint === undefined ? {} : { hint: job.recoveryHint }),
          },
        }
      : {}),
  };
};

const primaryCopy = (
  status: FleetCompatibilityStatus,
): Pick<FleetPeerCompatibilitySnapshot, "headline" | "detail"> => {
  switch (status) {
    case "exact":
      return {
        headline: "Fully compatible",
        detail: "Fresh protocol and semantic evidence prove exact compatibility.",
      };
    case "warning-exact":
      return {
        headline: "Compatible with a protocol warning",
        detail: "Compatibility is exact, but the selected Station protocol is below a warning threshold.",
      };
    case "restricted-hold":
      return {
        headline: "Synchronization held",
        detail: "A restricted semantic result or a held Work route head prevents synchronization from advancing.",
      };
    case "unsupported":
      return {
        headline: "Compatibility unsupported",
        detail: "Semantic evidence is unsupported. The last valid projection remains authoritative.",
      };
    case "no-common":
      return {
        headline: "Update required for Station protocol",
        detail: "The peers have no common selected Station codec. The last valid projection remains authoritative.",
      };
    case "stale-evidence":
      return {
        headline: "Compatibility evidence is stale",
        detail: "Retained observations remain visible, but they do not prove current compatibility.",
      };
    case "unreachable":
      return {
        headline: "Host unreachable",
        detail: "The transport observation is unreachable. The Remote continues under its last valid projection.",
      };
    case "checking":
      return {
        headline: "Checking compatibility",
        detail: "Required protocol or semantic evidence is missing or still being observed.",
      };
  }
};

/**
 * Pure projection used by Main. Callers must pass observations, never renderer
 * guesses based on reachability, app version, or SQLite schema version.
 */
export const deriveFleetCompatibilitySnapshot = (
  input: DeriveFleetCompatibilityInput,
): FleetPeerCompatibilitySnapshot => {
  const nowMs = input.nowMs ?? Date.now();
  const remote = input.remoteObservation;
  const reachability = remote?.reachability ?? "unknown";
  const protocol = protocolFromObservation(remote?.protocol);

  const observedAt = remote?.observedAt ?? remote?.station?.observedAt;
  const timestampEvidenceFreshness = timestampFreshness(observedAt, nowMs);
  const evidenceFreshness =
    remote?.source === "last-acknowledged" &&
    timestampEvidenceFreshness !== "missing"
      ? "stale"
      : timestampEvidenceFreshness;
  const evidence: FleetEvidence =
    evidenceFreshness === "missing" || observedAt === undefined
      ? { state: "missing" }
      : {
          state: evidenceFreshness,
          observedAt,
          ...(remote?.source === undefined ? {} : { source: remote.source }),
        };

  const projectionReceipt =
    remote?.station?.projection ?? input.projectionReceipt;
  const projectionFreshness = timestampFreshness(
    projectionReceipt?.receivedAt,
    nowMs,
  );
  const semantic = semanticFromObservation(input.semanticObservation);
  const workBacklog: FleetRouteBacklog =
    input.workBacklog === undefined
      ? { state: "missing" }
      : {
          state: "known",
          pendingCount: input.workBacklog.pendingCount,
          ...(input.workBacklog.heldRouteHead === undefined
            ? {}
            : { heldRouteHead: input.workBacklog.heldRouteHead }),
        };

  let status: FleetCompatibilityStatus;
  if (reachability === "unreachable") {
    status = "unreachable";
  } else if (protocol.state === "no-common") {
    status = "no-common";
  } else if (evidence.state === "stale") {
    status = "stale-evidence";
  } else if (
    workBacklog.state === "known" &&
    workBacklog.heldRouteHead !== undefined
  ) {
    status = "restricted-hold";
  } else if (
    semantic.state === "known" &&
    semantic.status === "restricted"
  ) {
    status = "restricted-hold";
  } else if (
    semantic.state === "known" &&
    semantic.status === "unsupported"
  ) {
    status = "unsupported";
  } else if (
    reachability === "reachable" &&
    remote?.source === "live" &&
    remote.route?.phase === "ready" &&
    remote.route.sessionOpen &&
    protocol.state === "selected" &&
    semantic.state === "known" &&
    semantic.status === "exact" &&
    evidence.state === "fresh"
  ) {
    status = protocol.isDeprecated === true ? "warning-exact" : "exact";
  } else {
    status = "checking";
  }

  const projection: FleetProjectionStatus =
    projectionReceipt === undefined
      ? { state: "missing", freshness: "missing" }
      : {
          state: "known",
          generation: projectionReceipt.generation,
          contentSha256: projectionReceipt.contentSha256,
          receivedAt: projectionReceipt.receivedAt,
          isLastValidRetained:
            status === "no-common" ||
            status === "unreachable" ||
            status === "restricted-hold" ||
            status === "unsupported" ||
            status === "stale-evidence",
          freshness: projectionFreshness,
        };

  const installationId =
    input.installationId ??
    remote?.station?.installationId ??
    remote?.expectedInstallationId;
  const copy = primaryCopy(status);

  return {
    hostId: input.hostId,
    ...(installationId === undefined ? {} : { installationId }),
    status,
    ...copy,
    reachability,
    protocol,
    semantic,
    projection,
    workBacklog,
    ...(input.affectedNodes === undefined
      ? {}
      : { affectedNodes: [...input.affectedNodes] }),
    update: updateFromDeployJob(input.deployJob, input.hostId),
    evidence,
  };
};
