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
import type { SshError, SshTarget } from "../ssh/domain";
import {
  inspectRemotePackagedPlatform,
  RemotePlatformProbeError,
  resolveRemotePackagedPlatform,
} from "../ssh/read-commands";
import { SshTransport } from "../ssh/service";
import type { ConfigureRemoteOptions } from "./configure-remote";
import {
  activateDarwinHost,
  attachDarwinHost,
  cleanupDarwinHost,
  configureDarwinHost,
  copyDarwinHost,
  inspectDarwinHost,
} from "./host-ops-darwin";
import {
  activateLinuxHost,
  attachLinuxHost,
  cleanupLinuxHost,
  configureLinuxHost,
  copyLinuxHost,
  inspectLinuxHost,
} from "./host-ops-linux";

const decodeInstallationId = Schema.decodeUnknownSync(InstallationId);

/** Placeholder pair facts so inspect / copy / cleanup layers stay target-only. */
const UNSET_HOST_CONFIGURE: ConfigureRemoteOptions = {
  commandCenterInstallationId: decodeInstallationId("unset"),
  appVersion: "0.0.0",
};

export class HostTarget extends Context.Service<
  HostTarget,
  { readonly sshTarget: SshTarget }
>()("@vellum/HostTarget") {
  static readonly layer = (
    sshTarget: SshTarget,
  ): Layer.Layer<HostTarget> =>
    Layer.succeed(HostTarget, HostTarget.of({ sshTarget }));
}

export class HostConfigure extends Context.Service<
  HostConfigure,
  ConfigureRemoteOptions
>()("@vellum/HostConfigure") {
  static readonly layer = (
    options: ConfigureRemoteOptions,
  ): Layer.Layer<HostConfigure> =>
    Layer.succeed(HostConfigure, HostConfigure.of(options));
}

export class HostOps extends Context.Service<
  HostOps,
  {
    readonly inspect: () => Effect.Effect<HostOpsInspect>;
    readonly copy: () => Effect.Effect<HostOpsCopy>;
    readonly cleanup: () => Effect.Effect<HostOpsCleanup>;
    readonly configure: () => Effect.Effect<HostOpsConfigure>;
    readonly activate: () => Effect.Effect<HostOpsActivate>;
    readonly attach: () => Effect.Effect<HostOpsAttach>;
  }
>()("@vellum/HostOps") {
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
      return HostOps.of({
        inspect: () => inspectDarwinHost(ssh, host.sshTarget),
        copy: () => copyDarwinHost(ssh, host.sshTarget),
        cleanup: () => cleanupDarwinHost(ssh, host.sshTarget),
        configure: () => configureDarwinHost(ssh, host.sshTarget, facts),
        activate: () => activateDarwinHost(ssh, host.sshTarget),
        attach: () => attachDarwinHost(ssh, host.sshTarget),
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
      return HostOps.of({
        inspect: () => inspectLinuxHost(ssh, host.sshTarget),
        copy: () => copyLinuxHost(ssh, host.sshTarget),
        cleanup: () => cleanupLinuxHost(ssh, host.sshTarget),
        configure: () => configureLinuxHost(ssh, host.sshTarget, facts),
        activate: () => activateLinuxHost(ssh, host.sshTarget),
        attach: () => attachLinuxHost(ssh, host.sshTarget),
      });
    }),
  );

  static readonly layerDarwin: Layer.Layer<
    HostOps,
    never,
    SshTransport | HostTarget
  > = HostOps.layerDarwinOps.pipe(
    Layer.provide(HostConfigure.layer(UNSET_HOST_CONFIGURE)),
  );

  static readonly layerLinux: Layer.Layer<
    HostOps,
    never,
    SshTransport | HostTarget
  > = HostOps.layerLinuxOps.pipe(
    Layer.provide(HostConfigure.layer(UNSET_HOST_CONFIGURE)),
  );

  static readonly layerForTarget = (
    target: SshTarget,
    configure: ConfigureRemoteOptions = UNSET_HOST_CONFIGURE,
  ): Layer.Layer<
    HostOps | HostTarget,
    SshError | RemotePlatformProbeError,
    SshTransport
  > =>
    Layer.unwrap(
      Effect.gen(function* () {
        const ssh = yield* SshTransport;
        const platform = yield* resolveRemotePackagedPlatform(ssh, target);
        return inspectRemotePackagedPlatform(platform) === "darwin"
          ? HostOps.layerDarwinOps
          : HostOps.layerLinuxOps;
      }),
    ).pipe(
      Layer.provideMerge(HostTarget.layer(target)),
      Layer.provide(HostConfigure.layer(configure)),
    );
}
