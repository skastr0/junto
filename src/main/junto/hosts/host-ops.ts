/**
 * Host-ops — Effect v4 inversion of control.
 *
 * Contract: HostOps. Programs call inspect / copy / cleanup / configure /
 * activate / attach and never name an OS or a target.
 * Target is HostTarget. Pair facts are HostConfigure. Darwin/Linux are
 * layers. Layer.unwrap loads one after the packaged-platform probe.
 */
import { Context, Effect, Layer, Schema } from "effect";
import type {
  HostOpsActivate,
  HostOpsAttach,
  HostOpsCleanup,
  HostOpsConfigure,
  HostOpsCopy,
  HostOpsInspect,
} from "@shared/host-ops";
import { InstallationId } from "@shared/installation-id";
import type { RemoteHost } from "@shared/remote-hosts";
import { inspectSshTarget, type SshError, type SshTarget } from "../ssh/domain";
import {
  inspectRemotePackagedPlatform,
  RemotePlatformProbeError,
  resolveRemotePackagedPlatform,
} from "../ssh/read-commands";
import { SshTransport, type SshTransportShape } from "../ssh/service";
import {
  configureRemoteHost,
  type ConfigureRemoteOptions,
} from "./configure-remote";
import type {
  DeployableRemoteHost,
  DeployRemoteResult,
  RemoteDeploymentTarget,
  RemotePlatformDescriptor,
} from "./remote-deployment";

const decodeInstallationId = Schema.decodeUnknownSync(InstallationId);

/** Placeholder pair facts so inspect / copy / cleanup layers stay target-only. */
const UNSET_HOST_CONFIGURE: ConfigureRemoteOptions = {
  commandCenterInstallationId: decodeInstallationId("unset"),
  appVersion: "0.0.0",
};

const hostIdFromEndpoint = (endpoint: string): string => {
  const cleaned = endpoint
    .replace(/[^A-Za-z0-9._-]/gu, "-")
    .replace(/^-+/u, "")
    .slice(0, 64);
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(cleaned) ? cleaned : "remote";
};

const hostRecordFromTarget = (target: SshTarget): DeployableRemoteHost => {
  const details = inspectSshTarget(target);
  const endpoint = details.endpoint;
  const id = hostIdFromEndpoint(endpoint);
  return {
    id,
    label: id,
    kind: "remote",
    sshEndpoint: endpoint,
    capabilities: ["terminal"],
    ...(details.identityFile === undefined
      ? {}
      : { sshIdentityFile: details.identityFile }),
    ...(details.hostKeyPolicy === "system"
      ? {}
      : { sshHostKeyPolicy: details.hostKeyPolicy }),
  };
};

const configureHostOps = (
  ssh: SshTransportShape,
  target: SshTarget,
  facts: ConfigureRemoteOptions,
): Effect.Effect<HostOpsConfigure> =>
  Effect.gen(function* () {
    const observedAt = new Date().toISOString();
    const host: RemoteHost = hostRecordFromTarget(target);
    const result = yield* configureRemoteHost(ssh, host, facts).pipe(
      Effect.result,
    );
    if (result._tag === "Failure") {
      return {
        ok: false,
        detail: result.failure.message,
        code: result.failure.code,
        observedAt,
      };
    }
    return {
      ok: result.success.ok,
      detail: result.success.detail,
      ...(result.success.stationInstallationId === undefined
        ? {}
        : { stationInstallationId: result.success.stationInstallationId }),
      ...(result.success.configuredAt === undefined
        ? {}
        : { configuredAt: result.success.configuredAt }),
      ...(result.success.code === undefined ? {} : { code: result.success.code }),
      observedAt,
    };
  });

const activateHostOps = (
  ssh: SshTransportShape,
  target: SshTarget,
  activate: (
    ssh: SshTransportShape,
    prepared: RemoteDeploymentTarget,
  ) => Effect.Effect<DeployRemoteResult>,
  platform: RemotePlatformDescriptor,
): Effect.Effect<HostOpsActivate> =>
  Effect.gen(function* () {
    const observedAt = new Date().toISOString();
    const result = yield* activate(ssh, {
      host: hostRecordFromTarget(target),
      endpoint: inspectSshTarget(target).endpoint,
      sshTarget: target,
      platform,
      progress: [],
    });
    return {
      ok: result.ok,
      detail: result.detail,
      stages: [...result.stages],
      ...(result.disposition === undefined
        ? {}
        : { disposition: result.disposition }),
      ...(result.code === undefined ? {} : { code: result.code }),
      observedAt,
    };
  });

export class HostTarget extends Context.Service<
  HostTarget,
  {
    readonly sshTarget: SshTarget;
    /** Registered host id; attributes deploy-job stages and copy progress. */
    readonly hostId?: string;
  }
