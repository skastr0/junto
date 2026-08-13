/**
 * Platform adapter behind HostRuntime. Darwin and Linux implement this.
 * The coordinator never imports these modules.
 */
import { createConnection } from "node:net";
import { Effect } from "effect";
import type {
  HostProcess,
  HostRuntimeGap,
  HostRuntimeObservation,
  HostRuntimePlatform,
  HostWorkAttach,
} from "@shared/host-runtime";
import type { RemoteHost } from "@shared/remote-hosts";
import type { InstallationId } from "@shared/installation-id";
import { parseRemoteUnixSocketPath, SshExitError, type SshTarget } from "../ssh/domain";
import { oneShot, unixForward } from "../ssh/program";
import { remoteTestSocketExists } from "../ssh/read-commands";
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

/** Door/process plane: exit 1 is down. Any other failure stays unknown. */
export const probeRemoteDoorSocket = (
  ssh: SshTransportShape,
  target: SshTarget,
  path: string,
): Effect.Effect<HostProcess> =>
  remoteTestSocketExists(path).pipe(
    Effect.flatMap((command) =>
      ssh.run(oneShot(target, command, { budget: "short" })),
    ),
    Effect.map(() => "up" as const),
    Effect.catch((error) =>
      error instanceof SshExitError && error.code === 1
        ? Effect.succeed("down" as const)
        : Effect.succeed("unknown" as const),
    ),
  );

export const combineHostProcessPlanes = (
  enroll: HostProcess,
  peer: HostProcess,
): HostProcess =>
  enroll === "up" || peer === "up"
    ? "up"
    : enroll === "down" && peer === "down"
      ? "down"
      : "unknown";

/** Work attach is a real connect through SSH forward. Sock-on-disk is not Ready. */
export const probeRemoteWorkAttach = (
  ssh: SshTransportShape,
  target: SshTarget,
  remoteSocketPath: string,
): Effect.Effect<HostWorkAttach> =>
  Effect.scoped(
    Effect.gen(function* () {
      const parsed = yield* parseRemoteUnixSocketPath(remoteSocketPath).pipe(
        Effect.result,
      );
      if (parsed._tag === "Failure") return "unknown";
      const lease = yield* ssh
        .forward(unixForward(target, parsed.success))
        .pipe(Effect.result);
      if (lease._tag === "Failure") return "unknown";
      return yield* Effect.tryPromise({
        try: () =>
          new Promise<HostWorkAttach>((resolve) => {
            const sock = createConnection({
              path: String(lease.success.localSocket),
            });
            const done = (state: HostWorkAttach) => {
              sock.removeAllListeners();
              sock.destroy();
              resolve(state);
            };
            sock.setTimeout(2_000);
            sock.once("connect", () => done("up"));
            sock.once("error", () => done("down"));
            sock.once("timeout", () => done("down"));
          }),
        catch: () => new Error("work attach connect failed"),
      }).pipe(Effect.orElseSucceed(() => "unknown" as const));
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
