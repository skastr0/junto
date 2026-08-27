/**
 * Derived Fleet Compatibility Snapshot Model.
 *
 * Exposes a unified, coherent operator compatibility assessment for each fleet peer:
 * - Transport reachability (probing / reachable / unreachable)
 * - Station protocol negotiation (version integer, support range, warning status)
 * - Proof-carrying semantic compatibility (exact / warning-only exact / restricted-analysis hold / unsupported)
 * - Projection freshness & last-valid retention (generation, hash, timestamp)
 * - Work backlog and held route heads
 * - Evidence freshness (fresh / stale / missing)
 * - Update execution state & targets
 *
 * Invariant: No incompatible observation changes projection authority, pending Work, or cursors.
 */

import { Result } from "effect";
import {
  STATION_PROTOCOL_1,
  STATION_PROTOCOL_1_CODECS,
  type StationProtocol1Codecs,
} from "./station-protocol-1-codec";
import {
  CURRENT_STATION_PROTOCOL_SUPPORT,
  STATION_PROTOCOL_BASELINE,
  type StationProtocolSupport,
  type StationProtocolVersion,
  type StationAppVersion,
  type StationStateSchemaVersion,
} from "./station-protocol";
import {
  evaluateGrantCompatibility,
  type SemanticCompatibilityStatus,
  type UnsupportedReasonCode,
  type SemanticDifference,
} from "./semantic-compatibility-adapter";
import type {
  StationProtocolObservation,
  StationRemoteObservation,
  StationTopologyObservation,
} from "./station-status";

/** Primary derived operator label for a fleet peer's compatibility */
export type FleetCompatibilityStatus =
  | "exact"
  | "warning-exact"
  | "restricted-hold"
  | "unsupported"
  | "no-common"
  | "stale-evidence"
  | "checking"
  | "unreachable";

/** Operational update execution states */
export type FleetUpdateExecutionState =
  | "idle"
  | "update-available"
  | "update-running"
  | "update-failed"
  | "recovery-required";

export interface FleetRouteBacklog {
  readonly pendingCount: number;
  readonly heldRouteHead?: {
    readonly eventHome: string;
    readonly entityHome: string;
    readonly seq: string;
    readonly reason: string;
  };
}

export interface FleetProjectionStatus {
  readonly generation: string;
  readonly contentSha256: string;
  readonly receivedAt?: string;
  readonly isLastValidRetained: boolean;
  readonly freshness: "fresh" | "stale" | "missing";
}

export interface FleetPeerCompatibilitySnapshot {
  readonly hostId: string;
  readonly installationId?: string;
  readonly status: FleetCompatibilityStatus;
  readonly headline: string;
  readonly detail: string;
  readonly reachability: "reachable" | "unreachable" | "probing";
  readonly protocol: {
    readonly negotiated?: StationProtocolVersion;
    readonly localSupport: StationProtocolSupport;
    readonly peerSupport?: StationProtocolSupport;
    readonly isDeprecated: boolean;
  };
  readonly semantic: {
    readonly status: SemanticCompatibilityStatus;
    readonly withheldSemantics: ReadonlyArray<SemanticDifference>;
    readonly reasons: ReadonlyArray<string>;
  };
  readonly projection: FleetProjectionStatus;
  readonly workBacklog: FleetRouteBacklog;
  readonly affectedNodes: ReadonlyArray<string>;
  readonly update: {
    readonly state: FleetUpdateExecutionState;
    readonly targetVersion?: string;
    readonly errorMessage?: string;
  };
  readonly evidenceTimestamp?: string;
}

/** Stale observation threshold (5 minutes for active fleet observation) */
export const FLEET_EVIDENCE_STALE_AFTER_MS = 5 * 60 * 1_000;

export interface DeriveFleetCompatibilityInput {
  readonly hostId: string;
  readonly reachabilityStatus?: "probing" | "reachable" | "unreachable";
  readonly protocolObservation?: StationProtocolObservation;
  readonly remoteObservation?: StationRemoteObservation;
  readonly topology?: StationTopologyObservation;
  readonly updateState?: {
    readonly state: FleetUpdateExecutionState;
    readonly targetVersion?: string;
    readonly errorMessage?: string;
  };
  readonly workBacklog?: FleetRouteBacklog;
  readonly nowMs?: number;
}

/**
 * Derive one unified compatibility snapshot for an enrolled fleet peer.
 */
