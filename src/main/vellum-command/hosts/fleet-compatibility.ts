import type { HostDeployJobSnapshot } from "@shared/deploy-job";
import {
  deriveFleetCompatibilitySnapshot,
  type FleetKnownRouteBacklog,
  type FleetPeerCompatibilitySnapshot,
  type FleetSemanticCompatibilityObservation,
} from "@shared/fleet-compatibility-snapshot";
import type { StationProjectionReference } from "@shared/station-api";
import type { StationRemoteObservation } from "@shared/station-status";
import { getDeployJob } from "./deploy-job-registry";

export type MainFleetCompatibilityFacts = {
  readonly hostId: string;
  readonly installationId?: string;
  readonly remoteObservation?: StationRemoteObservation;
  readonly projectionReceipt?: StationProjectionReference;
  readonly semanticObservation?: FleetSemanticCompatibilityObservation;
  readonly workBacklog?: FleetKnownRouteBacklog;
  readonly affectedNodes?: ReadonlyArray<string>;
  readonly deployJob?: HostDeployJobSnapshot;
  readonly nowMs?: number;
};

/**
 * Main is the sole composer of the shared Fleet snapshot. Optional inputs are
 * evidence slots, not defaults. A missing semantic analyzer or Work repository
 * query remains missing in the result.
 */
export const composeMainFleetCompatibilitySnapshot = (
  facts: MainFleetCompatibilityFacts,
): FleetPeerCompatibilitySnapshot =>
  deriveFleetCompatibilitySnapshot({
    hostId: facts.hostId,
    ...(facts.installationId === undefined
      ? {}
      : { installationId: facts.installationId }),
    ...(facts.remoteObservation === undefined
      ? {}
      : { remoteObservation: facts.remoteObservation }),
    ...(facts.projectionReceipt === undefined
      ? {}
      : { projectionReceipt: facts.projectionReceipt }),
    ...(facts.semanticObservation === undefined
      ? {}
      : { semanticObservation: facts.semanticObservation }),
    ...(facts.workBacklog === undefined
      ? {}
      : { workBacklog: facts.workBacklog }),
    ...(facts.affectedNodes === undefined
      ? {}
      : { affectedNodes: facts.affectedNodes }),
    ...(facts.deployJob === undefined ? {} : { deployJob: facts.deployJob }),
    ...(facts.nowMs === undefined ? {} : { nowMs: facts.nowMs }),
  });

/** Compose a host-test snapshot from one exact probe and the real deploy job. */
export const composeObservedFleetCompatibilitySnapshot = (
  hostId: string,
  remoteObservation: StationRemoteObservation,
): FleetPeerCompatibilitySnapshot => {
  const deployJob = getDeployJob(hostId);
  return composeMainFleetCompatibilitySnapshot({
    hostId,
    remoteObservation,
    ...(deployJob === undefined ? {} : { deployJob }),
  });
};
