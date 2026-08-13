/** Linux HostRuntime platform. Attach is work control, never a Darwin .app. */
import { Effect } from "effect";
import { stationControlDir, stationDoorSocketPath } from "@shared/station-ssh-control";
import { workControlDir, workControlSocketPath } from "@shared/work-control";
import type { SshTarget } from "../ssh/domain";
import { oneShot } from "../ssh/program";
import { remoteTestSocketExists } from "../ssh/read-commands";
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
  probeRemoteWorkAttach,
  type HostRuntimeApplyContext,
  type HostRuntimePlatformAdapter,
  type HostRuntimePlanes,
} from "./host-runtime-platform";
import type { RemoteDeploymentProvider } from "./remote-deployment";
import { buildObservedRemoteDeploymentTarget } from "./remote-platform";

const probeSocket = (
  ssh: SshTransportShape,
  target: SshTarget,
  path: string,
): Effect.Effect<boolean> =>
  remoteTestSocketExists(path).pipe(
    Effect.flatMap((command) =>
      ssh.run(oneShot(target, command, { budget: "short" })),
    ),
    Effect.map(() => true),
    Effect.catch(() => Effect.succeed(false)),
  );

const observePlanes = (
  ssh: SshTransportShape,
  target: SshTarget,
  home: string,
): Effect.Effect<HostRuntimePlanes> =>
  Effect.gen(function* () {
    const stationHome = stationControlDir(home);
    const enrollUp = yield* probeSocket(
      ssh,
      target,
      stationDoorSocketPath(stationHome, "enroll"),
    );
    const peerUp = yield* probeSocket(
      ssh,
      target,
      stationDoorSocketPath(stationHome, "peer"),
    );
    const workUp = yield* probeRemoteWorkAttach(
      ssh,
      target,
      workControlSocketPath(workControlDir(home)),
    );
    return {
      package: "unknown" as const,
      process: enrollUp || peerUp ? ("up" as const) : ("down" as const),
      workAttach: workUp ? ("up" as const) : ("down" as const),
    };
  });

export type LinuxApplyOperations = {
  readonly deploy: RemoteDeploymentProvider["deploy"];
  readonly configure: typeof configureRemoteHost;
};

const productionLinuxApply: LinuxApplyOperations = {
  deploy: (input) => linuxRemoteDeploymentProvider.deploy(input),
  configure: configureRemoteHost,
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
    if (!firstInstall) {
      const prior = context.priorInstallationId;
      if (prior === undefined) {
        return {
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
        };
      }
      return finishAlreadyConfiguredRemote(
        host,
        deployed,
        prior,
        deployed.detail,
      );
    }
    const configured = yield* operations
      .configure(ssh, host, context.configure)
      .pipe(Effect.result);
    if (configured._tag === "Failure") {
      return configurationFailure(host, deployed, configured.failure);
    }
    if (!configured.success.ok || configured.success.station === undefined) {
      return configurationFailure(host, deployed, configured.success);
    }
    return finishWithConfiguration(host, deployed, configured.success);
  });

export const linuxHostRuntimePlatform: HostRuntimePlatformAdapter = {
  platform: "linux",
  observePlanes,
  apply: applyLinuxHostRuntime,
};
