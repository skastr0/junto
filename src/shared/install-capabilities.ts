/**
 * Pure effective install capabilities for Fleet / Settings / main gates.
 * One formula — UI must not recompute RELEASE ∩ operator ∩ role.
 */
import {
  DARWIN_REMOTE_DEPLOY_DISABLED_DETAIL,
  MANAGED_REMOTE_DEPLOY_DISABLED_DETAIL,
  NOT_COMMAND_CENTER_DETAIL,
  PLUGIN_INSTALL_DISABLED_DETAIL,
  RELEASE_CAPABILITIES,
  REMOTE_INSTALLS_OPERATOR_DISABLED_DETAIL,
  ROUTE_TOKENS_DISABLED_DETAIL,
  type ReleaseCapabilities,
} from "./release-capabilities";
import type { StationRoleSetting } from "./settings";

export type InstallCapabilityKind =
  | "deployRemote"
  | "installPluginRemote"
  | "installPluginLocal"
;

export type HostsInstallCapabilities = {
  readonly ok: true;
  readonly stationRole: StationRoleSetting;
  readonly release: {
    readonly managedRemoteDeploy: boolean;
    readonly darwinRemoteDeploy: boolean;
    readonly pluginInstall: boolean;
  };
  readonly operator: {
    readonly remoteManagedInstalls: boolean;
  };
  readonly effective: {
    readonly deployRemote: boolean;
    readonly installPluginRemote: boolean;
    readonly installPluginLocal: boolean;
  };
  readonly detail: {
    readonly deployRemote?: string;
    readonly installPluginRemote?: string;
    readonly installPluginLocal?: string;
  };
};

export type InstallCapabilitiesInput = {
  readonly stationRole: StationRoleSetting;
  readonly remoteManagedInstalls: boolean;
  readonly release?: ReleaseCapabilities;
  readonly platform?: NodeJS.Platform;
};

const isCommandCenter = (role: StationRoleSetting): boolean =>
  role === "command-center";

/**
 * Compute the single source of truth for install button enablement and main refuse.
 */
export const computeInstallCapabilities = (
  input: InstallCapabilitiesInput,
): HostsInstallCapabilities => {
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

  let pluginRemoteDetail: string | undefined;
  if (!release.pluginInstall) {
    pluginRemoteDetail = PLUGIN_INSTALL_DISABLED_DETAIL;
  } else if (!operatorOn) {
    pluginRemoteDetail = REMOTE_INSTALLS_OPERATOR_DISABLED_DETAIL;
  } else if (!cc) {
    pluginRemoteDetail = NOT_COMMAND_CENTER_DETAIL;
  }

  let pluginLocalDetail: string | undefined;
  if (!release.pluginInstall) {
    pluginLocalDetail = PLUGIN_INSTALL_DISABLED_DETAIL;
  } else if (!cc) {
    pluginLocalDetail = NOT_COMMAND_CENTER_DETAIL;
  }

  const deployRemote = releaseDeploy && operatorOn && cc;
  const installPluginRemote =
    release.pluginInstall === true && operatorOn && cc;
  // Local plugin writes this station's harness trees — CC only (no Remote self-write).
  const installPluginLocal =
    release.pluginInstall === true && cc;

  return {
    ok: true,
    stationRole: input.stationRole,
    release: {
      managedRemoteDeploy: release.managedRemoteDeploy,
      darwinRemoteDeploy: release.darwinRemoteDeploy,
      pluginInstall: release.pluginInstall,
    },
    operator: {
      remoteManagedInstalls: operatorOn,
    },
    effective: {
      deployRemote,
      installPluginRemote,
      installPluginLocal,
    },
    detail: {
      ...(deployDetail !== undefined ? { deployRemote: deployDetail } : {}),
      ...(pluginRemoteDetail !== undefined
        ? { installPluginRemote: pluginRemoteDetail }
        : {}),
      ...(pluginLocalDetail !== undefined
        ? { installPluginLocal: pluginLocalDetail }
        : {}),
    },
  };
};
