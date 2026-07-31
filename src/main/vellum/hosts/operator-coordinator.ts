import { Context, Effect } from "effect";
import {
  OPERATOR_PROTOCOL_VERSION,
  type OperatorDataByOp,
  type OperatorErrorResponse,
  type OperatorErrorType,
  type OperatorFleetDeployData,
  type OperatorFleetFailure,
  type OperatorFleetPeerStatus,
  type OperatorFleetSyncResult,
  type OperatorPublicHost,
  type OperatorRequestEnvelope,
  type OperatorResponseEnvelope,
} from "@shared/operator-control";
import type {
  HostsConfigureRemoteResult,
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
import type { LinuxReleaseCacheSource } from "./linux-release-feed";
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
import { RemoteHostsError, type RemoteHost } from "@shared/remote-hosts";
import { DEFAULT_STATION_HOST_ID } from "@shared/station";
import {
  STATION_API_PROTOCOL,
  StatusResponse,
  type StationReadiness,
} from "@shared/station-api";
import type {
  StationFleetPeerStatus,
  StationFleetPeerUnavailable,
  StationFleetPropagationResult,
} from "../station/fleet-propagation";
import { StationFleetPropagation } from "../station/fleet-propagation";
import {
  OperatorQualificationWorkError,
  qualificationWorkPrepareEffect,
  qualificationWorkProgressEffect,
  qualificationWorkVerifyEffect,
} from "./operator-qualification-work";

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

export type DecodedHostsDeployRemoteInput = HostsDeployRemoteInput;

export const decodeHostsDeployRemoteInput = (
  value: unknown,
): DecodedHostsDeployRemoteInput | undefined => {
  const input = record(value);
  if (
    input === undefined ||
    !exactKeys(input, ["id"]) ||
    typeof input.id !== "string" ||
    input.id.length === 0
  ) {
    return undefined;
  }
  return { id: input.id };
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
          "failed",
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
  });

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

class OperatorCoordinatorError extends Error {
  constructor(
    readonly type: OperatorErrorType,
    message: string,
  ) {
    super(message);
    this.name = "OperatorCoordinatorError";
  }
}

const operatorDiagnostic = (value: string): string => {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "operator request failed";
  return trimmed.slice(0, 4_096);
};

const operatorErrorResponse = (
  request: Pick<OperatorRequestEnvelope, "id" | "op">,
  type: OperatorErrorType,
  message: string,
): OperatorErrorResponse => ({
  protocol: OPERATOR_PROTOCOL_VERSION,
  id: request.id,
  ok: false,
  op: request.op,
  error: {
    type,
    message: operatorDiagnostic(message),
  },
});

const operatorSuccess = <Op extends keyof OperatorDataByOp>(
  request: Pick<OperatorRequestEnvelope, "id"> & { readonly op: Op },
  data: OperatorDataByOp[Op],
): OperatorResponseEnvelope =>
  ({
    protocol: OPERATOR_PROTOCOL_VERSION,
    id: request.id,
    ok: true,
    op: request.op,
    data,
  }) as OperatorResponseEnvelope;

const requireCommandCenterEffect = Effect.gen(function* () {
  const settings = yield* SettingsService;
  const current = yield* settings.get;
  if (current.station.role !== "command-center") {
    return yield* Effect.fail(
      new OperatorCoordinatorError(
        "forbidden",
        "fleet operations require a configured Command Center",
      ),
    );
  }
  return current;
});

const localStatusEffect = (readiness: StationReadiness) =>
  Effect.gen(function* () {
    const stations = yield* StationRepository;
    const facts = yield* stations.statusFacts;
    const state =
      facts.configuration === undefined
        ? facts.pairing === undefined
          ? "unenrolled"
          : "paired"
        : facts.configuration.role !== "command-center" &&
            facts.projection === undefined
          ? "configured"
          : readiness.database &&
              readiness.workControl &&
              readiness.simulation &&
              readiness.session
            ? "ready"
            : "degraded";
    return StatusResponse.make({
      protocol: STATION_API_PROTOCOL,
      op: "status",
      installationId: facts.installationId,
      state,
      ...(facts.configuration === undefined
        ? {}
        : { configuration: facts.configuration }),
      ...(facts.configuredAt === undefined
        ? {}
        : { configuredAt: facts.configuredAt }),
      ...(facts.projection === undefined
        ? {}
        : { projection: facts.projection }),
      receivedThrough: facts.receivedThrough,
      peerAcknowledgedThrough: [],
      readiness,
      observedAt: new Date().toISOString(),
    });
  });

const projectHosts = (
  hosts: ReadonlyArray<RemoteHost>,
): ReadonlyArray<OperatorPublicHost> =>
  hosts.map((host) => ({
    id: host.id as OperatorPublicHost["id"],
    label: host.label,
    kind: host.kind,
    ...(host.sshEndpoint === undefined
      ? {}
      : { sshEndpoint: host.sshEndpoint }),
    capabilities: [...host.capabilities],
    ...(host.hermesId === undefined ? {} : { hermesId: host.hermesId }),
  }));

