/**
 * Pure effective Remote-deployment capability for Fleet / Settings / main.
 * One formula — UI must not recompute RELEASE ∩ operator ∩ role.
 */
import {
  DARWIN_REMOTE_DEPLOY_DISABLED_DETAIL,
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
  };
  readonly operator: {
    readonly remoteManagedInstalls: boolean;
  };
  readonly effective: {
    readonly deployRemote: boolean;
  };
  readonly detail: {
    readonly deployRemote?: string;
  };
};

export type DeployCapabilitiesInput = {
  readonly stationRole: StationRoleSetting;
  readonly remoteManagedInstalls: boolean;
  readonly release?: ReleaseCapabilities;
  readonly platform?: NodeJS.Platform;
};

const isCommandCenter = (role: StationRoleSetting): boolean =>
  role === "command-center";

/**
 * Compute the single source of truth for deploy enablement and main refusal.
 */
export const computeDeployCapabilities = (
  input: DeployCapabilitiesInput,
): HostsDeployCapabilities => {
  const release = input.release ?? RELEASE_CAPABILITIES;
  const operatorOn = input.remoteManagedInstalls === true;
  const cc = isCommandCenter(input.stationRole);

  const releaseDeploy =
    release.managedRemoteDeploy === true &&
    (input.platform === "darwin" ? release.darwinRemoteDeploy === true : true);

  let deployDetail: string | undefined;
  if (!release.managedRemoteDeploy) {
    deployDetail = MANAGED_REMOTE_DEPLOY_DISABLED_DETAIL;
  } else if (input.platform === "darwin" && !release.darwinRemoteDeploy) {
    deployDetail = DARWIN_REMOTE_DEPLOY_DISABLED_DETAIL;
  } else if (!operatorOn) {
    deployDetail = REMOTE_INSTALLS_OPERATOR_DISABLED_DETAIL;
  } else if (!cc) {
    deployDetail = NOT_COMMAND_CENTER_DETAIL;
  }

  const deployRemote = releaseDeploy && operatorOn && cc;

  return {
    ok: true,
    stationRole: input.stationRole,
    release: {
      managedRemoteDeploy: release.managedRemoteDeploy,
      darwinRemoteDeploy: release.darwinRemoteDeploy,
    },
    operator: {
      remoteManagedInstalls: operatorOn,
    },
    effective: {
      deployRemote,
    },
    detail: {
      ...(deployDetail !== undefined ? { deployRemote: deployDetail } : {}),
    },
  };
};
