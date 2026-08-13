/** Linux HostRuntime platform. Attach is work control, never a Darwin .app. */
import { Effect } from "effect";
import { HOST_RUNTIME_REMEDY_STAGE } from "@shared/deploy-job";
import { classifyHostRuntimeBlocker, type HostWorkAttach } from "@shared/host-runtime";
import { stationControlDir, stationDoorSocketPath } from "@shared/station-ssh-control";
import {
  workControlDir,
  workControlSocketPath,
  workControlTokenPath,
} from "@shared/work-control";
import type { SshTarget } from "../ssh/domain";
import { homeDirectoryLookup } from "../ssh/program";
import type { SshTransportShape } from "../ssh/service";
import { configureRemoteHost } from "./configure-remote";
import {
  alreadyConfiguredActivateFailure,
  configurationFailure,
  failedBeforeMutation,
  failedPackageResult,
  finishAlreadyConfiguredRemote,
  finishWithConfiguration,
  packageAdmitted,
  type ConfiguredRemoteDeployResult,
} from "./deploy-configured-remote";
import { reportDeployStage } from "./deploy-job-registry";
import {
  activateLinuxRemoteRuntimeForTarget,
  linuxRemoteDeploymentProvider,
  observeLinuxUserlandPackage,
} from "./deploy-linux";
import {
  combineHostProcessPlanes,
  handshakeLinuxWorkControl,
  HOST_RUNTIME_REMEDY_ROUNDS,
  hostRuntimeBlockedDeploy,
  probeRemoteDoorSocket,
  readRemoteTextFile,
  sealHostRuntimeStages,
  withRemoteUnixForward,
  workAttachFromTokenFile,
  type HostRuntimeApplyContext,
  type HostRuntimePlatformAdapter,
  type HostRuntimePlanes,
} from "./host-runtime-platform";
import type {
  DeployRemoteResult,
  RemoteDeploymentProviderInput,
} from "./remote-deployment";
import { decodeRemoteHomeDirectoryOutput } from "./remote-home";
import { buildObservedRemoteDeploymentTarget } from "./remote-platform";

const observePlanes = (
  ssh: SshTransportShape,
  target: SshTarget,
  home: string,
): Effect.Effect<HostRuntimePlanes> =>
  Effect.gen(function* () {
    const pkg = yield* observeLinuxUserlandPackage(ssh, target);
    const stationHome = stationControlDir(home);
    const enroll = yield* probeRemoteDoorSocket(
      ssh,
      target,
      stationDoorSocketPath(stationHome, "enroll"),
    );
    const peer = yield* probeRemoteDoorSocket(
      ssh,
      target,
      stationDoorSocketPath(stationHome, "peer"),
    );
    const workAttach = yield* probeLinuxWorkAttach(ssh, target, home);
    return {
      package: pkg,
      process: combineHostProcessPlanes(enroll, peer),
      workAttach,
    };
  });

export type LinuxApplyOperations = {
  readonly deploy: (
    input: RemoteDeploymentProviderInput,
  ) => Effect.Effect<DeployRemoteResult>;
  readonly configure: typeof configureRemoteHost;
  readonly activate: typeof activateLinuxRemoteRuntimeForTarget;
  readonly proveWorkAttach: (
    ssh: SshTransportShape,
    target: SshTarget,
  ) => Effect.Effect<HostWorkAttach>;
};

const probeLinuxWorkAttach = (
  ssh: SshTransportShape,
  target: SshTarget,
  home: string,
): Effect.Effect<HostWorkAttach> =>
  Effect.gen(function* () {
    const workHome = workControlDir(home);
    const token = yield* readRemoteTextFile(
      ssh,
      target,
      workControlTokenPath(workHome),
    );
    const fromToken = workAttachFromTokenFile(token);
    if (fromToken !== undefined) return fromToken;
    if (token._tag !== "present") return "unknown";
    return yield* withRemoteUnixForward(
      ssh,
      target,
      workControlSocketPath(workHome),
      (localSocket) =>
        Effect.tryPromise({
          try: () => handshakeLinuxWorkControl(localSocket, token.text),
          catch: () => new Error("work-control handshake failed"),
        }).pipe(Effect.orElseSucceed(() => "unknown" as const)),
    );
  });

