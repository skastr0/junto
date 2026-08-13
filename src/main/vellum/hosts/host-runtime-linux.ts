/** Linux HostRuntime platform. Attach is work control, never a Darwin .app. */
import { Effect } from "effect";
import type { HostWorkAttach } from "@shared/host-runtime";
import { stationControlDir, stationDoorSocketPath } from "@shared/station-ssh-control";
import { workControlDir, workControlSocketPath } from "@shared/work-control";
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
import { linuxRemoteDeploymentProvider } from "./deploy-linux";
import {
  combineHostProcessPlanes,
  probeRemoteDoorSocket,
  probeRemoteWorkAttach,
  type HostRuntimeApplyContext,
  type HostRuntimePlatformAdapter,
  type HostRuntimePlanes,
} from "./host-runtime-platform";
import type { RemoteDeploymentProvider } from "./remote-deployment";
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
    const workAttach = yield* probeRemoteWorkAttach(
      ssh,
      target,
      workControlSocketPath(workControlDir(home)),
    );
    return {
      package: "unknown" as const,
      process: combineHostProcessPlanes(enroll, peer),
      workAttach,
    };
  });

export type LinuxApplyOperations = {
  readonly deploy: RemoteDeploymentProvider["deploy"];
  readonly configure: typeof configureRemoteHost;
  readonly proveWorkAttach: (
    ssh: SshTransportShape,
    target: SshTarget,
  ) => Effect.Effect<HostWorkAttach>;
};

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
    return yield* probeRemoteWorkAttach(
      ssh,
      target,
      workControlSocketPath(workControlDir(home)),
    );
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
    const deployed = yield* operations.deploy({
      ssh,
      target: preparation.target,
      stationConfiguration: firstInstall
        ? { state: "managed-externally" }
        : { state: "applied", remoteHostId: host.id },
      artifactSource: context.artifactSource ?? "stable-feed",
    });
    if (!packageAdmitted(deployed)) {
      return failedPackageResult(host, deployed);
    }
    let finished: ConfiguredRemoteDeployResult;
    if (!firstInstall) {
      const prior = context.priorInstallationId;
      finished =
        prior === undefined
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
              prior,
              deployed.detail,
            );
    } else {
      const configured = yield* operations
        .configure(ssh, host, context.configure)
        .pipe(Effect.result);
      if (configured._tag === "Failure") {
        return configurationFailure(host, deployed, configured.failure);
      }
      if (!configured.success.ok || configured.success.station === undefined) {
        return configurationFailure(host, deployed, configured.success);
      }
      finished = finishWithConfiguration(host, deployed, configured.success);
    }
    const attached = yield* operations.proveWorkAttach(
      ssh,
      preparation.target.sshTarget,
    );
    if (attached !== "up") {
      return {
        ...finished,
        ok: false,
        detail: `${host.label}: work attach did not connect`,
        code: "io" as const,
        message: "work attach did not connect",
        disposition: "indeterminate" as const,
        outcome: "indeterminate" as const,
      };
    }
    return finished;
  });

export const linuxHostRuntimePlatform: HostRuntimePlatformAdapter = {
  platform: "linux",
  observePlanes,
  apply: applyLinuxHostRuntime,
};