const projectFleetFailure = (
  failure: StationFleetPeerUnavailable,
): OperatorFleetFailure => ({
  hostId: failure.hostId,
  ...(failure.stationInstallationId === undefined
    ? {}
    : { stationInstallationId: failure.stationInstallationId }),
  reason: failure.reason,
  ...(failure.causeTag === undefined
    ? {}
    : { causeTag: failure.causeTag.slice(0, 128) }),
  message: operatorDiagnostic(failure.message),
});

const projectPeerStatus = (
  status: StationFleetPeerStatus,
): OperatorFleetPeerStatus => ({
  hostId: status.hostId,
  stationInstallationId: status.stationInstallationId,
  phase: status.phase,
  sessionOpen: status.sessionOpen,
  attempt: status.attempt,
  updatedAt: status.updatedAt,
  ...(status.nextRetryAt === undefined
    ? {}
    : { nextRetryAt: status.nextRetryAt }),
  ...(status.protocol === undefined ? {} : { protocol: status.protocol }),
  ...(status.lastReceipt === undefined
    ? {}
    : { lastReceipt: status.lastReceipt }),
  ...(status.lastFailure === undefined
    ? {}
    : { lastFailure: projectFleetFailure(status.lastFailure) }),
});

const projectSyncResult = (
  result: StationFleetPropagationResult,
): OperatorFleetSyncResult =>
  result.ok
    ? {
        ok: true,
        hostId: result.hostId,
        stationInstallationId: result.stationInstallationId,
        receipt: result.receipt,
        status: projectPeerStatus(result.status),
      }
    : {
        ok: false,
        hostId: result.hostId,
        ...(result.stationInstallationId === undefined
          ? {}
          : { stationInstallationId: result.stationInstallationId }),
        error: projectFleetFailure(result.error),
        ...(result.status === undefined
          ? {}
          : { status: projectPeerStatus(result.status) }),
      };

export const projectOperatorDeployResult = (
  result: HostsDeployRemoteResult,
): OperatorFleetDeployData => {
  const common = {
    ok: result.ok,
    detail: operatorDiagnostic(result.detail),
    ...(result.code === undefined ? {} : { code: result.code }),
    stages: [...(result.stages ?? [])].slice(0, 128),
    ...(result.version === undefined ? {} : { version: result.version }),
  };
  return {
    ...common,
    status:
      result.ok && result.outcome === "ready"
        ? "ready"
        : result.outcome === "indeterminate"
          ? "indeterminate"
          : "failed",
    ...(result.outcome === undefined ? {} : { outcome: result.outcome }),
    ...(result.packageState === undefined
      ? {}
      : { packageState: result.packageState }),
    ...(result.role === undefined ? {} : { role: result.role }),
    ...(result.lastSeen === undefined ? {} : { lastSeen: result.lastSeen }),
    ...(result.statusRecorded === undefined
      ? {}
      : { statusRecorded: result.statusRecorded }),
    ...(result.recoveryAction === undefined
      ? {}
      : { recoveryAction: result.recoveryAction }),
  };
};

export interface OperatorCoordinatorOptions {
  readonly fleetReady: () => boolean;
  readonly readiness: () => StationReadiness;
  readonly sessionReady: () => boolean;
  readonly hosts?: HostsOperatorCoordinator;
}

export interface OperatorCoordinator {
  readonly dispatch: (
    request: OperatorRequestEnvelope,
  ) => Promise<OperatorResponseEnvelope>;
}

export const operatorArtifactSource = (
  request:
    | Extract<OperatorRequestEnvelope, { readonly op: "fleet.deploy" }>
    | Extract<OperatorRequestEnvelope, { readonly op: "fleet.qualify" }>,
): LinuxReleaseCacheSource =>
  request.op === "fleet.qualify"
    ? "qualification-candidate"
    : request.args.source === "stable"
      ? "stable-feed"
      : "verified-cache";