export const deriveFleetCompatibilitySnapshot = (
  input: DeriveFleetCompatibilityInput,
): FleetPeerCompatibilitySnapshot => {
  const now = input.nowMs ?? Date.now();
  const reachability = input.reachabilityStatus ?? "probing";
  const protoObs = input.protocolObservation;
  const remoteObs = input.remoteObservation;
  const updateState = input.updateState ?? { state: "idle" };
  const workBacklog = input.workBacklog ?? { pendingCount: 0 };

  const observedAtStr = remoteObs?.observedAt;
  const observedAtMs = observedAtStr !== undefined ? Date.parse(observedAtStr) : undefined;
  const isStale =
    observedAtMs !== undefined && !Number.isNaN(observedAtMs)
      ? now - observedAtMs > FLEET_EVIDENCE_STALE_AFTER_MS
      : false;

  const localSupport = CURRENT_STATION_PROTOCOL_SUPPORT;
  const peerSupport = protoObs?.peer?.support;

  // Determine protocol compatibility & negotiated version
  const negotiated =
    protoObs !== undefined && protoObs.compatibility !== "update-required"
      ? protoObs.negotiatedProtocol
      : undefined;

  const isDeprecated =
    protoObs?.compatibility === "deprecated" ||
    (negotiated !== undefined &&
      (negotiated < localSupport.warnBelow ||
        (peerSupport !== undefined && negotiated < peerSupport.warnBelow)));

  const noCommon =
    protoObs?.compatibility === "update-required" ||
    (protoObs === undefined && reachability === "reachable" && peerSupport !== undefined &&
      (peerSupport.preferred < localSupport.compatibleFrom || localSupport.preferred < peerSupport.compatibleFrom));

  // Determine projection status
  const projectionGen = remoteObs?.station?.projection?.generation ?? "0";
  const projectionSha = remoteObs?.station?.projection?.contentSha256 ?? "";
  const projectionReceivedAt = remoteObs?.station?.projection?.receivedAt;
  const hasProjection = projectionGen !== "0" && projectionSha.length > 0;

  const projection: FleetProjectionStatus = {
    generation: projectionGen,
    contentSha256: projectionSha,
    ...(projectionReceivedAt ? { receivedAt: projectionReceivedAt } : {}),
    isLastValidRetained: hasProjection && (noCommon || reachability === "unreachable"),
    freshness: !hasProjection ? "missing" : isStale ? "stale" : "fresh",
  };

  // Derive affected node IDs from topology if available
  const affectedNodes: string[] = [];
  if (remoteObs?.station?.installationId) {
    affectedNodes.push(remoteObs.station.installationId);
  } else if (remoteObs?.expectedInstallationId) {
    affectedNodes.push(remoteObs.expectedInstallationId);
  }

  // Determine Semantic Compatibility
  let semanticStatus: SemanticCompatibilityStatus = "exact";
  const withheldSemantics: SemanticDifference[] = [];
  const semanticReasons: string[] = [];

  if (noCommon) {
    semanticStatus = "unsupported";
    semanticReasons.push("Station peers share no common protocol version integer");
  } else if (workBacklog.heldRouteHead !== undefined) {
    semanticStatus = "restricted";
    semanticReasons.push(workBacklog.heldRouteHead.reason);
    withheldSemantics.push({
      aspect: "operation",
      detail: `Outbound work record ${workBacklog.heldRouteHead.seq} held: ${workBacklog.heldRouteHead.reason}`,
    });
  }

  // Derive top-level status & headlines
  let status: FleetCompatibilityStatus = "exact";
  let headline = "Fully compatible";
  let detail = "Operating under exact Station protocol 1 and synchronized intent.";

  if (reachability === "unreachable") {
    status = "unreachable";
    headline = "Host unreachable";
    detail = "Transport connection lost. Remote continues executing under its last valid projection.";
  } else if (reachability === "probing") {
    status = "checking";
    headline = "Checking connectivity";
    detail = "Probing remote station reachability and protocol preface...";
  } else if (noCommon) {
    status = "no-common";
    headline = "Update required (Protocol mismatch)";
    detail = "Peers have no common Station protocol. Local execution continues under last valid projection.";
  } else if (isStale) {
    status = "stale-evidence";
    headline = "Stale status observation";
    detail = `Last status report received ${Math.round((now - (observedAtMs ?? 0)) / 1000)}s ago.`;
  } else if (semanticStatus === "restricted") {
    status = "restricted-hold";
    headline = "Restricted compatibility (Work held)";
    detail = "New capability withheld to prevent data divergence. Existing projection and work remain active.";
  } else if (isDeprecated) {
    status = "warning-exact";
    headline = "Compatible (Deprecation warning)";
    detail = "Station protocol integer is below recommended threshold. Consider upgrading soon.";
  } else if (updateState.state === "update-failed") {
    status = "exact"; // Protocol might be fine, but update failed
    headline = "Update failed";
    detail = updateState.errorMessage ?? "Automatic upgrade failed on remote host.";
  } else if (updateState.state === "update-running") {
    status = "exact";
    headline = "Update in progress";
    detail = `Deploying update target ${updateState.targetVersion ?? "latest"}...`;
  } else if (updateState.state === "update-available") {
    status = "exact";
    headline = "Update available";
    detail = `New package version ${updateState.targetVersion} is ready to install.`;
  }

  const installationId =
    remoteObs?.station?.installationId ?? remoteObs?.expectedInstallationId;

  return {
    hostId: input.hostId,
    ...(installationId ? { installationId } : {}),
    status,
    headline,
    detail,
    reachability,
    protocol: {
      ...(negotiated !== undefined ? { negotiated } : {}),
      localSupport,
      ...(peerSupport !== undefined ? { peerSupport } : {}),
      isDeprecated,
    },
    semantic: {
      status: semanticStatus,
      withheldSemantics,
      reasons: semanticReasons,
    },
    projection,
    workBacklog,
    affectedNodes,
    update: updateState,
    ...(observedAtStr ? { evidenceTimestamp: observedAtStr } : {}),
  };
};
