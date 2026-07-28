/**
 * Fleet Remote update status — pure schemas and helpers.
 *
 * No durable store. UI and main project from live observations + release
 * feed facts. Status labels match the product surface copy.
 *
 * Idle for managed install is **terminal-session idle only** (see
 * `term/router.acquireRemoteHostMaintenance`). Vellum never force-closes an
 * active Remote terminal to install an update.
 */

import { Either, Schema } from "effect";

/** Product copy for busy-Remote deferred installs. */
export const REMOTE_UPDATE_IDLE_PRODUCT_COPY =
  "Vellum never force-closes an active Remote terminal to install an update. Busy Remotes wait until their terminal sessions have ended.";

const AppVersion = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(128),
);

/**
 * Closed set of fleet update statuses.
 * Labels (display): Up to date | Update available | Waiting for idle |
 * Downloading | Installing | Restarting | Updated | Failed — Retry
 */
export const RemoteUpdateStatusKind = Schema.Literal(
  "up-to-date",
  "update-available",
  "waiting-for-idle",
  "downloading",
  "installing",
  "restarting",
  "updated",
  "failed-retry",
);
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
  installedVersion: Schema.optionalWith(AppVersion, { exact: true }),
  availableVersion: Schema.optionalWith(AppVersion, { exact: true }),
  updateStatus: RemoteUpdateStatusKind,
});
export type RemoteUpdateStatus = typeof RemoteUpdateStatus.Type;

const decodeStatus = Schema.decodeUnknownEither(RemoteUpdateStatus, {
  onExcessProperty: "error",
});

/** Strict boundary decode for IPC / projected fleet rows. */
export const decodeRemoteUpdateStatus = (
  value: unknown,
): RemoteUpdateStatus | undefined => {
  const decoded = decodeStatus(value);
  return Either.isRight(decoded) ? decoded.right : undefined;
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

/** Ephemeral install phase observed by main (not durable). */
export type RemoteUpdatePhase =
  | { readonly kind: "quiet" }
  | {
      readonly kind: "waiting-for-idle";
      readonly activeTerminalSessions: number;
    }
  | { readonly kind: "downloading" }
  | { readonly kind: "installing" }
  | { readonly kind: "restarting" }
  | { readonly kind: "updated" }
  | { readonly kind: "failed" };

/**
 * Map terminal maintenance refusal → fleet update status.
 * Only active terminal sessions produce Waiting for idle; other cut failures
 * surface as Failed — Retry (operator/retry later, never force-close).
 */
export const mapIdleGateToUpdateStatus = (
  reason:
    | "active-terminal-sessions"
    | "maintenance-held"
    | "shutting-down",
): Extract<
  RemoteUpdateStatusKind,
  "waiting-for-idle" | "failed-retry"
> =>
  reason === "active-terminal-sessions" ? "waiting-for-idle" : "failed-retry";

/**
 * Derive fleet status from installed/available versions and optional live phase.
 * Phase wins over version comparison when present and non-quiet.
 */
export const deriveRemoteUpdateStatus = (input: {
  readonly installedVersion?: string;
  readonly availableVersion?: string;
  readonly phase?: RemoteUpdatePhase;
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

/** Build the waiting-for-idle row used when maintenance refuses live work. */
export const waitingForIdleUpdateStatus = (input: {
  readonly installedVersion?: string;
  readonly availableVersion?: string;
  readonly activeTerminalSessions: number;
}): RemoteUpdateStatus =>
  deriveRemoteUpdateStatus({
    ...(input.installedVersion !== undefined
      ? { installedVersion: input.installedVersion }
      : {}),
    ...(input.availableVersion !== undefined
      ? { availableVersion: input.availableVersion }
      : {}),
    phase: {
      kind: "waiting-for-idle",
      activeTerminalSessions: input.activeTerminalSessions,
    },
  });
