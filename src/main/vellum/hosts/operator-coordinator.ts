import { Context, Effect } from "effect";
import type {
  HostsConfigureRemoteResult,
  HostsDeployRemoteAuthorizationRequest,
  HostsDeployRemoteInput,
  HostsDeployRemoteResult,
} from "@shared/ipc";
import { deployRecordFromResult } from "@shared/station-status";
import type { InstallationId } from "@shared/station-api";
import { AppRuntime } from "../../runtime";
import { PrismService } from "../../services/prism";
import { BoxFleetService } from "../box";
import { SettingsService } from "../settings/service";
import { StationStatusService } from "../station-status-store";
import { StationFleetTargetRepository } from "../station/fleet-target-repository";
import { StationRepository } from "../station/repository";
import type { ConfigureRemoteOptions } from "./configure-remote";
import type { ConfiguredRemoteDeployResult } from "./deploy-configured-remote";
import {
  appendDeployJobStage,
  beginDeployJob,
  finishDeployJob,
  getDeployJob,
  setActiveDeployJobHost,
} from "./deploy-job-registry";
import {
  destroyLinuxAdministratorCredential,
  mintLinuxAdministratorCredential,
  type LinuxAdministratorCredentialBinding,
} from "./linux-administrator-credential";
import type { LinuxReleaseCacheSource } from "./linux-release-feed";
import type { RemoteDeploymentAuthorization } from "./remote-deployment";
import { HostsService } from "./service";
import {
  HOST_OPERATION_ADMISSIONS,
  HostOperationShutdownRefused,
  hostOperationGate,
  type HostOperationGate,
} from "./shutdown";
import {
  MANAGED_REMOTE_DEPLOY_DISABLED_DETAIL,
  RELEASE_CAPABILITIES,
} from "@shared/release-capabilities";
import { computeDeployCapabilities } from "@shared/deploy-capabilities";
import { RemoteHostsError } from "@shared/remote-hosts";

type Hosts = Context.Tag.Service<typeof HostsService>;

const resolveCommandCenterConfigureOptions = (
  supervisedPreferred = true,
): Effect.Effect<
  ConfigureRemoteOptions,
  RemoteHostsError,
  PrismService | StationRepository
> =>
  Effect.gen(function* () {
    const prism = yield* PrismService;
    const stations = yield* StationRepository;
    const commandCenterInstallationId = yield* stations.installationId;
    const stationInfo = yield* prism.stationInfo;
    return {
      commandCenterInstallationId,
      appVersion: stationInfo.version,
      supervisedPreferred,
    };
  }).pipe(
    Effect.mapError((error) =>
      error instanceof RemoteHostsError
        ? error
        : new RemoteHostsError(
            "io",
            error instanceof Error ? error.message : String(error),
          ),
    ),
  );

export const bindConfiguredRemoteTarget = (
  hosts: Hosts,
  hostId: string,
  stationInstallationId: InstallationId,
): Effect.Effect<void, RemoteHostsError, StationFleetTargetRepository> =>
  Effect.gen(function* () {
    const host = yield* hosts.get(hostId);
    if (
      host === undefined ||
      host.kind !== "remote" ||
      host.sshEndpoint === undefined
    ) {
      return yield* Effect.fail(
        new RemoteHostsError(
          "conflict",
          `configured Station ${hostId} no longer has an enrolled Remote endpoint`,
        ),
      );
    }
    const fleetTargets = yield* StationFleetTargetRepository;
    yield* fleetTargets
      .bind({
        hostId: host.id,
        stationInstallationId,
      })
      .pipe(
        Effect.mapError(
          (error) =>
            new RemoteHostsError(
              "conflict",
              `configured Station target could not be admitted: ${error._tag}`,
            ),
        ),
      );
  });

const deploymentFleetBindingFailure = (
  deploy: ConfiguredRemoteDeployResult,
  detail: string,
): ConfiguredRemoteDeployResult => ({
  ...deploy,
  ok: false,
  detail: `${deploy.detail} · ${detail}`,
  message: `${deploy.message ?? deploy.detail} · ${detail}`,
  outcome: "indeterminate",
  statusRecorded: false,
});

