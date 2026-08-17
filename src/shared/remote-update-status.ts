/**
 * Fleet Remote update status — pure schemas and helpers.
 *
 * No durable store. UI and main project from live observations + release
 * feed facts. Status labels match the product surface copy.
 *
 * Idle for managed install is **terminal-session idle only** (see
 * `term/router.acquireRemoteHostMaintenance`). Vellum Command never force-closes an
 * active Remote terminal to install an update.
 */

import { Result, Schema } from "effect";

/** Product copy for busy-Remote deferred installs. */
export const REMOTE_UPDATE_IDLE_PRODUCT_COPY =
  "Vellum Command never force-closes an active Remote terminal to install an update. Busy Remotes wait until their terminal sessions have ended.";

const AppVersion = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(128)),
);

/**
 * Closed set of fleet update statuses.
 * Labels (display): Up to date | Update available | Waiting for idle |
 * Downloading | Installing | Restarting | Updated | Failed — Retry
 */
export const RemoteUpdateStatusKind = Schema.Literals(["up-to-date", "update-available",
"waiting-for-idle",
"downloading",
"installing",
"restarting",
"updated",
"failed-retry",]);
export type RemoteUpdateStatusKind = typeof RemoteUpdateStatusKind.Type;

/** Human-readable fleet labels — single source for UI and IPC. */
export const REMOTE_UPDATE_STATUS_LABEL = Object.freeze({
  "up-to-date": "Up to date",
  "update-available": "Update available",
  "waiting-for-idle": "Waiting for idle",
  downloading: "Downloading",
  installing: "Installing",
  restarting: "Restarting",
  updated: "Updated",
  "failed-retry": "Failed — Retry",
} as const satisfies Record<RemoteUpdateStatusKind, string>);

export const RemoteUpdateStatus = Schema.Struct({
  installedVersion: Schema.optionalKey(AppVersion),
  availableVersion: Schema.optionalKey(AppVersion),
  updateStatus: RemoteUpdateStatusKind,
});
export type RemoteUpdateStatus = typeof RemoteUpdateStatus.Type;

const decodeStatus = Schema.decodeUnknownResult(RemoteUpdateStatus, {
  onExcessProperty: "error",
});

/** Strict boundary decode for IPC / projected fleet rows. */
export const decodeRemoteUpdateStatus = (
  value: unknown,
): RemoteUpdateStatus | undefined => {
  const decoded = decodeStatus(value);
  return Result.isSuccess(decoded) ? decoded.success : undefined;
};

export const remoteUpdateStatusLabel = (
  status: RemoteUpdateStatusKind,
): string => REMOTE_UPDATE_STATUS_LABEL[status];

/**
 * Auto-walk rule for managed Remote install:
 * only when the available release matches the Command Center app version
 * **and** the operator kill-switch `remoteManagedInstalls` is on.
 *
 * Does **not** consult RELEASE_CAPABILITIES — that gate remains at deploy
 * entry. Helpers stay pure so UI can bind before the release flag thaws.
 */
export const shouldAutoWalkRemoteUpdate = (input: {
  readonly availableRemoteReleaseVersion: string | undefined;
  readonly commandCenterVersion: string;
  readonly remoteManagedInstalls: boolean;
}): boolean => {
  if (input.remoteManagedInstalls !== true) return false;
  const available = input.availableRemoteReleaseVersion?.trim();
  const local = input.commandCenterVersion.trim();
  if (!available || !local) return false;
  return available === local;
};

/**
 * CC-first available release for Remote status comparison.
 *
 * While the update feed is ahead of the running Command Center, Remotes
 * must wait (Available column: "waiting for CC …"). Status still compares
 * the Remote against the **CC** version so a lagging Remote is not
 * mislabeled "Up to date" just because the feed target is suppressed.
 */
export const resolveRemoteAvailableForStatus = (input: {
  readonly feedVersion?: string;
  readonly commandCenterVersion: string;
}): {
  readonly feedAhead: boolean;
  readonly feedVersion: string | undefined;
  /** Version to pass into `deriveRemoteUpdateStatus` for lag detection. */
  readonly availableForStatus: string;
  /**
   * Release admitted for Remote auto-walk / install.
   * Undefined while feed waits on CC (CC-first).
   */
  readonly availableRemoteReleaseVersion: string | undefined;
} => {
  const feed = input.feedVersion?.trim() || undefined;
  const cc = input.commandCenterVersion.trim();
  const feedAhead = feed !== undefined && feed !== cc;
  return {
    feedVersion: feed,
    feedAhead,
    availableForStatus: feedAhead ? cc : (feed ?? cc),
    availableRemoteReleaseVersion: feedAhead ? undefined : (feed ?? cc),
  };
};

