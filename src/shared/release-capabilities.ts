/**
 * Compile-time product surface for a given release line.
 *
 * RELEASE_CAPABILITIES is product-line policy (what this binary may ever do).
 * Operator kill-switch `settings.fleet.remoteManagedInstalls` is a runtime
 * preference *inside* an enabled line — it cannot enable a frozen capability.
 * Effective UI/service gates = RELEASE ∧ operator ∧ station role.
 *
 * `managedRemoteDeploy` — package deploy to Remotes (Linux .deb path live).
 * `darwinRemoteDeploy` — Darwin full-app remote path only; still frozen until
 * that track is product-ready. Do not use CC `process.platform` as a proxy for
 * the target: a Mac Command Center must still deploy Linux Remotes when managed
 * is on and the target is Linux.
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
  managedRemoteDeploy: true,
  darwinRemoteDeploy: false,
  commandCenterTransfer: false,
});

/** Human-readable denial for managed Remote package deployment. */
export const MANAGED_REMOTE_DEPLOY_DISABLED_DETAIL =
  "Managed Remote package deployment is disabled in this release. Install the signed package on the target manually, then use Enroll fresh Remote.";

/** Human-readable denial for Darwin Remote deploy. */
export const DARWIN_REMOTE_DEPLOY_DISABLED_DETAIL =
  "Darwin Remote full-app deployment is disabled in this release. Linux package deploy is available when managed installs are allowed.";

export const REMOTE_INSTALLS_OPERATOR_DISABLED_DETAIL =
  "Remote installs are turned off in Settings → Fleet. Enable “Allow remote managed installs” to deploy Vellum to enrolled Remotes.";

export const NOT_COMMAND_CENTER_DETAIL =
  "Only the Command Center may configure Remotes or deploy packages.";
