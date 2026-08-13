/**
 * Host-ops — Effect v4 inversion of control.
 *
 * Contract: HostOps. Programs call inspect() and never name an OS or a target.
 * Target is HostTarget. Darwin/Linux are layers. Layer.unwrap loads one after
 * the packaged-platform probe — the same shape as seats (local/remote) and
 * PTY observers (harness implementations).
 */
import { Context, Effect, Layer } from "effect";
import type { HostOpsCleanup, HostOpsCopy, HostOpsInspect } from "@shared/host-ops";
import type { SshError, SshTarget } from "../ssh/domain";
import {
  inspectRemotePackagedPlatform,
  RemotePlatformProbeError,
  resolveRemotePackagedPlatform,
} from "../ssh/read-commands";
import { SshTransport } from "../ssh/service";
import {
  cleanupDarwinHost,
  copyDarwinHost,
  inspectDarwinHost,
} from "./host-ops-darwin";
import {
  cleanupLinuxHost,
  copyLinuxHost,
  inspectLinuxHost,
} from "./host-ops-linux";

export class HostTarget extends Context.Service<
  HostTarget,
  { readonly sshTarget: SshTarget }
>()("@vellum/HostTarget") {
  static readonly layer = (
    sshTarget: SshTarget,
  ): Layer.Layer<HostTarget> =>
    Layer.succeed(HostTarget, HostTarget.of({ sshTarget }));
}

export class HostOps extends Context.Service<
  HostOps,
  {
    readonly inspect: () => Effect.Effect<HostOpsInspect>;
    readonly copy: () => Effect.Effect<HostOpsCopy>;
    readonly cleanup: () => Effect.Effect<HostOpsCleanup>;
  }
>()("@vellum/HostOps") {
  static readonly layerDarwin: Layer.Layer<
    HostOps,
    never,
    SshTransport | HostTarget
  > = Layer.effect(
    HostOps,
    Effect.gen(function* () {
      const ssh = yield* SshTransport;
      const host = yield* HostTarget;
      return HostOps.of({
        inspect: () => inspectDarwinHost(ssh, host.sshTarget),
        copy: () => copyDarwinHost(ssh, host.sshTarget),
        cleanup: () => cleanupDarwinHost(ssh, host.sshTarget),
      });
    }),
  );

  static readonly layerLinux: Layer.Layer<
    HostOps,
    never,
    SshTransport | HostTarget
  > = Layer.effect(
    HostOps,
    Effect.gen(function* () {
      const ssh = yield* SshTransport;
      const host = yield* HostTarget;
      return HostOps.of({
        inspect: () => inspectLinuxHost(ssh, host.sshTarget),
        copy: () => copyLinuxHost(ssh, host.sshTarget),
        cleanup: () => cleanupLinuxHost(ssh, host.sshTarget),
      });
    }),
  );

  static readonly layerForTarget = (
    target: SshTarget,
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
          ? HostOps.layerDarwin
          : HostOps.layerLinux;
      }),
    ).pipe(Layer.provideMerge(HostTarget.layer(target)));
}