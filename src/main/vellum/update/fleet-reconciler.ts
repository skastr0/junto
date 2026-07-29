/**
 * Fleet Remote update reconciler — pure planning + sequential walk hooks.
 *
 * No durable rollout queue. After every CC restart the plan is re-derived from:
 *   stable feed version − observed Remote versions
 *
 * Auto-walk only when:
 *   remoteManagedInstalls ∧ availableRelease.version === CC version
 * Actual deploy remains gated by RELEASE_CAPABILITIES + operator kill-switch until
 * real qualification). This module never invents a second installer.
 */

import {
  deriveRemoteUpdateStatus,
  shouldAutoWalkRemoteUpdate,
  type RemoteUpdatePhase,
  type RemoteUpdateStatus,
} from "@shared/remote-update-status";
import { admitsRemoteAutoRollout } from "./domain";

export type FleetRemoteObservation = {
  readonly hostId: string;
  readonly platform: "darwin" | "linux" | "unknown";
  readonly installedVersion: string | undefined;
  readonly phase?: RemoteUpdatePhase;
};

export type FleetUpdatePlanItem = {
  readonly hostId: string;
  readonly platform: "darwin" | "linux" | "unknown";
  readonly status: RemoteUpdateStatus;
  readonly eligibleForAutoDeploy: boolean;
};

export type FleetUpdatePlan = {
  readonly commandCenterVersion: string;
  readonly availableReleaseVersion: string | undefined;
  readonly autoWalk: boolean;
  readonly items: ReadonlyArray<FleetUpdatePlanItem>;
};

/**
 * Derive the fleet update plan from live observations + feed version.
 * Concurrency is always one at the walker — callers must not fan out.
 */
export const planFleetRemoteUpdates = (input: {
  readonly commandCenterVersion: string;
  readonly availableReleaseVersion: string | undefined;
  readonly remoteManagedInstalls: boolean;
  readonly remotes: ReadonlyArray<FleetRemoteObservation>;
}): FleetUpdatePlan => {
  const available = input.availableReleaseVersion?.trim() || undefined;
  const cc = input.commandCenterVersion.trim();
  const autoWalk = shouldAutoWalkRemoteUpdate({
    availableRemoteReleaseVersion: available,
    commandCenterVersion: cc,
    remoteManagedInstalls: input.remoteManagedInstalls,
  });
  const admits =
    available !== undefined &&
    admitsRemoteAutoRollout({
      commandCenterVersion: cc,
      targetVersion: available,
    });

  const items = input.remotes.map((remote): FleetUpdatePlanItem => {
    const status = deriveRemoteUpdateStatus({
      ...(remote.installedVersion !== undefined
        ? { installedVersion: remote.installedVersion }
        : {}),
      ...(available !== undefined ? { availableVersion: available } : {}),
      ...(remote.phase !== undefined ? { phase: remote.phase } : {}),
    });
    const versionGap =
      available !== undefined &&
      remote.installedVersion !== undefined &&
      remote.installedVersion.trim() !== available;
    // Quiet / undefined phase means no live install flight; waiting-for-idle
    // and mid-flight phases stay off the auto-deploy queue until idle again.
    const phase = remote.phase?.kind ?? "quiet";
    const phaseAllowsAttempt = phase === "quiet" || phase === "failed";
    const eligibleForAutoDeploy =
      autoWalk &&
      admits &&
      versionGap &&
      (remote.platform === "darwin" || remote.platform === "linux") &&
      phaseAllowsAttempt;

    return {
      hostId: remote.hostId,
      platform: remote.platform,
      status,
      eligibleForAutoDeploy,
    };
  });

  return {
    commandCenterVersion: cc,
    availableReleaseVersion: available,
    autoWalk,
    items,
  };
};

/** Sequential host ids to attempt (concurrency one). */
export const sequentialAutoDeployHostIds = (
  plan: FleetUpdatePlan,
): ReadonlyArray<string> =>
  plan.items.filter((item) => item.eligibleForAutoDeploy).map((item) => item.hostId);

/**
 * CC-first gate for offering Remote updates at all:
 * if the feed is newer than the running CC, only the CC self-update is offered.
 */
export const remotesMayReceiveFeedVersion = (input: {
  readonly commandCenterVersion: string;
  readonly availableReleaseVersion: string | undefined;
}): boolean => {
  const available = input.availableReleaseVersion?.trim();
  if (!available) return false;
  return available === input.commandCenterVersion.trim();
};
