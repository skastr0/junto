import type { Context } from "effect";
import { Effect } from "effect";
import type { StationSettings } from "@shared/settings";
import type { InstallationId } from "@shared/station-api";
import { RemoteHostsError, type RemoteHost } from "@shared/remote-hosts";
import { SshTransport } from "../ssh";
import {
  configureRemoteHost,
  type ConfigureRemoteOptions,
  type ConfigureRemoteResult,
} from "./configure-remote";
import {
  dispatchRemoteDeployment,
  prepareRemoteDeployment,
  type DeployRemoteResult,
  type RemoteDeploymentPreparation,
  type RemoteDeploymentTarget,
} from "./deploy-remote";
import type { LinuxReleaseCacheSource } from "./linux-release-feed";

type Ssh = Context.Tag.Service<typeof SshTransport>;

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

export type ConfiguredRemoteDeployOperations = {
  /** Admit the registered target and its one platform provider. */
  readonly prepare: (
    ssh: Ssh,
    host: RemoteHost,
  ) => Effect.Effect<RemoteDeploymentPreparation, never>;
  /** Consume the admitted target exactly once. */
  readonly deployPrepared: (
    ssh: Ssh,
    target: RemoteDeploymentTarget,
    stationConfiguration: {
      readonly state: "applied";
      readonly remoteHostId: string;
    },
    artifactSource?: LinuxReleaseCacheSource,
  ) => Effect.Effect<DeployRemoteResult, never>;
  /** Configure durable station state through the app-owned Station API. */
  readonly configure: (
    ssh: Ssh,
    host: RemoteHost,
    options: ConfigureRemoteOptions,
  ) => Effect.Effect<ConfigureRemoteResult, RemoteHostsError>;
};

const defaultOperations: ConfiguredRemoteDeployOperations = {
  prepare: prepareRemoteDeployment,
  deployPrepared: (
    ssh,
    target,
    stationConfiguration,
    artifactSource,
  ) =>
    dispatchRemoteDeployment(
      target,
      ssh,
      stationConfiguration,
      artifactSource,
    ),
  configure: configureRemoteHost,
};

const failedBeforeMutation = (
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

const failedPackageResult = (
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

const configurationFailure = (
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

const finishWithConfiguration = (
  host: RemoteHost,
  deployed: DeployRemoteResult,
  configured: ConfigureRemoteResult,
): ConfiguredRemoteDeployResult => {
  const detail = `${deployed.detail} · ${configured.detail}`;
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

/**
 * Install one Remote package, then pair/configure its app-owned database.
 *
 * A package provider may use the intended station fields as bounded admission
 * facts, but only the Station API commits durable configuration. There is no
 * settings snapshot, seal, file rollback, or alternate trust-provision lane.
 */
export const deployConfiguredRemoteHost = (
  ssh: Ssh,
  host: RemoteHost,
  options: ConfiguredRemoteDeployOptions,
  operations: ConfiguredRemoteDeployOperations = defaultOperations,
): Effect.Effect<ConfiguredRemoteDeployResult, never> =>
  Effect.gen(function* () {
    if (host.kind !== "remote" || !host.sshEndpoint) {
      return failedBeforeMutation(
        host,
        `${host.label}: host is not a registered Remote endpoint`,
        { code: "validation" },
      );
    }

    const preparation = yield* operations.prepare(ssh, host);
    if (!preparation.ok) {
      return failedBeforeMutation(host, preparation.result.detail, {
        code: preparation.result.code,
        stages: preparation.result.stages,
        unsupportedTarget: preparation.result.unsupportedTarget,
        recoveryAction: preparation.result.recoveryAction,
      });
    }

    let deployed = yield* operations.deployPrepared(
      ssh,
      preparation.target,
      {
        state: "applied",
        remoteHostId: host.id,
      },
      options.artifactSource,
    );

    if (!deployed.ok || deployed.disposition !== "ready") {
      return failedPackageResult(host, deployed);
    }

    const configured = yield* operations
      .configure(ssh, host, options)
      .pipe(Effect.either);
    if (configured._tag === "Left") {
      return configurationFailure(host, deployed, configured.left);
    }
    if (!configured.right.ok || configured.right.station === undefined) {
      return configurationFailure(host, deployed, configured.right);
    }

    return finishWithConfiguration(host, deployed, configured.right);
  }).pipe(Effect.withSpan("hosts.deploy-configured-remote"));
