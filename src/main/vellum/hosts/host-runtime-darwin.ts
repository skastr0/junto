/** Darwin HostRuntime platform. Package is the signed .app. Attach is term. */
import { Effect, Layer } from "effect";
import { join } from "node:path";
import { HOST_RUNTIME_REMEDY_STAGE } from "@shared/deploy-job";
import { classifyHostRuntimeBlocker, type HostWorkAttach } from "@shared/host-runtime";
import { stationControlDir, stationDoorSocketPath } from "@shared/station-ssh-control";
import { TERM_REMOTE_SOCK_REL, termControlTokenPath } from "@shared/term-control";
import { SshExitError, type SshTarget } from "../ssh/domain";
import { homeDirectoryLookup, oneShot } from "../ssh/program";
import { remoteDarwinPackageExists } from "../ssh/read-commands";
import { SshTransport, type SshTransportShape } from "../ssh/service";
import { HostOps, HostTarget } from "./host-ops";
import type { HostOpsCleanup } from "@shared/host-ops";
import { TermControlClient } from "../term/control-client";
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
import { reportDeployStage } from "./deploy-job-registry";
import {
  combineHostProcessPlanes,
  HOST_RUNTIME_REMEDY_ROUNDS,
  hostRuntimeBlockedDeploy,
  probeRemoteDoorSocket,
  readRemoteTextFile,
  sealHostRuntimeStages,
  withRemoteUnixForward,
  workAttachFromTermConnect,
  workAttachFromTokenFile,
  type HostRuntimeApplyContext,
  type HostRuntimePlatformAdapter,
  type HostRuntimePlanes,
} from "./host-runtime-platform";
import { decodeRemoteHomeDirectoryOutput } from "./remote-home";
import type {
  DeployRemoteResult,
  RemoteDeploymentProviderInput,
} from "./remote-deployment";
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
    const workAttach = yield* probeDarwinWorkAttach(ssh, target, home);
    return {
      package: pkg,
      process: combineHostProcessPlanes(enroll, peer),
      workAttach,
    };
  });

const probeDarwinWorkAttach = (
  ssh: SshTransportShape,
  target: SshTarget,
  home: string,
): Effect.Effect<HostWorkAttach> =>
  Effect.gen(function* () {
    const token = yield* readRemoteTextFile(
      ssh,
      target,
      termControlTokenPath(home),
    );
    const fromToken = workAttachFromTokenFile(token);
    if (fromToken !== undefined) return fromToken;
    if (token._tag !== "present") return "unknown";
    return yield* withRemoteUnixForward(
      ssh,
      target,
      join(home, TERM_REMOTE_SOCK_REL),
      (localSocket) =>
        Effect.tryPromise({
          try: async () => {
            const client = await TermControlClient.connect({
              socketPath: localSocket,
              token: token.text,
              timeoutMs: 2_000,
            });
            await client.drainOnQuit();
            return "up" as const;
          },
          catch: (error) =>
            error instanceof Error ? error : new Error("term attach failed"),
        }).pipe(
          Effect.catch((error) =>
            Effect.succeed(workAttachFromTermConnect(error)),
          ),
        ),
    );
  });

const proveDarwinWorkAttach = (
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
    return yield* probeDarwinWorkAttach(ssh, target, home);
  });

export type DarwinApplyOperations = {
  readonly deploy: (
    input: RemoteDeploymentProviderInput,
  ) => Effect.Effect<DeployRemoteResult>;
  readonly configure: typeof configureRemoteHost;
  readonly activate: typeof activateDarwinRemoteRuntimeForTarget;
  readonly proveWorkAttach: (
    ssh: SshTransportShape,
    target: SshTarget,
  ) => Effect.Effect<HostWorkAttach>;
  readonly cleanup?: (
    ssh: SshTransportShape,
    target: SshTarget,
  ) => Effect.Effect<HostOpsCleanup>;
};

const productionDarwinApply: DarwinApplyOperations = {
  deploy: (input) => darwinRemoteDeploymentProvider.deploy(input),
  configure: configureRemoteHost,
  activate: activateDarwinRemoteRuntimeForTarget,
  proveWorkAttach: proveDarwinWorkAttach,
  cleanup: (ssh, target) =>
    Effect.gen(function* () {
      const ops = yield* HostOps;
      return yield* ops.cleanup();
    }).pipe(
      Effect.provide(
        HostOps.layerDarwin.pipe(
          Layer.provide(HostTarget.layer(target)),
          Layer.provide(Layer.succeed(SshTransport, ssh)),
        ),
      ),
    ),
};

export const applyDarwinHostRuntime = (
  context: HostRuntimeApplyContext,
  operations: DarwinApplyOperations = productionDarwinApply,
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
      platform: "darwin",
      kernelName: "Darwin",
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
    if (operations.cleanup !== undefined) {
      const cleaned = yield* operations
        .cleanup(ssh, preparation.target.sshTarget)
        .pipe(Effect.result);
      if (
        cleaned._tag === "Success" &&
        cleaned.success.removed.length > 0
      ) {
        note(
          `removed abandoned leftovers: ${cleaned.success.removed.join(", ")}`,
        );
      }
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
      note(HOST_RUNTIME_REMEDY_STAGE.sign);
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

export const darwinHostRuntimePlatform: HostRuntimePlatformAdapter = {
  platform: "darwin",
  observePlanes,
  apply: applyDarwinHostRuntime,
};
