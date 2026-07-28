/**
 * Compile-time product surface for a given release line.
 *
 * RELEASE_CAPABILITIES is product-line policy (what this binary may ever do).
 * Operator kill-switch `settings.fleet.remoteManagedInstalls` is a runtime
 * preference *inside* an enabled line — it cannot enable a frozen capability.
 * Effective UI/service gates = RELEASE ∧ operator ∧ station role.
 *
 * Managed package deploy stays release-frozen until trust/bundle qualification.
 */
/** Loose booleans so tests/product can flip flags without type-narrowing traps. */
export type ReleaseCapabilities = {
  readonly freshRemoteEnrollment: boolean;
  readonly managedRemoteDeploy: boolean;
  readonly darwinRemoteDeploy: boolean;
  readonly commandCenterTransfer: boolean;
};

export const RELEASE_CAPABILITIES: ReleaseCapabilities = Object.freeze({
  freshRemoteEnrollment: true,
  managedRemoteDeploy: false,
  darwinRemoteDeploy: false,
  commandCenterTransfer: false,
});

/** Human-readable denial for managed Remote package deployment. */
export const MANAGED_REMOTE_DEPLOY_DISABLED_DETAIL =
  "Managed Remote package deployment is disabled in this release. Install the signed .deb on the target manually, then use Enroll fresh Remote.";

/** Human-readable denial for Darwin Remote deploy. */
export const DARWIN_REMOTE_DEPLOY_DISABLED_DETAIL =
  "Darwin Remote deployment is disabled in this release.";

export const REMOTE_INSTALLS_OPERATOR_DISABLED_DETAIL =
  "Remote installs are turned off in Settings → Fleet. Enable “Allow remote managed installs” to deploy Vellum to enrolled Remotes.";

export const NOT_COMMAND_CENTER_DETAIL =
  "Only the Command Center may configure Remotes or deploy packages.";
