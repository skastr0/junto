/**
 * Platform adapter behind HostRuntime. Darwin and Linux implement this.
 * The coordinator never imports these modules.
 */
import { createConnection, type Socket } from "node:net";
import { Effect } from "effect";
import type {
  HostProcess,
  HostRuntimeBlocker,
  HostRuntimeGap,
  HostRuntimeObservation,
  HostRuntimePlatform,
  HostWorkAttach,
} from "@shared/host-runtime";
import {
  decodeWorkResponse,
  encodeWorkFrame,
} from "@shared/work-control";
import type { RemoteHost } from "@shared/remote-hosts";
import type { InstallationId } from "@shared/installation-id";
import { parseRemoteUnixSocketPath, SshExitError, type SshTarget } from "../ssh/domain";
import { oneShot, unixForward } from "../ssh/program";
import { remoteCat, remoteTestSocketExists } from "../ssh/read-commands";
import type { SshTransportShape } from "../ssh/service";
import type { ConfigureRemoteOptions } from "./configure-remote";
import {
  failedPackageResult,
  type ConfiguredRemoteDeployResult,
} from "./deploy-configured-remote";
import type { LinuxReleaseCacheSource } from "./linux-release-feed";

/** Copy, restart, wait — while SSH answers. Hard blockers stop the loop. */
export const HOST_RUNTIME_REMEDY_ROUNDS = 3;

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

export const readRemoteTextFile = (
  ssh: SshTransportShape,
  target: SshTarget,
  path: string,
): Effect.Effect<string | undefined> =>
  Effect.gen(function* () {
    const cmd = yield* remoteCat(path).pipe(Effect.result);
    if (cmd._tag === "Failure") return undefined;
    const result = yield* ssh
      .run(oneShot(target, cmd.success, { budget: "short" }))
      .pipe(Effect.result);
    if (result._tag === "Failure") return undefined;
    const text = result.success.stdout.trim();
    return text.length === 0 ? undefined : text;
  });

/** Forward a remote UDS. Forward failure is unknown, not down. */
export const withRemoteUnixForward = (
  ssh: SshTransportShape,
  target: SshTarget,
  remoteSocketPath: string,
  body: (localSocket: string) => Effect.Effect<HostWorkAttach>,
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
      return yield* body(String(lease.success.localSocket));
    }),
  );

/**
 * Linux work attach: NDJSON ping through the forwarded work socket.
 * A well-formed envelope (ok or AuthError) means the daemon answered.
 * Process-bind cannot succeed from Command Center; sock-on-disk is not Ready.
 */
export const handshakeLinuxWorkControl = (
  socketPath: string,
  token: string,
  timeoutMs = 2_000,
): Promise<HostWorkAttach> =>
  new Promise((resolve) => {
    let settled = false;
    let buffer = Buffer.alloc(0);
    let sock: Socket | undefined;
    const done = (state: HostWorkAttach) => {
      if (settled) return;
      settled = true;
      try {
        sock?.destroy();
      } catch {
        // Probe must not leak the forwarded socket.
      }
      resolve(state);
    };
    const timer = setTimeout(() => done("down"), timeoutMs);
    try {
      sock = createConnection({ path: socketPath });
    } catch {
      clearTimeout(timer);
      resolve("down");
      return;
    }
    sock.on("connect", () => {
      sock?.write(encodeWorkFrame({ token, op: "ping" }));
    });
    sock.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const nl = buffer.indexOf(0x0a);
      if (nl < 0) return;
      clearTimeout(timer);
      const line = buffer
        .subarray(0, nl)
        .toString("utf8")
        .replace(/\r$/u, "")
        .trim();
      try {
        const decoded = decodeWorkResponse(JSON.parse(line) as unknown);
        done(decoded._tag === "Success" ? "up" : "unknown");
      } catch {
        done("unknown");
      }
    });
    sock.on("error", () => {
      clearTimeout(timer);
      done("down");
    });
    sock.on("timeout", () => {
      clearTimeout(timer);
      done("down");
    });
  });

export const hostRuntimeBlockedDeploy = (
  host: RemoteHost,
  deployed: Parameters<typeof failedPackageResult>[1],
  blocker: HostRuntimeBlocker,
): ConfiguredRemoteDeployResult => ({
  ...failedPackageResult(host, deployed),
  detail: blocker.detail,
  message: blocker.detail,
  code: blocker.kind === "auth" ? "auth_required" : "conflict",
});

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
