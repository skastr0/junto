/**
 * Fleet managed-update executor — the ONE consumer of the pure fleet
 * reconciler plan (`planFleetRemoteUpdates` / `sequentialAutoDeployHostIds`).
 *
 * The executor never deploys anything itself. Every attempt goes through the
 * canonical hosts operator coordinator (`deployRemote`), which owns the
 * per-host single-flight slot, the release and kill-switch gates, the
 * incumbent maintenance lease, and the active-terminal refusal. There is no
 * second deployment mechanism and no durable rollout queue: after every
 * Command Center restart the walk is re-derived from feed and observed
 * versions (see fleet-reconciler.ts).
 *
 * Concurrency is one: eligible Remotes are walked strictly sequentially.
 */

import type { HostsDeployRemoteResult } from "@shared/ipc";
import {
  remoteUpdatePhaseFromDeployJob,
  resolveRemoteAvailableForStatus,
  type RemoteUpdateDeployJobFacts,
} from "@shared/remote-update-status";
import {
  planFleetRemoteUpdates,
  sequentialAutoDeployHostIds,
  type FleetRemoteObservation,
} from "./fleet-reconciler";

/** Failure attempts consumed per (host, target version) before giving up. */
export const FLEET_UPDATE_MAX_ATTEMPTS = 3;

/** Coarse walk cadence — no tight loops, no sleeps-as-sync. */
export const FLEET_UPDATE_PASS_INTERVAL_MS = 5 * 60_000;

/** First pass waits for boot probes and fleet propagation to settle. */
export const FLEET_UPDATE_FIRST_PASS_DELAY_MS = 90_000;

export type FleetExecutorRemote = {
  readonly hostId: string;
  readonly endpoint: string;
  readonly platform: "darwin" | "linux" | "unknown";
  readonly installedVersion: string | undefined;
};

/**
 * Pure projection of enrolled hosts and observed peer versions into executor
 * targets. Best-effort platform observation only: Box-enrolled machines are
 * Linux, everything else is treated as macOS. HostRuntime re-verifies the
 * real platform (uname) at apply admission and refuses safely, so a
 * misclassified target never installs the wrong package.
 */
export const executorRemotesOf = (
  enrolled: ReadonlyArray<{
    readonly id: string;
    readonly kind: string;
    readonly sshEndpoint?: string;
  }>,
  observedVersions: ReadonlyMap<string, string>,
): ReadonlyArray<FleetExecutorRemote> =>
  enrolled
    .filter(
      (host) => host.kind === "remote" && host.sshEndpoint !== undefined,
    )
    .map((host) => ({
      hostId: host.id,
      endpoint: host.sshEndpoint ?? "",
      platform: host.id.startsWith("box-") ? "linux" : "darwin",
      installedVersion: observedVersions.get(host.id),
    }));

export type FleetUpdateHostDisposition =
  | "waiting-for-idle"
  | "retry-scheduled"
  | "refused"
  | "succeeded";

export type FleetUpdateHostState = {
  readonly targetVersion: string;
  readonly disposition: FleetUpdateHostDisposition;
  /** Failure attempts consumed for this target version. */
  readonly attempts: number;
  readonly detail: string;
  readonly at: string;
};

export type FleetUpdatePassSummary = {
  readonly ran: boolean;
  readonly reason?:
    | "pass-running"
    | "not-command-center"
    | "managed-installs-off"
    | "release-gate-closed";
  readonly attempted: ReadonlyArray<string>;
};