/** Ephemeral install phase observed by main (not durable). */
export type RemoteUpdatePhase =
  | { readonly kind: "quiet" }
  | {
      readonly kind: "waiting-for-idle";
      readonly activeTerminalSessions?: number;
    }
  | { readonly kind: "downloading" }
  | { readonly kind: "installing" }
  | { readonly kind: "restarting" }
  | { readonly kind: "updated" }
  | { readonly kind: "failed" };

/**
 * Deploy-job facts consumed for phase projection. Structural on purpose:
 * `HostDeployJobSnapshot` (shared/deploy-job) is assignable, and both main
 * (fleet update executor) and the Fleet renderer project from the same job.
 */
export type RemoteUpdateDeployJobFacts = {
  readonly status: "running" | "succeeded" | "failed" | "auth_required";
  readonly stages: readonly string[];
  readonly version?: string;
  readonly recoveryHint?: string;
  readonly copy?: { readonly payloadComplete?: boolean };
};

/**
 * Project the live per-host deploy job into a Remote update phase.
 *
 * This is the ONE production source of the mid-flight phases
 * (downloading / installing / restarting / waiting-for-idle / updated /
 * failed): they become visible only while a real deploy job exists in the
 * main-process registry, which every managed update and manual Deploy
 * flows through. No job, no phase — version comparison decides instead.
 */
export const remoteUpdatePhaseFromDeployJob = (input: {
  readonly job: RemoteUpdateDeployJobFacts | null | undefined;
  readonly availableVersion?: string;
}): RemoteUpdatePhase | undefined => {
  const job = input.job ?? undefined;
  if (job === undefined) return undefined;
  if (job.status === "running") {
    if (job.copy !== undefined && job.copy.payloadComplete !== true) {
      return { kind: "downloading" };
    }
    const lastStage = job.stages[job.stages.length - 1] ?? "";
    if (/relaunch|restart/i.test(lastStage)) return { kind: "restarting" };
    return { kind: "installing" };
  }
  // Finished jobs stay in the registry until replaced. They speak for the
  // currently available release only while their recorded version does not
  // contradict it — a success for an older release never masks a newer one.
  const available = input.availableVersion?.trim() || undefined;
  const jobVersion = job.version?.trim() || undefined;
  if (
    available !== undefined &&
    jobVersion !== undefined &&
    jobVersion !== available
  ) {
    return undefined;
  }
  if (job.status === "succeeded") return { kind: "updated" };
  if (job.recoveryHint === "close-active-vellum-terminals") {
    return { kind: "waiting-for-idle" };
  }
  return { kind: "failed" };
};

/**
 * Derive fleet status from installed/available versions and optional live phase.
 * Phase wins over version comparison when present and non-quiet.
 */
export const deriveRemoteUpdateStatus = (input: {
  readonly installedVersion?: string;
  readonly availableVersion?: string;
  readonly phase?: RemoteUpdatePhase | undefined;
}): RemoteUpdateStatus => {
  const installed = input.installedVersion?.trim() || undefined;
  const available = input.availableVersion?.trim() || undefined;
  const phase = input.phase ?? { kind: "quiet" as const };

  let updateStatus: RemoteUpdateStatusKind;
  switch (phase.kind) {
    case "waiting-for-idle":
      updateStatus = "waiting-for-idle";
      break;
    case "downloading":
      updateStatus = "downloading";
      break;
    case "installing":
      updateStatus = "installing";
      break;
    case "restarting":
      updateStatus = "restarting";
      break;
    case "updated":
      updateStatus = "updated";
      break;
    case "failed":
      updateStatus = "failed-retry";
      break;
    case "quiet":
      if (
        available !== undefined &&
        installed !== undefined &&
        available !== installed
      ) {
        updateStatus = "update-available";
      } else {
        // Equal versions, or incomplete pair (missing installed/available).
        // Incomplete pair is not product parity — UI labels status "unknown"
        // when installedVersion is absent rather than "Up to date".
        updateStatus = "up-to-date";
      }
      break;
  }

  return {
    ...(installed !== undefined ? { installedVersion: installed } : {}),
    ...(available !== undefined ? { availableVersion: available } : {}),
    updateStatus,
  };
};
