/**
 * Compile-time product surface for a given release line.
 *
 * RELEASE_CAPABILITIES is product-line policy (what this binary may ever do).
 * Operator kill-switch `settings.fleet.remoteManagedInstalls` is a runtime
 * preference *inside* an enabled line — it cannot enable a frozen capability.
 * Effective UI/service gates = RELEASE ∧ operator ∧ station role.
 *
 * Managed package deploy stays release-frozen until trust/bundle qualification.
 * Factory plugin install + route-tokens are enabled for this line.
 */
/** Loose booleans so tests/product can flip flags without type-narrowing traps. */
export type ReleaseCapabilities = {
  readonly freshRemoteEnrollment: boolean;
  readonly stationProjection: boolean;
  readonly managedRemoteDeploy: boolean;
  readonly managedRemoteUpdate: boolean;
  readonly managedRemoteRollback: boolean;
  readonly darwinRemoteDeploy: boolean;
  readonly commandCenterTransfer: boolean;
  /** Tier-3 harness plugin install via packager (local + remote SSH apply). */
  readonly pluginInstall: boolean;
  /** Route-token mint/rotate/revoke for Tier-3 work-plane seats. */
};

export const RELEASE_CAPABILITIES: ReleaseCapabilities = Object.freeze({
  freshRemoteEnrollment: true,
  stationProjection: true,
  managedRemoteDeploy: false,
  managedRemoteUpdate: false,
  managedRemoteRollback: false,
  darwinRemoteDeploy: false,
  commandCenterTransfer: false,
  pluginInstall: true,
});

/** Human-readable denial for managed Remote deploy (install/update/rollback). */
export const MANAGED_REMOTE_DEPLOY_DISABLED_DETAIL =
  "Managed Remote install/update/rollback is disabled in this release. Install the signed .deb on the target manually, then use Enroll fresh Remote.";

/** Human-readable denial for Darwin Remote deploy. */
export const DARWIN_REMOTE_DEPLOY_DISABLED_DETAIL =
  "Darwin Remote deployment is disabled in this release.";

export const PLUGIN_INSTALL_DISABLED_DETAIL =
  "Factory plugin install is disabled in this release.";

export const ROUTE_TOKENS_DISABLED_DETAIL =
  "Route-token administration is disabled in this release.";

export const REMOTE_INSTALLS_OPERATOR_DISABLED_DETAIL =
  "Remote installs are turned off in Settings → Fleet. Enable “Allow remote managed installs” to use Deploy or Install factory plugins on remote hosts.";

export const NOT_COMMAND_CENTER_DETAIL =
  "Only the Command Center station may configure remotes, deploy packages, or administer route-tokens.";