export type FleetUpdateExecutorDeps = {
  readonly settings: () => Promise<{
    readonly role: string;
    readonly remoteManagedInstalls: boolean;
  }>;
  readonly updateFacts: () => Promise<{
    readonly commandCenterVersion: string;
    readonly feedVersion?: string;
  }>;
  readonly listRemotes: () => Promise<ReadonlyArray<FleetExecutorRemote>>;
  /** Live per-host deploy job (main-process registry), if any. */
  readonly deployJob: (
    hostId: string,
  ) => RemoteUpdateDeployJobFacts | undefined;
  /** The canonical coordinator entry — per-host single flight lives there. */
  readonly deployRemote: (
    hostId: string,
  ) => Promise<HostsDeployRemoteResult>;
  /** Global release-capability door, same read the coordinator enforces. */
  readonly releaseDeployAllowed: () => boolean;
  /**
   * Durable receipt for executor outcomes the coordinator did not persist
   * itself (results with statusRecorded !== true never reached apply).
   */
  readonly recordRefusal: (input: {
    readonly hostId: string;
    readonly endpoint: string;
    readonly targetVersion: string;
    readonly detail: string;
    readonly stages: ReadonlyArray<string>;
  }) => Promise<void>;
  readonly now?: () => Date;
};

export type FleetUpdateExecutor = {
  /** Idempotent: arms the coarse pass timers once. */
  readonly start: () => void;
  readonly stop: () => void;
  /** One sequential walk over the current plan. Skips if already running. */
  readonly runPass: () => Promise<FleetUpdatePassSummary>;
  /** In-memory walk state, keyed by host id (tests and diagnostics). */
  readonly states: () => ReadonlyMap<string, FleetUpdateHostState>;
};

const isWaitingRefusal = (result: HostsDeployRemoteResult): boolean =>
  result.recoveryAction?.kind === "close-active-junto-terminals";

