import type { StationSettings } from "@shared/settings";
import type { InstallationId } from "@shared/station-api";
import { RemoteHostsError, type RemoteHost } from "@shared/remote-hosts";
import type { ConfigureRemoteOptions, ConfigureRemoteResult } from "./configure-remote";
import type { DeployRemoteResult } from "./deploy-remote";
import type { LinuxReleaseCacheSource } from "./linux-release-feed";

export type ConfiguredRemoteDeployOutcome =
  | "ready"
  | "failed"
  | "indeterminate";

export type ConfiguredRemoteDeployResult = DeployRemoteResult & {
  /** False only when the registry never resolved the requested host. */
  readonly hostResolved?: boolean;
  /** Exact registered mutation target used for this attempt. */
  readonly hostEndpoint?: string;
  /** Set by the service when durable attempt finalization was requested. */
  readonly statusRecorded?: boolean;
  readonly outcome: ConfiguredRemoteDeployOutcome;
  /** `previous` is valid only when activation provably never started. */
  readonly packageState: "present" | "previous" | "unknown";
  /** `previous` means Station API configuration provably was not called. */
  readonly role: "remote" | "previous" | "unknown";
  readonly lastSeen?: string;
  readonly station?: StationSettings;
  /** Durable identity returned by the configured Remote Station API. */
  readonly stationInstallationId?: InstallationId;
  readonly configuration: {
    readonly ok: boolean;
    readonly detail: string;
  };
};

export type ConfiguredRemoteDeployOptions = ConfigureRemoteOptions & {
  /** Defaults to the stable feed; qualification may explicitly use the cache. */
  readonly artifactSource?: LinuxReleaseCacheSource;
};

export const failedBeforeMutation = (
  host: RemoteHost,
  detail: string,
  input: {
    readonly code?: DeployRemoteResult["code"];
    readonly stages?: DeployRemoteResult["stages"];
    readonly unsupportedTarget?: DeployRemoteResult["unsupportedTarget"];
    readonly recoveryAction?: DeployRemoteResult["recoveryAction"];
  } = {},
): ConfiguredRemoteDeployResult => ({
  ok: false,
  detail,
  code: input.code ?? "io",
  message: detail,
  hostEndpoint: host.sshEndpoint,
  stages: input.stages ?? [],
  disposition: "not-started",
  outcome: "failed",
  packageState: "previous",
  role: "previous",
  configuration: { ok: false, detail: "Station API not called" },
  ...(input.unsupportedTarget === undefined
    ? {}
    : { unsupportedTarget: input.unsupportedTarget }),
  ...(input.recoveryAction === undefined
    ? {}
    : { recoveryAction: input.recoveryAction }),
});

export const failedPackageResult = (
  host: RemoteHost,
  deployed: DeployRemoteResult,
): ConfiguredRemoteDeployResult => {
  const disposition = deployed.disposition;
  const notStarted = disposition === "not-started";
  return {
    ...deployed,
    ok: false,
    hostEndpoint: host.sshEndpoint,
    outcome: notStarted ? "failed" : "indeterminate",
    packageState: notStarted ? "previous" : "unknown",
    role: "previous",
    configuration: {
      ok: false,
      detail: "Station API not called because package readiness was not proven",
    },
  };
};

export const configurationFailure = (
  host: RemoteHost,
  deployed: DeployRemoteResult,
  error: RemoteHostsError | ConfigureRemoteResult,
): ConfiguredRemoteDeployResult => {
  const detail =
    error instanceof RemoteHostsError
      ? error.message
      : error.detail;
  return {
    ...deployed,
    ok: false,
    detail: `${host.label}: package is present, but Station API configuration was not proven — ${detail}`,
    code:
      error instanceof RemoteHostsError
        ? error.code
        : (error.code ?? "conflict"),
    message: detail,
    hostEndpoint: host.sshEndpoint,
    disposition: "indeterminate",
    outcome: "indeterminate",
    packageState: "present",
    role: "unknown",
    configuration: { ok: false, detail },
  };
};

export const finishWithConfiguration = (
  host: RemoteHost,
  deployed: DeployRemoteResult,
  configured: ConfigureRemoteResult,
): ConfiguredRemoteDeployResult => {
  const detail = `${deployed.detail} - ${configured.detail}`;
  return {
    ...deployed,
    ok: true,
    detail,
    message: deployed.message ?? detail,
    hostEndpoint: host.sshEndpoint,
    disposition: "ready",
    outcome: "ready",
    packageState: "present",
    role: "remote",
    lastSeen: configured.configuredAt ?? new Date().toISOString(),
    station: configured.station,
    ...(configured.stationInstallationId === undefined
      ? {}
      : {
          stationInstallationId: configured.stationInstallationId,
        }),
    configuration: {
      ok: true,
      detail: configured.detail,
    },
  };
};

export const finishAlreadyConfiguredRemote = (
  host: RemoteHost,
  deployed: DeployRemoteResult,
  priorInstallationId: InstallationId,
  activatedDetail: string,
): ConfiguredRemoteDeployResult => {
  const detail = `${deployed.detail} - already configured Remote; configure skipped - ${activatedDetail}`;
  return {
    ...deployed,
    ok: true,
    detail,
    message: activatedDetail,
    hostEndpoint: host.sshEndpoint,
    disposition: "ready",
    outcome: "ready",
    packageState: "present",
    role: "remote",
    stationInstallationId: priorInstallationId,
    configuration: {
      ok: true,
      detail: "already configured Remote; configure skipped",
    },
  };
};

export const alreadyConfiguredActivateFailure = (
  host: RemoteHost,
  deployed: DeployRemoteResult,
  priorInstallationId: InstallationId,
  activatedDetail: string,
): ConfiguredRemoteDeployResult => ({
  ...deployed,
  ok: false,
  detail: `${host.label}: already configured Remote; package is present, but supervised runtime activate failed — ${activatedDetail}`,
  code: "io",
  message: activatedDetail,
  hostEndpoint: host.sshEndpoint,
  disposition: "indeterminate",
  outcome: "indeterminate",
  packageState: "present",
  role: "remote",
  stationInstallationId: priorInstallationId,
  configuration: {
    ok: true,
    detail: "already configured Remote; configure skipped",
  },
});

export const packageAdmitted = (deployed: DeployRemoteResult): boolean =>
  deployed.ok &&
  (deployed.disposition === "ready" ||
    deployed.disposition === "configuration-required");