const exactKeys = (
  value: Record<string, unknown>,
  expected: ReadonlyArray<string>,
): boolean => {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
};

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const decodeAuthorizationRequest = (
  value: unknown,
): HostsDeployRemoteAuthorizationRequest | undefined => {
  const input = record(value);
  if (
    input === undefined ||
    !exactKeys(input, [
      "kind",
      "hostId",
      "endpoint",
      "version",
      "manifestSha256",
      "debSha256",
      "inventorySha256",
    ]) ||
    input.kind !== "linux-administrator-password" ||
    typeof input.hostId !== "string" ||
    typeof input.endpoint !== "string" ||
    typeof input.version !== "string" ||
    typeof input.manifestSha256 !== "string" ||
    typeof input.debSha256 !== "string" ||
    typeof input.inventorySha256 !== "string"
  ) {
    return undefined;
  }
  return {
    kind: "linux-administrator-password",
    hostId: input.hostId,
    endpoint: input.endpoint,
    version: input.version,
    manifestSha256: input.manifestSha256,
    debSha256: input.debSha256,
    inventorySha256: input.inventorySha256,
  };
};

export type DecodedHostsDeployRemoteInput = HostsDeployRemoteInput;

export const decodeHostsDeployRemoteInput = (
  value: unknown,
): DecodedHostsDeployRemoteInput | undefined => {
  const input = record(value);
  if (
    input === undefined ||
    (exactKeys(input, ["id"]) === false &&
      exactKeys(input, ["id", "authorization"]) === false) ||
    typeof input.id !== "string" ||
    input.id.length === 0
  ) {
    return undefined;
  }
  if (!Object.hasOwn(input, "authorization")) {
    return "authorization" in input ? undefined : { id: input.id };
  }

  const authorization = record(input.authorization);
  if (
    authorization === undefined ||
    !exactKeys(authorization, ["request", "password"]) ||
    typeof authorization.password !== "string"
  ) {
    return undefined;
  }
  const request = decodeAuthorizationRequest(authorization.request);
  if (request === undefined || request.hostId !== input.id) return undefined;
  return {
    id: input.id,
    authorization: {
      request,
      password: authorization.password,
    },
  };
};

const credentialBinding = (
  request: HostsDeployRemoteAuthorizationRequest,
): LinuxAdministratorCredentialBinding => ({
  hostId: request.hostId,
  // The credential constructor validates the branded endpoint before storing
  // password bytes; this cast preserves only the exact serialized value.
  endpoint: request.endpoint as LinuxAdministratorCredentialBinding["endpoint"],
  version: request.version,
  manifestSha256: request.manifestSha256,
  debSha256: request.debSha256,
  inventorySha256: request.inventorySha256,
});

class LinuxAdministratorAuthorizationInputError extends Error {
  readonly _tag: "LinuxAdministratorAuthorizationInputError" =
    "LinuxAdministratorAuthorizationInputError";
}

