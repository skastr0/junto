/**
 * Compile-time product surface for a given release line.
 *
 * Managed host platforms are the single policy source. Linux/Box support is
 * derived from that list — not separate product knobs re-introduced ad hoc.
 *
 * Current production surface: Fleet/Remote management is dormant. Darwin
 * enroll/deploy, Linux fleet, and Box stay off until Fleet UI ships.
 * Auto-Command-Center establish is independent of these flags. Other gates
 * still apply: operator kill-switch (`settings.fleet.remoteManagedInstalls`),
 * station role (Command Center only for deploy), and runtime deploy errors.
 */

/** Platforms that may receive managed Remote install / enrollment automation. */
export type ManagedHostPlatform = "darwin" | "linux";

/**
 * Production managed-host allowlist. Re-enable Linux by adding `"linux"` and
 * shipping a two-station receipt — do not scatter `if (linux)` product forks.
 */
export const SUPPORTED_MANAGED_HOST_PLATFORMS = Object.freeze([
  "darwin",
] as const satisfies ReadonlyArray<ManagedHostPlatform>);

export const isManagedHostPlatformSupported = (
  platform: ManagedHostPlatform,
): boolean =>
  (SUPPORTED_MANAGED_HOST_PLATFORMS as ReadonlyArray<string>).includes(
    platform,
  );

/** Loose booleans so tests can override a full surface without type traps. */
export type ReleaseCapabilities = {
  readonly freshRemoteEnrollment: boolean;
  readonly managedRemoteDeploy: boolean;
  readonly darwinRemoteDeploy: boolean;
  /** Managed full-app deploy onto Linux Remotes (userland package path). */
  readonly linuxRemoteDeploy: boolean;
  /**
   * Box provider fleet (create / resume / enroll Ubuntu boxes). Off whenever
   * Linux managed hosts are not in the production allowlist.
   */
  readonly boxFleet: boolean;
  readonly commandCenterTransfer: boolean;
};

const linuxManaged = isManagedHostPlatformSupported("linux");

export const RELEASE_CAPABILITIES: ReleaseCapabilities = Object.freeze({
  freshRemoteEnrollment: false,
  managedRemoteDeploy: false,
  darwinRemoteDeploy: false,
  linuxRemoteDeploy: linuxManaged,
  boxFleet: linuxManaged,
  commandCenterTransfer: true,
});

/**
 * Unpackaged development may re-enable Linux/Box via
 * `JUNTO_ENABLE_LINUX_FLEET=1`. Packaged builds always keep production policy.
 */
export type ReleaseCapabilityResolveInput = {
  readonly packaged: boolean;
  readonly enableLinuxFleet?: boolean;
};

export const resolveReleaseCapabilities = (
  input: ReleaseCapabilityResolveInput,
  base: ReleaseCapabilities = RELEASE_CAPABILITIES,
): ReleaseCapabilities => {
  if (input.packaged) return base;
  if (input.enableLinuxFleet !== true) return base;
  if (base.linuxRemoteDeploy && base.boxFleet) return base;
  return Object.freeze({
    ...base,
    linuxRemoteDeploy: true,
    boxFleet: true,
  });
};

/** Human-readable denial if a test freezes managed deploy. */
export const MANAGED_REMOTE_DEPLOY_DISABLED_DETAIL =
  "Managed Remote package deployment is disabled in this release. Install the signed package on the target manually, then use Enroll fresh Remote.";

/** Human-readable denial if a test freezes Darwin remote deploy. */
export const DARWIN_REMOTE_DEPLOY_DISABLED_DETAIL =
  "Darwin Remote full-app deployment is disabled in this release.";

/** Human-readable denial when Linux managed deploy is outside the release surface. */
export const LINUX_REMOTE_DEPLOY_DISABLED_DETAIL =
  "Linux Remote managed deployment is not available in this release. Junto currently supports managed hosts on macOS only.";

/** Human-readable denial when Box fleet automation is outside the release surface. */
export const BOX_FLEET_DISABLED_DETAIL =
  "Box fleet provisioning is not available in this release. Junto currently supports managed hosts on macOS only.";

export const REMOTE_INSTALLS_OPERATOR_DISABLED_DETAIL =
  "Remote installs are turned off in Settings → Machine. Enable “Allow remote managed installs” to deploy Junto to enrolled Remotes.";

export const NOT_COMMAND_CENTER_DETAIL =
  "Only the Command Center may configure Remotes or deploy packages.";

/** Stable label for preserved Linux hosts that cannot be managed this release. */
export const LINUX_HOST_UNAVAILABLE_IN_RELEASE_LABEL =
  "Unavailable in this release";