export const makeFleetUpdateExecutor = (
  deps: FleetUpdateExecutorDeps,
): FleetUpdateExecutor => {
  const states = new Map<string, FleetUpdateHostState>();
  let passRunning = false;
  let firstTimer: ReturnType<typeof setTimeout> | undefined;
  let intervalTimer: ReturnType<typeof setInterval> | undefined;

  const nowIso = (): string => (deps.now?.() ?? new Date()).toISOString();

  const setState = (
    hostId: string,
    state: FleetUpdateHostState,
  ): void => {
    states.set(hostId, state);
  };

  const recordIfUnpersisted = async (
    remote: FleetExecutorRemote,
    targetVersion: string,
    result: HostsDeployRemoteResult,
    detail: string,
  ): Promise<void> => {
    if (result.statusRecorded === true) return;
    try {
      await deps.recordRefusal({
        hostId: remote.hostId,
        endpoint: remote.endpoint,
        targetVersion,
        detail,
        stages: result.stages ?? [],
      });
    } catch {
      // A receipt-store failure must not stop the walk; the in-memory state
      // and the coordinator's own job registry still carry the truth.
    }
  };

  const attemptHost = async (
    remote: FleetExecutorRemote,
    targetVersion: string,
  ): Promise<void> => {
    const result = await deps.deployRemote(remote.hostId);
    if (result.ok) {
      setState(remote.hostId, {
        targetVersion,
        disposition: "succeeded",
        attempts: 0,
        detail: result.detail,
        at: nowIso(),
      });
      return;
    }
    if (isWaitingRefusal(result)) {
      // Not a failure: the product promise is to wait for idle. No retry
      // budget is consumed; the next pass re-attempts.
      const prior = states.get(remote.hostId);
      const attempts =
        prior?.targetVersion === targetVersion ? prior.attempts : 0;
      setState(remote.hostId, {
        targetVersion,
        disposition: "waiting-for-idle",
        attempts,
        detail: result.detail,
        at: nowIso(),
      });
      await recordIfUnpersisted(remote, targetVersion, result, result.detail);
      return;
    }
    const prior = states.get(remote.hostId);
    const priorAttempts =
      prior?.targetVersion === targetVersion ? prior.attempts : 0;
    const attempts = priorAttempts + 1;
    // A validation refusal is structural (gates, platform freeze) — retrying
    // the same release cannot change it.
    const permanent =
      result.code === "validation" || attempts >= FLEET_UPDATE_MAX_ATTEMPTS;
    const detail = permanent
      ? `Managed update stopped for ${targetVersion} after ${attempts} failed ${attempts === 1 ? "attempt" : "attempts"}: ${result.detail}`
      : `Managed update attempt ${attempts} of ${FLEET_UPDATE_MAX_ATTEMPTS} failed, retrying on the next pass: ${result.detail}`;
    setState(remote.hostId, {
      targetVersion,
      disposition: permanent ? "refused" : "retry-scheduled",
      attempts,
      detail,
      at: nowIso(),
    });
    await recordIfUnpersisted(remote, targetVersion, result, detail);
  };

  const runPass = async (): Promise<FleetUpdatePassSummary> => {
    if (passRunning) return { ran: false, reason: "pass-running", attempted: [] };
    passRunning = true;
    try {
      const settings = await deps.settings();
      if (settings.role !== "command-center") {
        return { ran: false, reason: "not-command-center", attempted: [] };
      }
      // Operator kill-switch: off means the executor does nothing at all.
      if (settings.remoteManagedInstalls !== true) {
        return { ran: false, reason: "managed-installs-off", attempted: [] };
      }
      if (!deps.releaseDeployAllowed()) {
        return { ran: false, reason: "release-gate-closed", attempted: [] };
      }

      const facts = await deps.updateFacts();
      const { availableRemoteReleaseVersion } = resolveRemoteAvailableForStatus({
        ...(facts.feedVersion === undefined
          ? {}
          : { feedVersion: facts.feedVersion }),
        commandCenterVersion: facts.commandCenterVersion,
      });
      const remotes = await deps.listRemotes();
      const observations = remotes.map(
        (remote): FleetRemoteObservation => {
          // Only a live in-flight deploy suppresses an attempt; finished
          // jobs and prior refusals are the executor's own bookkeeping.
          const job = deps.deployJob(remote.hostId);
          const running = job?.status === "running";
          const phase = running
            ? remoteUpdatePhaseFromDeployJob({
                job,
                ...(availableRemoteReleaseVersion === undefined
                  ? {}
                  : { availableVersion: availableRemoteReleaseVersion }),
              })
            : undefined;
          return {
            hostId: remote.hostId,
            platform: remote.platform,
            installedVersion: remote.installedVersion,
            ...(phase === undefined ? {} : { phase }),
          };
        },
      );
      const plan = planFleetRemoteUpdates({
        commandCenterVersion: facts.commandCenterVersion,
        availableReleaseVersion: availableRemoteReleaseVersion,
        remoteManagedInstalls: settings.remoteManagedInstalls,
        remotes: observations,
      });
      const target = plan.availableReleaseVersion;
      if (target === undefined) return { ran: true, attempted: [] };

      const attempted: string[] = [];
      // Strictly sequential: one Remote at a time, never a fan-out.
      for (const hostId of sequentialAutoDeployHostIds(plan)) {
        const remote = remotes.find((entry) => entry.hostId === hostId);
        if (remote === undefined) continue;
        const state = states.get(hostId);
        if (
          state !== undefined &&
          state.targetVersion === target &&
          (state.disposition === "refused" ||
            state.disposition === "succeeded")
        ) {
          continue;
        }
        attempted.push(hostId);
        await attemptHost(remote, target);
      }
      return { ran: true, attempted };
    } finally {
      passRunning = false;
    }
  };

  const kick = (): void => {
    void runPass().catch(() => {
      // A pass failure is retried on the next tick; never crash the timer.
    });
  };

  const start = (): void => {
    if (intervalTimer !== undefined) return;
    firstTimer = setTimeout(kick, FLEET_UPDATE_FIRST_PASS_DELAY_MS);
    intervalTimer = setInterval(kick, FLEET_UPDATE_PASS_INTERVAL_MS);
  };

  const stop = (): void => {
    if (firstTimer !== undefined) clearTimeout(firstTimer);
    if (intervalTimer !== undefined) clearInterval(intervalTimer);
    firstTimer = undefined;
    intervalTimer = undefined;
  };

  return {
    start,
    stop,
    runPass,
    states: () => new Map(states),
  };
};
