/** Linux HostRuntime platform. Attach is work control, never a Darwin .app. */
import { Effect } from "effect";
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
  configurationFailure,
  failedBeforeMutation,
  failedPackageResult,
  finishAlreadyConfiguredRemote,
  finishWithConfiguration,
  packageAdmitted,
  type ConfiguredRemoteDeployResult,
} from "./deploy-configured-remote";
import { reportDeployStage } from "./deploy-job-registry";
import { linuxRemoteDeploymentProvider } from "./deploy-linux";
import {
  combineHostProcessPlanes,
  handshakeLinuxWorkControl,
  HOST_RUNTIME_REMEDY_ROUNDS,
  hostRuntimeBlockedDeploy,
  probeRemoteDoorSocket,
  readRemoteTextFile,
  withRemoteUnixForward,
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
      package: "unknown" as const,
      process: combineHostProcessPlanes(enroll, peer),
      workAttach,
    };
  });

export type LinuxApplyOperations = {
  readonly deploy: (
    input: RemoteDeploymentProviderInput,
  ) => Effect.Effect<DeployRemoteResult>;
  readonly configure: typeof configureRemoteHost;
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
    if (token === undefined) return "down";
    return yield* withRemoteUnixForward(
      ssh,
      target,
      workControlSocketPath(workHome),
      (localSocket) =>
        Effect.tryPromise({
          try: () => handshakeLinuxWorkControl(localSocket, token),
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
  proveWorkAttach: proveLinuxWorkAttach,
};

export const applyLinuxHostRuntime = (
  context: HostRuntimeApplyContext,
  operations: LinuxApplyOperations = productionLinuxApply,
): Effect.Effect<ConfiguredRemoteDeployResult> =>
  Effect.gen(function* () {
    const { ssh, host, gap } = context;
    if (host.kind !== "remote" || !host.sshEndpoint) {
      return failedBeforeMutation(
        host,
        `${host.label}: host is not a registered Remote endpoint`,
        { code: "validation" },
      );
    }
    const preparation = yield* buildObservedRemoteDeploymentTarget(ssh, host, {
      platform: "linux",
      kernelName: "Linux",
    });
    if (!preparation.ok) {
      return failedBeforeMutation(host, preparation.result.detail, {
        code: preparation.result.code,
        stages: preparation.result.stages,
        unsupportedTarget: preparation.result.unsupportedTarget,
        recoveryAction: preparation.result.recoveryAction,
      });
    }
    const firstInstall = gap === "needInstall" || gap === "needConfigure";
    let configured:
      | Parameters<typeof finishWithConfiguration>[2]
      | undefined;
    let lastFinished: ConfiguredRemoteDeployResult | undefined;

    for (let round = 0; round < HOST_RUNTIME_REMEDY_ROUNDS; round++) {
      reportDeployStage(
        round === 0
          ? "Copying Vellum Command"
          : "Copying Vellum Command again",
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
      const deployBlocker = classifyHostRuntimeBlocker(deployed.detail);
      if (deployBlocker !== undefined) {
        return hostRuntimeBlockedDeploy(host, deployed, deployBlocker);
      }
      if (!packageAdmitted(deployed)) {
        if (round === HOST_RUNTIME_REMEDY_ROUNDS - 1) {
          return failedPackageResult(host, deployed);
        }
        continue;
      }
      if (firstInstall && configured === undefined) {
        const next = yield* operations
          .configure(ssh, host, context.configure)
          .pipe(Effect.result);
        if (next._tag === "Failure") {
          return configurationFailure(host, deployed, next.failure);
        }
        if (!next.success.ok || next.success.station === undefined) {
          return configurationFailure(host, deployed, next.success);
        }
        configured = next.success;
      }
      const finished =
        configured !== undefined
          ? finishWithConfiguration(host, deployed, configured)
          : context.priorInstallationId === undefined
            ? {
                ...deployed,
                ok: true,
                hostEndpoint: host.sshEndpoint,
                disposition: "ready" as const,
                outcome: "ready" as const,
                packageState: "present" as const,
                role: "remote" as const,
                configuration: {
                  ok: true,
                  detail: "already configured Remote; configure skipped",
                },
              }
            : finishAlreadyConfiguredRemote(
                host,
                deployed,
                context.priorInstallationId,
                deployed.detail,
              );
      lastFinished = finished;
      reportDeployStage("Restarting Vellum Command");
      reportDeployStage("Waiting for Vellum Command to answer");
      const attached = yield* operations.proveWorkAttach(
        ssh,
        preparation.target.sshTarget,
      );
      if (attached === "up") return finished;
    }

    return {
      ...(lastFinished ??
        failedBeforeMutation(
          host,
          `${host.label}: work attach did not connect`,
        )),
      ok: false,
      detail: `${host.label}: work attach did not connect`,
      code: "io" as const,
      message: "work attach did not connect",
      disposition: "indeterminate" as const,
      outcome: "indeterminate" as const,
    };
  });

export const linuxHostRuntimePlatform: HostRuntimePlatformAdapter = {
  platform: "linux",
  observePlanes,
  apply: applyLinuxHostRuntime,
};