/** Mint one main-only credential and destroy it after the sole attempt. */
export const withHostsDeployRemoteAuthorization = <A, E, R>(
  input: DecodedHostsDeployRemoteInput,
  use: (
    authorization: RemoteDeploymentAuthorization | undefined,
  ) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | LinuxAdministratorAuthorizationInputError, R> => {
  if (!("authorization" in input)) return use(undefined);
  const request = input.authorization.request;
  return Effect.acquireUseRelease(
    Effect.try({
      try: () =>
        mintLinuxAdministratorCredential(
          input.authorization.password,
          credentialBinding(request),
        ),
      catch: () =>
        new LinuxAdministratorAuthorizationInputError(
          "Linux administrator authorization is invalid",
        ),
    }),
    (credential) =>
      use({
        kind: "linux-administrator-password",
        credential,
      }),
    (credential) =>
      Effect.sync(() => {
        destroyLinuxAdministratorCredential(credential);
      }),
  );
};

export const projectDeployRemoteResult = (
  deploy: ConfiguredRemoteDeployResult,
): HostsDeployRemoteResult => ({
  ok: deploy.ok,
  detail: deploy.detail,
  code: deploy.code,
  message: deploy.message ?? deploy.detail,
  stages: deploy.stages,
  outcome: deploy.outcome,
  packageState: deploy.packageState,
  role: deploy.role,
  version: deploy.version,
  lastSeen: deploy.lastSeen,
  statusRecorded: deploy.statusRecorded ?? false,
  ...(deploy.recoveryAction === undefined
    ? {}
    : { recoveryAction: deploy.recoveryAction }),
  ...(deploy.authorizationRequest === undefined
    ? {}
    : { authorizationRequest: deploy.authorizationRequest }),
});

const configureRemoteEffect = (
  id: string,
): Effect.Effect<
  HostsConfigureRemoteResult,
  never,
  | SettingsService
  | HostsService
  | PrismService
  | StationRepository
  | StationFleetTargetRepository
> =>
  Effect.gen(function* () {
    if (id.length === 0) {
      return {
        ok: false,
        detail: "host id required",
        code: "validation",
        message: "host id required",
      } satisfies HostsConfigureRemoteResult;
    }

    const settingsSvc = yield* SettingsService;
    const hosts = yield* HostsService;
    const settingsResult = yield* Effect.either(settingsSvc.get);
    if (settingsResult._tag === "Left") {
      return {
        ok: false,
        detail: settingsResult.left.message,
        code: settingsResult.left.code,
        message: settingsResult.left.message,
      } satisfies HostsConfigureRemoteResult;
    }
    if (settingsResult.right.station.role !== "command-center") {
      const detail =
        "Configure as Remote is only available when this station is Command Center";
      return {
        ok: false,
        detail,
        code: "validation",
        message: detail,
      } satisfies HostsConfigureRemoteResult;
    }

    const authority = yield* Effect.either(
      resolveCommandCenterConfigureOptions(true),
    );
    if (authority._tag === "Left") {
      return {
        ok: false,
        detail: authority.left.message,
        code: authority.left.code,
        message: authority.left.message,
      } satisfies HostsConfigureRemoteResult;
    }
    const result = yield* Effect.either(
      hosts.configureRemote(id, authority.right),
    );
    if (result._tag === "Left") {
      return {
        ok: false,
        detail: result.left.message,
        code: result.left.code,
        message: result.left.message,
      } satisfies HostsConfigureRemoteResult;
    }

    if (result.right.ok) {
      if (result.right.stationInstallationId === undefined) {
        const detail =
          "Remote configuration succeeded without a Station installation identity";
        return {
          ok: false,
          detail,
          code: "conflict",
          message: detail,
        } satisfies HostsConfigureRemoteResult;
      }
      const bound = yield* Effect.either(
        bindConfiguredRemoteTarget(
          hosts,
          id,
          result.right.stationInstallationId,
        ),
      );
      if (bound._tag === "Left") {
        return {
          ok: false,
          detail: bound.left.message,
          code: bound.left.code,
          message: bound.left.message,
        } satisfies HostsConfigureRemoteResult;
      }
    }

    return {
      ok: result.right.ok,
      detail: result.right.detail,
      station: result.right.station,
      code: result.right.code,
      message: result.right.message ?? result.right.detail,
    } satisfies HostsConfigureRemoteResult;
  });

export const deployRemoteEffect = (
  input: DecodedHostsDeployRemoteInput,
  artifactSource?: LinuxReleaseCacheSource,
): Effect.Effect<
  HostsDeployRemoteResult,
  never,
  | SettingsService
  | HostsService
  | StationStatusService
  | BoxFleetService
  | PrismService
  | StationRepository
  | StationFleetTargetRepository
> =>
  withHostsDeployRemoteAuthorization(input, (authorization) =>
    Effect.gen(function* () {
      const settingsSvc = yield* SettingsService;
      const hosts = yield* HostsService;
      const stationStatus = yield* StationStatusService;

      const failJob = (
        result: HostsDeployRemoteResult,
        status: "failed" | "auth_required" = "failed",
      ): HostsDeployRemoteResult => {
        finishDeployJob(input.id, {
          status,
          detail: result.detail,
          stages: result.stages ?? getDeployJob(input.id)?.stages,
          ...(result.version === undefined ? {} : { version: result.version }),
          ...(result.recoveryAction === undefined
            ? {}
            : { recoveryHint: result.recoveryAction.kind }),
        });
        return result;
      };

      const settingsResult = yield* Effect.either(settingsSvc.get);
      if (settingsResult._tag === "Left") {
        return failJob({
          ok: false,
          detail: settingsResult.left.message,
          code: settingsResult.left.code,
          message: settingsResult.left.message,
          stages: getDeployJob(input.id)?.stages,
        });
      }

      const effective = computeDeployCapabilities({
        stationRole: settingsResult.right.station.role,
        remoteManagedInstalls: settingsResult.right.fleet.remoteManagedInstalls,
        release: RELEASE_CAPABILITIES,
      });
      if (!effective.effective.deployRemote) {
        const detail =
          effective.detail.deployRemote ??
          MANAGED_REMOTE_DEPLOY_DISABLED_DETAIL;
        return failJob({
          ok: false,
          detail,
          code: "validation",
          message: detail,
          stages: getDeployJob(input.id)?.stages,
        });
      }

      // A Box availability check may resume a machine and update its SSH
      // route. It is therefore admitted only after the release, local role,
      // and operator kill-switch gates above have all passed.
      const boxes = yield* BoxFleetService;
      const route = yield* boxes
        .ensureHostAvailable(input.id)
        .pipe(Effect.either);
      if (route._tag === "Right" && route.right !== undefined) {
        const ip = route.right.machine.ip;
        appendDeployJobStage(
          input.id,
          ip
            ? `box route refreshed user@${ip} state=${route.right.machine.state}`
            : `box route refreshed state=${route.right.machine.state}`,
        );
      }

      const authority = yield* Effect.either(
        resolveCommandCenterConfigureOptions(true),
      );
      if (authority._tag === "Left") {
        return failJob({
          ok: false,
          detail: authority.left.message,
          code: authority.left.code,
          message: authority.left.message,
          stages: getDeployJob(input.id)?.stages,
        });
      }

      setActiveDeployJobHost(input.id);
      const deployResult = yield* hosts
        .deployConfiguredRemote(input.id, {
          ...authority.right,
          ...(artifactSource === undefined ? {} : { artifactSource }),
          ...(authorization === undefined ? {} : { authorization }),
          onAdmitted: (host) => {
            const admittedAt = new Date().toISOString();
            const detail = `${host.label}: deployment admitted; completion receipt pending`;
            return stationStatus
              .recordDeployment(
                deployRecordFromResult({
                  hostId: host.id,
                  endpoint: host.sshEndpoint ?? "",
                  ok: false,
                  outcome: "indeterminate",
                  packageState: "previous",
                  role: "previous",
                  configurationOk: false,
                  detail,
                  stages: ["durable deployment admission recorded"],
                  at: admittedAt,
                }),
              )
              .pipe(
                Effect.mapError(
                  (error) =>
                    new RemoteHostsError(
                      "io",
                      error instanceof Error ? error.message : String(error),
                    ),
                ),
              );
          },
          onCompleted: (host, result) => {
            const recordedAt = new Date().toISOString();
            return stationStatus
              .recordDeployment(
                deployRecordFromResult({
                  hostId: host.id,
                  endpoint: host.sshEndpoint ?? "",
                  ok: result.ok,
                  outcome: result.outcome,
                  packageState: result.packageState,
                  role: result.role,
                  version: result.version,
                  ...(result.lastSeen === undefined
                    ? {}
                    : { lastSeen: result.lastSeen }),
                  configurationOk: result.configuration.ok,
                  detail: result.detail,
                  stages: result.stages,
                  at: recordedAt,
                }),
              )
              .pipe(
                Effect.mapError(
                  (error) =>
                    new RemoteHostsError(
                      "io",
                      error instanceof Error ? error.message : String(error),
                    ),
                ),
              );
          },
        })
        .pipe(
          Effect.ensuring(
            Effect.sync(() => {
              setActiveDeployJobHost(undefined);
            }),
          ),
        );

      if (!deployResult.ok) {
        return failJob(
          projectDeployRemoteResult(deployResult),
          deployResult.authorizationRequest !== undefined
            ? "auth_required"
            : "failed",
        );
      }
      if (deployResult.stationInstallationId === undefined) {
        const failed = deploymentFleetBindingFailure(
          deployResult,
          "Remote configuration returned no Station installation identity",
        );
        return failJob(projectDeployRemoteResult(failed));
      }
      const bound = yield* Effect.either(
        bindConfiguredRemoteTarget(
          hosts,
          input.id,
          deployResult.stationInstallationId,
        ),
      );
      const finalResult =
        bound._tag === "Right"
          ? deployResult
          : deploymentFleetBindingFailure(deployResult, bound.left.message);
      const projected = projectDeployRemoteResult(finalResult);
      finishDeployJob(input.id, {
        status: finalResult.ok ? "succeeded" : "failed",
        detail: finalResult.detail,
        stages: finalResult.stages,
        ...(finalResult.version === undefined
          ? {}
          : { version: finalResult.version }),
      });
      return projected;
    }),
  ).pipe(
    Effect.catchTag("LinuxAdministratorAuthorizationInputError", () => {
      finishDeployJob(input.id, {
        status: "failed",
        detail: "Linux administrator authorization is invalid",
        stages: getDeployJob(input.id)?.stages,
      });
      return Effect.succeed({
        ok: false,
        detail: "Linux administrator authorization is invalid",
        code: "validation",
        message: "Linux administrator authorization is invalid",
      } satisfies HostsDeployRemoteResult);
    }),
  );

const releaseDeployGate = (): HostsDeployRemoteResult | undefined => {
  const releaseGate = computeDeployCapabilities({
    stationRole: "command-center",
    remoteManagedInstalls: true,
    release: RELEASE_CAPABILITIES,
  });
  if (releaseGate.effective.deployRemote) return undefined;
  const detail =
    releaseGate.detail.deployRemote ?? MANAGED_REMOTE_DEPLOY_DISABLED_DETAIL;
  return {
    ok: false,
    detail,
    code: "validation",
    message: detail,
    stages: [],
  };
};

const shutdownConfigureFailure = (
  error: HostOperationShutdownRefused,
): HostsConfigureRemoteResult => ({
  ok: false,
  detail: error.message,
  code: error.code,
  message: error.message,
});

const shutdownDeployFailure = (
  error: HostOperationShutdownRefused,
): HostsDeployRemoteResult => ({
  ok: false,
  detail: error.message,
  code: error.code,
  message: error.message,
});

export interface HostsOperatorCoordinator {
  readonly configureRemote: (
    hostId: string,
  ) => Promise<HostsConfigureRemoteResult>;
  readonly deployRemote: (
    input: unknown,
    artifactSource?: LinuxReleaseCacheSource,
  ) => Promise<HostsDeployRemoteResult>;
}

export const makeHostsOperatorCoordinator = (
  operations: HostOperationGate = hostOperationGate,
): HostsOperatorCoordinator => ({
  configureRemote: (hostId) =>
    operations
      .run(HOST_OPERATION_ADMISSIONS.configureRemote, () =>
        AppRuntime.runPromise(configureRemoteEffect(hostId)),
      )
      .catch((error: unknown) => {
        if (error instanceof HostOperationShutdownRefused) {
          return shutdownConfigureFailure(error);
        }
        throw error;
      }),
  deployRemote: (input, artifactSource) => {
    const releaseFailure = releaseDeployGate();
    if (releaseFailure !== undefined) return Promise.resolve(releaseFailure);
    const decoded = decodeHostsDeployRemoteInput(input);
    if (decoded === undefined) {
      return Promise.resolve({
        ok: false,
        detail: "invalid Remote deployment request",
        code: "validation",
        message: "invalid Remote deployment request",
      });
    }
    return operations
      .run(HOST_OPERATION_ADMISSIONS.deployRemote, () => {
        // A job receipt exists only after the shutdown gate admits the
        // operation. Refusal must not leave a synthetic forever-running job.
        beginDeployJob(decoded.id);
        return AppRuntime.runPromise(
          deployRemoteEffect(decoded, artifactSource),
        );
      })
      .catch((error: unknown) => {
        if (error instanceof HostOperationShutdownRefused) {
          return shutdownDeployFailure(error);
        }
        throw error;
      });
  },
});

/** One app-main coordinator shared by renderer IPC and operator control. */
export const hostsOperatorCoordinator = makeHostsOperatorCoordinator();