export const makeOperatorCoordinator = (
  options: OperatorCoordinatorOptions,
): OperatorCoordinator => {
  const hostCoordinator = options.hosts ?? hostsOperatorCoordinator;

  const run = async (
    request: OperatorRequestEnvelope,
  ): Promise<OperatorResponseEnvelope> => {
    if (request.op === "station.status") {
      const status = await AppRuntime.runPromise(
        localStatusEffect(options.readiness()),
      );
      return operatorSuccess(request, status);
    }

    if (request.op === "station.configure-command-center") {
      const status = await AppRuntime.runPromise(
        Effect.gen(function* () {
          const settings = yield* SettingsService;
          const current = yield* settings.get;
          yield* settings.setStationTopology({
            role: "command-center",
            hostId: DEFAULT_STATION_HOST_ID,
            supervisedPreferred: current.station.supervisedPreferred,
          });
          return yield* localStatusEffect(options.readiness());
        }),
      );
      return operatorSuccess(request, status);
    }

    if (!options.fleetReady()) {
      throw new OperatorCoordinatorError(
        "runtime_down",
        "fleet operations are unavailable until licensed product startup completes",
      );
    }

    if (request.op === "qualification.work.prepare") {
      const data = await AppRuntime.runPromise(
        qualificationWorkPrepareEffect(request.args),
      );
      return operatorSuccess(request, data);
    }

    if (request.op === "qualification.work.progress-offline") {
      const data = await AppRuntime.runPromise(
        qualificationWorkProgressEffect(
          request.args,
          options.sessionReady,
        ),
      );
      return operatorSuccess(request, data);
    }

    if (request.op === "qualification.work.verify") {
      const data = await AppRuntime.runPromise(
        qualificationWorkVerifyEffect(request.args),
      );
      return operatorSuccess(request, data);
    }

    if (request.op === "fleet.list") {
      const hosts = await AppRuntime.runPromise(
        Effect.gen(function* () {
          yield* requireCommandCenterEffect;
          const service = yield* HostsService;
          return yield* service.list;
        }),
      );
      return operatorSuccess(request, { hosts: projectHosts(hosts) });
    }

    if (request.op === "fleet.add") {
      const hosts = await AppRuntime.runPromise(
        Effect.gen(function* () {
          yield* requireCommandCenterEffect;
          const service = yield* HostsService;
          const existing = yield* service.get(request.args.id);
          if (existing !== undefined) {
            return yield* Effect.fail(
              new OperatorCoordinatorError(
                "conflict",
                "fleet host already exists",
              ),
            );
          }
          return yield* service.upsert({
            id: request.args.id,
            label: request.args.label,
            kind: "remote",
            sshEndpoint: request.args.sshEndpoint,
            capabilities: [...request.args.capabilities],
          });
        }),
      );
      return operatorSuccess(request, { hosts: projectHosts(hosts) });
    }

    if (request.op === "fleet.test") {
      const result = await AppRuntime.runPromise(
        Effect.gen(function* () {
          yield* requireCommandCenterEffect;
          const boxes = yield* BoxFleetService;
          yield* boxes.ensureHostAvailable(request.args.id).pipe(Effect.ignore);
          const hosts = yield* HostsService;
          return yield* Effect.either(hosts.test(request.args.id));
        }),
      );
      if (result._tag === "Left") {
        return operatorSuccess(request, {
          hostId: request.args.id,
          ok: false,
          detail: operatorDiagnostic(result.left.message),
          code: result.left.code,
        });
      }
      return operatorSuccess(request, {
        hostId: request.args.id,
        ok: result.right.ok,
        detail: operatorDiagnostic(result.right.detail),
        ...(result.right.reachability === undefined
          ? {}
          : { reachability: result.right.reachability }),
        ...(result.right.protocol === undefined
          ? {}
          : { protocol: result.right.protocol }),
      });
    }

    if (request.op === "fleet.enable-managed-installs") {
      await AppRuntime.runPromise(
        Effect.gen(function* () {
          yield* requireCommandCenterEffect;
          const settings = yield* SettingsService;
          yield* settings.patch({
            fleet: { remoteManagedInstalls: true },
          });
        }),
      );
      return operatorSuccess(request, { remoteManagedInstalls: true });
    }

    if (request.op === "fleet.deploy" || request.op === "fleet.qualify") {
      await AppRuntime.runPromise(requireCommandCenterEffect);
      const source = operatorArtifactSource(request);
      const result = await hostCoordinator.deployRemote(
        { id: request.args.id },
        source,
      );
      return operatorSuccess(request, projectOperatorDeployResult(result));
    }

    if (request.op === "fleet.sync") {
      const results = await AppRuntime.runPromise(
        Effect.gen(function* () {
          yield* requireCommandCenterEffect;
          const fleet = yield* StationFleetPropagation;
          yield* fleet.start();
          return yield* fleet.synchronize(request.args.id);
        }),
      );
      return operatorSuccess(request, {
        results: results.map(projectSyncResult),
      });
    }

    const peers = await AppRuntime.runPromise(
      Effect.gen(function* () {
        yield* requireCommandCenterEffect;
        const fleet = yield* StationFleetPropagation;
        if (request.args.id === undefined) return yield* fleet.statuses;
        const status = yield* fleet.status(request.args.id);
        return status === undefined ? [] : [status];
      }),
    );
    return operatorSuccess(request, {
      peers: peers.map(projectPeerStatus),
    });
  };

  return {
    dispatch: async (request) => {
      try {
        return await run(request);
      } catch (error) {
        if (error instanceof OperatorCoordinatorError) {
          return operatorErrorResponse(request, error.type, error.message);
        }
        if (error instanceof OperatorQualificationWorkError) {
          return operatorErrorResponse(request, error.type, error.message);
        }
        if (error instanceof RemoteHostsError) {
          const type: OperatorErrorType =
            error.code === "not_found"
              ? "not_found"
              : error.code === "conflict"
                ? "conflict"
                : error.code === "validation"
                  ? "validation"
                  : "io";
          return operatorErrorResponse(request, type, error.message);
        }
        return operatorErrorResponse(
          request,
          "internal_error",
          "operator request failed",
        );
      }
    },
  };
};
