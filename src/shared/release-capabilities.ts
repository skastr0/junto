/**
 * Compile-time product surface for a given release line.
 *
 * All product deploy paths are ON. The only remaining gates are real:
 * operator kill-switch (`settings.fleet.remoteManagedInstalls`), station role
 * (Command Center only for deploy), and runtime errors from the deploy itself.
 * Do not re-introduce release-frozen flags — if a path is broken, fix or delete it.
 */
/** Loose booleans so tests can override a full surface without type traps. */
export type ReleaseCapabilities = {
  readonly freshRemoteEnrollment: boolean;
  readonly managedRemoteDeploy: boolean;
  readonly darwinRemoteDeploy: boolean;
  readonly commandCenterTransfer: boolean;
};

export const RELEASE_CAPABILITIES: ReleaseCapabilities = Object.freeze({
  freshRemoteEnrollment: true,
  managedRemoteDeploy: true,
  darwinRemoteDeploy: true,
  commandCenterTransfer: true,
});

/** Human-readable denial if a test freezes managed deploy. */
export const MANAGED_REMOTE_DEPLOY_DISABLED_DETAIL =
  "Managed Remote package deployment is disabled in this release. Install the signed package on the target manually, then use Enroll fresh Remote.";

/** Human-readable denial if a test freezes Darwin remote deploy. */
export const DARWIN_REMOTE_DEPLOY_DISABLED_DETAIL =
  "Darwin Remote full-app deployment is disabled in this release.";

export const REMOTE_INSTALLS_OPERATOR_DISABLED_DETAIL =
  "Remote installs are turned off in Settings → Fleet. Enable “Allow remote managed installs” to deploy Vellum to enrolled Remotes.";

export const NOT_COMMAND_CENTER_DETAIL =
  "Only the Command Center may configure Remotes or deploy packages.";