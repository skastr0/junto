/** Darwin HostRuntime platform. Package is the signed .app. Attach is term. */
import { Effect } from "effect";
import { join } from "node:path";
import { stationControlDir, stationDoorSocketPath } from "@shared/station-ssh-control";
import { TERM_REMOTE_SOCK_REL } from "@shared/term-control";
import { SshExitError, type SshTarget } from "../ssh/domain";
import { oneShot } from "../ssh/program";
import { remoteDarwinPackageExists } from "../ssh/read-commands";
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
import {
  activateDarwinRemoteRuntimeForTarget,
  darwinRemoteDeploymentProvider,
} from "./deploy-darwin";
import {
  combineHostProcessPlanes,
  probeRemoteDoorSocket,
  probeRemoteWorkAttach,
  type HostRuntimeApplyContext,
  type HostRuntimePlatformAdapter,
  type HostRuntimePlanes,
} from "./host-runtime-platform";
import type { RemoteDeploymentProvider } from "./remote-deployment";
import { buildObservedRemoteDeploymentTarget } from "./remote-platform";

const observePlanes = (
  ssh: SshTransportShape,
  target: SshTarget,
  home: string,
): Effect.Effect<HostRuntimePlanes> =>
  Effect.gen(function* () {
    const installedCmd = yield* remoteDarwinPackageExists().pipe(Effect.result);
    let pkg: HostRuntimePlanes["package"] = "unknown";
    if (installedCmd._tag === "Success") {
      const installed = yield* ssh
        .run(oneShot(target, installedCmd.success, { budget: "short" }))
        .pipe(Effect.result);
      if (installed._tag === "Success") pkg = "present";
      else if (
        installed.failure instanceof SshExitError &&
        installed.failure.code === 1
      ) {
        pkg = "absent";
      }
    }
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
      join(home, TERM_REMOTE_SOCK_REL),
    );
    return {
      package: pkg,
      process: combineHostProcessPlanes(enroll, peer),
      workAttach,
    };
  });

export type DarwinApplyOperations = {
  readonly deploy: RemoteDeploymentProvider["deploy"];
  readonly configure: typeof configureRemoteHost;
  readonly activate: typeof activateDarwinRemoteRuntimeForTarget;
};

const productionDarwinApply: DarwinApplyOperations = {
  deploy: (input) => darwinRemoteDeploymentProvider.deploy(input),
  configure: configureRemoteHost,
  activate: activateDarwinRemoteRuntimeForTarget,
};

export const applyDarwinHostRuntime = (
  context: HostRuntimeApplyContext,
  operations: DarwinApplyOperations = productionDarwinApply,
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
      platform: "darwin",
      kernelName: "Darwin",
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
    if (firstInstall) {
      const configured = yield* operations
        .configure(ssh, host, context.configure)
        .pipe(Effect.result);
      if (configured._tag === "Failure") {
        return configurationFailure(host, deployed, configured.failure);
      }
      if (!configured.success.ok || configured.success.station === undefined) {
        return configurationFailure(host, deployed, configured.success);
      }
      const activated = yield* operations.activate(ssh, preparation.target);
      if (!activated.ok) {
        const finished = finishWithConfiguration(
          host,
          deployed,
          configured.success,
        );
        return {
          ...finished,
          ok: false,
          detail: `${host.label}: Station configured as remote, but supervised runtime activate failed — ${activated.detail}`,
          code: "io" as const,
          message: activated.detail,
          disposition: "indeterminate" as const,
          outcome: "indeterminate" as const,
        };
      }
      const finished = finishWithConfiguration(
        host,
        deployed,
        configured.success,
      );
      return {
        ...finished,
        detail: `${finished.detail} - ${activated.detail}`,
        message: activated.detail,
      };
    }
    const prior = context.priorInstallationId;
    const activated = yield* operations.activate(ssh, preparation.target);
    if (prior === undefined) {
      if (!activated.ok) {
        return failedPackageResult(host, {
          ...deployed,
          ok: false,
          detail: activated.detail,
          disposition: "indeterminate",
        });
      }
      return {
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
      };
    }
    if (!activated.ok) {
      return alreadyConfiguredActivateFailure(
        host,
        deployed,
        prior,
        activated.detail,
      );
    }
    return finishAlreadyConfiguredRemote(
      host,
      deployed,
      prior,
      activated.detail,
    );
  });

export const darwinHostRuntimePlatform: HostRuntimePlatformAdapter = {
  platform: "darwin",
  observePlanes,
  apply: applyDarwinHostRuntime,
};