const proveLinuxWorkAttach = (
  ssh: SshTransportShape,
  target: SshTarget,
): Effect.Effect<HostWorkAttach> =>
  Effect.gen(function* () {
    const homeResult = yield* ssh
      .run(homeDirectoryLookup(target))
      .pipe(Effect.result);
    if (homeResult._tag === "Failure") return "unknown";
    const home = decodeRemoteHomeDirectoryOutput(homeResult.success.stdout);
    if (home === null) return "unknown";
    return yield* probeLinuxWorkAttach(ssh, target, home);
  });

const productionLinuxApply: LinuxApplyOperations = {
  deploy: (input) => linuxRemoteDeploymentProvider.deploy(input),
  configure: configureRemoteHost,
  activate: activateLinuxRemoteRuntimeForTarget,
  proveWorkAttach: proveLinuxWorkAttach,
};

export const applyLinuxHostRuntime = (
  context: HostRuntimeApplyContext,
  operations: LinuxApplyOperations = productionLinuxApply,
): Effect.Effect<ConfiguredRemoteDeployResult> =>
  Effect.gen(function* () {
    const { ssh, host, gap } = context;
    const remedyStages: string[] = [];
    const note = (stage: string) => {
      reportDeployStage(stage);
      if (!remedyStages.includes(stage)) remedyStages.push(stage);
    };
    const seal = (result: ConfiguredRemoteDeployResult) =>
      sealHostRuntimeStages(result, remedyStages);

    if (host.kind !== "remote" || !host.sshEndpoint) {
      return seal(
        failedBeforeMutation(
          host,
          `${host.label}: host is not a registered Remote endpoint`,
          { code: "validation" },
        ),
      );
    }
    const preparation = yield* buildObservedRemoteDeploymentTarget(ssh, host, {
      platform: "linux",
      kernelName: "Linux",
    });
    if (!preparation.ok) {
      return seal(
        failedBeforeMutation(host, preparation.result.detail, {
          code: preparation.result.code,
          stages: preparation.result.stages,
          unsupportedTarget: preparation.result.unsupportedTarget,
          recoveryAction: preparation.result.recoveryAction,
        }),
      );
    }
    const firstInstall = gap === "needInstall" || gap === "needConfigure";
    let configured:
      | Parameters<typeof finishWithConfiguration>[2]
      | undefined;
    let lastDeployed: Parameters<typeof failedPackageResult>[1] | undefined;
    let lastActivated: { ok: boolean; detail: string } | undefined;

    for (let round = 0; round < HOST_RUNTIME_REMEDY_ROUNDS; round++) {
      note(
        round === 0
          ? HOST_RUNTIME_REMEDY_STAGE.copy
          : HOST_RUNTIME_REMEDY_STAGE.copyAgain,
      );
      const deployed = yield* operations.deploy({
        ssh,
        target: preparation.target,
        stationConfiguration:
          firstInstall && configured === undefined
            ? { state: "managed-externally" }
            : { state: "applied", remoteHostId: host.id },
        artifactSource: context.artifactSource ?? "stable-feed",
      });
      lastDeployed = deployed;
      const deployBlocker = classifyHostRuntimeBlocker(deployed.detail);
      if (deployBlocker !== undefined) {
        return seal(hostRuntimeBlockedDeploy(host, deployed, deployBlocker));
      }
      if (!packageAdmitted(deployed)) {
        if (round === HOST_RUNTIME_REMEDY_ROUNDS - 1) {
          return seal(failedPackageResult(host, deployed));
        }
        continue;
      }
      if (firstInstall && configured === undefined) {
        const next = yield* operations
          .configure(ssh, host, context.configure)
          .pipe(Effect.result);
        if (next._tag === "Failure") {
          return seal(configurationFailure(host, deployed, next.failure));
        }
        if (!next.success.ok || next.success.station === undefined) {
          return seal(configurationFailure(host, deployed, next.success));
        }
        configured = next.success;
      }
      note(HOST_RUNTIME_REMEDY_STAGE.restart);
      const activated = yield* operations.activate(ssh, preparation.target);
      lastActivated = activated;
      const activateBlocker = classifyHostRuntimeBlocker(activated.detail);
      if (activateBlocker !== undefined) {
        return seal(
          hostRuntimeBlockedDeploy(
            host,
            { ...deployed, detail: activated.detail },
            activateBlocker,
          ),
        );
      }
      if (!activated.ok) {
        if (round === HOST_RUNTIME_REMEDY_ROUNDS - 1) {
          if (configured !== undefined) {
            const finished = finishWithConfiguration(
              host,
              deployed,
              configured,
            );
            return seal({
              ...finished,
              ok: false,
              detail: `${host.label}: Station configured as remote, but supervised runtime activate failed — ${activated.detail}`,
              code: "io" as const,
              message: activated.detail,
              disposition: "indeterminate" as const,
              outcome: "indeterminate" as const,
            });
          }
          const prior = context.priorInstallationId;
          if (prior === undefined) {
            return seal(
              failedPackageResult(host, {
                ...deployed,
                ok: false,
                detail: activated.detail,
                disposition: "indeterminate",
              }),
            );
          }
          return seal(
            alreadyConfiguredActivateFailure(
              host,
              deployed,
              prior,
              activated.detail,
            ),
          );
        }
        continue;
      }
      note(HOST_RUNTIME_REMEDY_STAGE.wait);
      const attached = yield* operations.proveWorkAttach(
        ssh,
        preparation.target.sshTarget,
      );
      if (attached === "up") {
        if (configured !== undefined) {
          const finished = finishWithConfiguration(
            host,
            deployed,
            configured,
          );
          return seal({
            ...finished,
            detail: `${finished.detail} - ${activated.detail}`,
            message: activated.detail,
          });
        }
        const prior = context.priorInstallationId;
        if (prior === undefined) {
          return seal({
            ...deployed,
            ok: true,
            detail: `${deployed.detail} - ${activated.detail}`,
            message: activated.detail,
            hostEndpoint: host.sshEndpoint,
            disposition: "ready",
            outcome: "ready",
            packageState: "present",
            role: "remote",
            configuration: {
              ok: true,
              detail: "already configured Remote; configure skipped",
            },
          });
        }
        return seal(
          finishAlreadyConfiguredRemote(
            host,
            deployed,
            prior,
            activated.detail,
          ),
        );
      }
    }

    const deployed = lastDeployed ?? {
      ok: false,
      detail: `${host.label}: work attach did not connect`,
      stages: [],
      disposition: "indeterminate" as const,
    };
    if (configured !== undefined) {
      const finished = finishWithConfiguration(host, deployed, configured);
      return seal({
        ...finished,
        ok: false,
        detail: `${host.label}: work attach did not connect`,
        code: "io" as const,
        message: lastActivated?.detail ?? "work attach did not connect",
        disposition: "indeterminate" as const,
        outcome: "indeterminate" as const,
      });
    }
    return seal({
      ...failedPackageResult(host, {
        ...deployed,
        ok: false,
        detail: `${host.label}: work attach did not connect`,
        disposition: "indeterminate",
      }),
      code: "io" as const,
      message: "work attach did not connect",
    });
  });

export const linuxHostRuntimePlatform: HostRuntimePlatformAdapter = {
  platform: "linux",
  observePlanes,
  apply: applyLinuxHostRuntime,
};
