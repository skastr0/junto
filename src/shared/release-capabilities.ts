/**
 * Compile-time product surface for a given release line.
 *
 * Beta freezes managed install/update/rollback and Darwin Remote deploy so
 * the fleet path is manual .deb + fresh enrollment + projection only.
 * Not environment-driven — product policy, not operator knobs.
 */
export const RELEASE_CAPABILITIES = Object.freeze({
  freshRemoteEnrollment: true,
  stationProjection: true,
  managedRemoteDeploy: false,
  managedRemoteUpdate: false,
  managedRemoteRollback: false,
  darwinRemoteDeploy: false,
  commandCenterTransfer: false,
});

export type ReleaseCapabilities = typeof RELEASE_CAPABILITIES;

/** Human-readable denial for managed Remote deploy (install/update/rollback). */
export const MANAGED_REMOTE_DEPLOY_DISABLED_DETAIL =
  "Managed Remote install/update/rollback is disabled in this release. Install the signed .deb on the target manually, then use Enroll fresh Remote.";

/** Human-readable denial for Darwin Remote deploy. */
export const DARWIN_REMOTE_DEPLOY_DISABLED_DETAIL =
  "Darwin Remote deployment is disabled in this release.";
