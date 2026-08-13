/**
 * Platform adapter behind HostRuntime. Darwin and Linux implement this.
 * The coordinator never imports these modules.
 */
import { createConnection } from "node:net";
import { Effect } from "effect";
import type {
  HostRuntimeGap,
  HostRuntimeObservation,
  HostRuntimePlatform,
} from "@shared/host-runtime";
import type { RemoteHost } from "@shared/remote-hosts";
import type { InstallationId } from "@shared/installation-id";
import { parseRemoteUnixSocketPath, type SshTarget } from "../ssh/domain";
import { unixForward } from "../ssh/program";
import type { SshTransportShape } from "../ssh/service";
import type { ConfigureRemoteOptions } from "./configure-remote";
import type { ConfiguredRemoteDeployResult } from "./deploy-configured-remote";
import type { LinuxReleaseCacheSource } from "./linux-release-feed";

export type HostRuntimePlanes = Pick<
  HostRuntimeObservation,
  "package" | "process" | "workAttach"
>;

export type HostRuntimeApplyContext = {
  readonly ssh: SshTransportShape;
  readonly host: RemoteHost;
  readonly gap: HostRuntimeGap;
  readonly priorInstallationId?: InstallationId;
  readonly configure: ConfigureRemoteOptions;
  readonly artifactSource?: LinuxReleaseCacheSource;
};

/** Work attach is a real connect through SSH forward. Sock-on-disk is not Ready. */
export const probeRemoteWorkAttach = (
  ssh: SshTransportShape,
  target: SshTarget,
  remoteSocketPath: string,
): Effect.Effect<boolean> =>
  Effect.scoped(
    Effect.gen(function* () {
      const parsed = yield* parseRemoteUnixSocketPath(remoteSocketPath).pipe(
        Effect.result,
      );
      if (parsed._tag === "Failure") return false;
      const lease = yield* ssh
        .forward(unixForward(target, parsed.success))
        .pipe(Effect.result);
      if (lease._tag === "Failure") return false;
      return yield* Effect.tryPromise({
        try: () =>
          new Promise<boolean>((resolve) => {
            const sock = createConnection({
              path: String(lease.success.localSocket),
            });
            const done = (ok: boolean) => {
              sock.removeAllListeners();
              sock.destroy();
              resolve(ok);
            };
            sock.setTimeout(2_000);
            sock.once("connect", () => done(true));
            sock.once("error", () => done(false));
            sock.once("timeout", () => done(false));
          }),
        catch: () => new Error("work attach connect failed"),
      }).pipe(Effect.orElseSucceed(() => false));
    }),
  );

export type HostRuntimePlatformAdapter = {
  readonly platform: Exclude<HostRuntimePlatform, "unknown">;
  readonly observePlanes: (
    ssh: SshTransportShape,
    target: SshTarget,
    home: string,
  ) => Effect.Effect<HostRuntimePlanes>;
  readonly apply: (
    context: HostRuntimeApplyContext,
  ) => Effect.Effect<ConfiguredRemoteDeployResult>;
};