>()("@junto/HostTarget") {
  static readonly layer = (
    sshTarget: SshTarget,
    hostId?: string,
  ): Layer.Layer<HostTarget> =>
    Layer.succeed(
      HostTarget,
      HostTarget.of({
        sshTarget,
        ...(hostId === undefined ? {} : { hostId }),
      }),
    );
}

export class HostConfigure extends Context.Service<
  HostConfigure,
  ConfigureRemoteOptions
>()("@junto/HostConfigure") {
  static readonly layer = (
    options: ConfigureRemoteOptions,
  ): Layer.Layer<HostConfigure> =>
    Layer.succeed(HostConfigure, HostConfigure.of(options));

  static readonly layerUnset: Layer.Layer<HostConfigure> =
    Layer.succeed(HostConfigure, HostConfigure.of(UNSET_HOST_CONFIGURE));
}

export class HostOps extends Context.Service<
  HostOps,
  {
    readonly inspect: () => Effect.Effect<HostOpsInspect>;
    readonly copy: (
      expectedPackageState?: "absent" | "present",
    ) => Effect.Effect<HostOpsCopy>;
    readonly cleanup: () => Effect.Effect<HostOpsCleanup>;
    readonly configure: () => Effect.Effect<HostOpsConfigure>;
    readonly activate: () => Effect.Effect<HostOpsActivate>;
    readonly attach: () => Effect.Effect<HostOpsAttach>;
  }
>()("@junto/HostOps") {
  static readonly layerDarwinOps: Layer.Layer<
    HostOps,
    never,
    SshTransport | HostTarget | HostConfigure
  > = Layer.effect(
    HostOps,
    Effect.gen(function* () {
      const ssh = yield* SshTransport;
      const host = yield* HostTarget;
      const facts = yield* HostConfigure;
      const darwin = yield* Effect.promise(() => import("./host-ops-darwin"));
      const deploy = yield* Effect.promise(() => import("./deploy-darwin"));
      return HostOps.of({
        inspect: () => darwin.inspectDarwinHost(ssh, host.sshTarget),
        copy: (expectedPackageState) =>
          darwin.copyDarwinHost(
            ssh,
            host.sshTarget,
            expectedPackageState,
            host.hostId,
          ),
        cleanup: () => darwin.cleanupDarwinHost(ssh, host.sshTarget),
        configure: () => configureHostOps(ssh, host.sshTarget, facts),
        activate: () =>
          activateHostOps(
            ssh,
            host.sshTarget,
            deploy.activateDarwinRemoteRuntimeForTarget,
            { platform: "darwin", kernelName: "Darwin" },
          ),
        attach: () => darwin.attachDarwinHost(ssh, host.sshTarget),
      });
    }),
  );

  static readonly layerLinuxOps: Layer.Layer<
    HostOps,
    never,
    SshTransport | HostTarget | HostConfigure
  > = Layer.effect(
    HostOps,
    Effect.gen(function* () {
      const ssh = yield* SshTransport;
      const host = yield* HostTarget;
      const facts = yield* HostConfigure;
      const linux = yield* Effect.promise(() => import("./host-ops-linux"));
      const deploy = yield* Effect.promise(() => import("./deploy-linux"));
      return HostOps.of({
        inspect: () => linux.inspectLinuxHost(ssh, host.sshTarget),
        copy: (expectedPackageState) =>
          linux.copyLinuxHost(ssh, host.sshTarget, expectedPackageState),
        cleanup: () => linux.cleanupLinuxHost(ssh, host.sshTarget),
        configure: () => configureHostOps(ssh, host.sshTarget, facts),
        activate: () =>
          activateHostOps(
            ssh,
            host.sshTarget,
            deploy.activateLinuxRemoteRuntimeForTarget,
            { platform: "linux", kernelName: "Linux" },
          ),
        attach: () => linux.attachLinuxHost(ssh, host.sshTarget),
      });
    }),
  );

  static readonly layerDarwin: Layer.Layer<
    HostOps,
    never,
    SshTransport | HostTarget
  > = HostOps.layerDarwinOps.pipe(
    Layer.provide(HostConfigure.layerUnset),
  );

  static readonly layerLinux: Layer.Layer<
    HostOps,
    never,
    SshTransport | HostTarget
  > = HostOps.layerLinuxOps.pipe(
    Layer.provide(HostConfigure.layerUnset),
  );

  static readonly layerForTarget = (
    target: SshTarget,
    hostId?: string,
  ): Layer.Layer<
    HostOps | HostTarget,
    SshError | RemotePlatformProbeError,
    SshTransport | HostConfigure
  > =>
    Layer.unwrap(
      Effect.gen(function* () {
        const ssh = yield* SshTransport;
        const platform = yield* resolveRemotePackagedPlatform(ssh, target);
        return inspectRemotePackagedPlatform(platform) === "darwin"
          ? HostOps.layerDarwinOps
          : HostOps.layerLinuxOps;
      }),
    ).pipe(Layer.provideMerge(HostTarget.layer(target, hostId)));
}
