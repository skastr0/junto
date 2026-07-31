/**
 * Pure effective Remote-deployment capability for Fleet / Settings / main.
 * One formula — UI must not recompute RELEASE ∩ operator ∩ role.
 */
import {
  BOX_FLEET_DISABLED_DETAIL,
  DARWIN_REMOTE_DEPLOY_DISABLED_DETAIL,
  LINUX_REMOTE_DEPLOY_DISABLED_DETAIL,
  MANAGED_REMOTE_DEPLOY_DISABLED_DETAIL,
  NOT_COMMAND_CENTER_DETAIL,
  RELEASE_CAPABILITIES,
  REMOTE_INSTALLS_OPERATOR_DISABLED_DETAIL,
  type ReleaseCapabilities,
} from "./release-capabilities";
import type { StationRoleSetting } from "./settings";

export type HostsDeployCapabilities = {
  readonly ok: true;
  readonly stationRole: StationRoleSetting;
  readonly release: {
    readonly managedRemoteDeploy: boolean;
    readonly darwinRemoteDeploy: boolean;
    readonly linuxRemoteDeploy: boolean;
    readonly boxFleet: boolean;
  };
  readonly operator: {
    readonly remoteManagedInstalls: boolean;
  };
  readonly effective: {
    readonly deployRemote: boolean;
    /** Box panel / create / resume — Command Center only when release allows. */
    readonly boxFleet: boolean;
  };
  readonly detail: {
    readonly deployRemote?: string;
    readonly boxFleet?: string;
  };
};

export type DeployCapabilitiesInput = {
  readonly stationRole: StationRoleSetting;
  readonly remoteManagedInstalls: boolean;
  readonly release?: ReleaseCapabilities;
  /**
   * Target Remote kernel when known (`darwin` / `linux`). Omit for the global
   * Fleet enablement query so a Mac Command Center is not blocked from
   * presenting deploy until the target is identified.
   */
  readonly platform?: NodeJS.Platform;
};

const isCommandCenter = (role: StationRoleSetting): boolean =>
  role === "command-center";

const releaseAllowsTargetPlatform = (
  release: ReleaseCapabilities,
  platform: NodeJS.Platform | undefined,
): { readonly ok: boolean; readonly detail?: string } => {
  if (platform === "darwin") {
    return release.darwinRemoteDeploy
      ? { ok: true }
      : { ok: false, detail: DARWIN_REMOTE_DEPLOY_DISABLED_DETAIL };
  }
  if (platform === "linux") {
    return release.linuxRemoteDeploy
      ? { ok: true }
      : { ok: false, detail: LINUX_REMOTE_DEPLOY_DISABLED_DETAIL };
  }
  return { ok: true };
};

/**
 * Compute the single source of truth for deploy enablement and main refusal.
 */
export const computeDeployCapabilities = (
  input: DeployCapabilitiesInput,
): HostsDeployCapabilities => {
  const release = input.release ?? RELEASE_CAPABILITIES;
  const operatorOn = input.remoteManagedInstalls === true;
  const cc = isCommandCenter(input.stationRole);
  const platformGate = releaseAllowsTargetPlatform(release, input.platform);

  const releaseDeploy =
    release.managedRemoteDeploy === true && platformGate.ok;

  let deployDetail: string | undefined;
  if (!release.managedRemoteDeploy) {
    deployDetail = MANAGED_REMOTE_DEPLOY_DISABLED_DETAIL;
  } else if (!platformGate.ok) {
    deployDetail = platformGate.detail;
  } else if (!operatorOn) {
    deployDetail = REMOTE_INSTALLS_OPERATOR_DISABLED_DETAIL;
  } else if (!cc) {
    deployDetail = NOT_COMMAND_CENTER_DETAIL;
  }

  const deployRemote = releaseDeploy && operatorOn && cc;
  const boxFleet = release.boxFleet === true && cc;
  const boxDetail =
    release.boxFleet !== true
      ? BOX_FLEET_DISABLED_DETAIL
      : !cc
        ? NOT_COMMAND_CENTER_DETAIL
        : undefined;

  return {
    ok: true,
    stationRole: input.stationRole,
    release: {
      managedRemoteDeploy: release.managedRemoteDeploy,
      darwinRemoteDeploy: release.darwinRemoteDeploy,
      linuxRemoteDeploy: release.linuxRemoteDeploy,
      boxFleet: release.boxFleet,
    },
    operator: {
      remoteManagedInstalls: operatorOn,
    },
    effective: {
      deployRemote,
      boxFleet,
    },
    detail: {
      ...(deployDetail !== undefined ? { deployRemote: deployDetail } : {}),
      ...(boxDetail !== undefined ? { boxFleet: boxDetail } : {}),
    },
  };
};
