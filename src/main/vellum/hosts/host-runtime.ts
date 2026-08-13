/**
 * HostRuntime — one Effect service. Local and Remote, Darwin and Linux,
 * implement observe. Reconcile is shared: observe → gap → act.
 *
 * Act is existing deployConfiguredRemoteHost with the right prior installation
 * id. First install configures. Update never re-enters enroll.
 */
import { Context, Effect, Layer } from "effect";
import { join } from "node:path";
import {
  decideHostRuntimeGap,
  hostRuntimeGapCopy,
  type HostRuntimeGap,
  type HostRuntimeIntent,
  type HostRuntimeObservation,
  type HostRuntimePlatform,
} from "@shared/host-runtime";
import type { RemoteHost } from "@shared/remote-hosts";
import { stationControlDir, stationDoorSocketPath } from "@shared/station-ssh-control";
import { TERM_REMOTE_SOCK_REL } from "@shared/term-control";
import { workControlDir, workControlSocketPath } from "@shared/work-control";
import {
  SshExitError,
  parseHostSshRoute,
  type SshTarget,
} from "../ssh/domain";
import { homeDirectoryLookup, oneShot } from "../ssh/program";
import {
  remoteDarwinPackageExists,
  remoteTestSocketExists,
  remoteUname,
} from "../ssh/read-commands";
import { SshTransport, type SshTransportShape } from "../ssh/service";
import { StationFleetTargetRepository } from "../station/fleet-target-repository";
import type { ConfiguredRemoteDeployResult } from "./deploy-configured-remote";
import { HostsService } from "./service";
import { decodeRemoteHomeDirectoryOutput } from "./remote-home";

type Ssh = SshTransportShape;

export type HostRuntimeReconcile = {
  readonly observation: HostRuntimeObservation;
  readonly gap: HostRuntimeGap;
  readonly priorInstallationId?: string;
};

export class HostRuntime extends Context.Service<
  HostRuntime,
  {
    readonly observe: (
      hostId: string,
    ) => Effect.Effect<HostRuntimeObservation>;
    readonly plan: (
      hostId: string,
      intent: HostRuntimeIntent,
    ) => Effect.Effect<HostRuntimeReconcile>;
  }
>()("@vellum/HostRuntime") {}

const unknownObservation = (
  hostId: string,
  placement: HostRuntimeObservation["placement"],
): HostRuntimeObservation => ({
  hostId,
  placement,
  platform: "unknown",
  network: "unknown",
  package: "unknown",
  process: "unknown",
  workAttach: "unknown",
  mode: "unenrolled",
});

const platformFromUname = (stdout: string): HostRuntimePlatform => {
  if (stdout === "Darwin\n") return "darwin";
  if (stdout === "Linux\n") return "linux";
  return "unknown";
};

const probeSocket = (
  ssh: Ssh,
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

const observeDarwin = (
  ssh: Ssh,
  target: SshTarget,
  home: string,
): Effect.Effect<
  Pick<HostRuntimeObservation, "package" | "process" | "workAttach">
> =>
  Effect.gen(function* () {
    const installedCmd = yield* remoteDarwinPackageExists().pipe(Effect.result);
    let pkg: HostRuntimeObservation["package"] = "unknown";
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
    const termUp = yield* probeSocket(
      ssh,
      target,
      join(home, TERM_REMOTE_SOCK_REL),
    );

    return {
      package: pkg,
      // Control plane answering — not a term sock, not a banner.
      process: enrollUp || peerUp ? ("up" as const) : ("down" as const),
      // Term sock is an observation, not Ready. Check intent requires workAttach up.
      workAttach: termUp ? ("up" as const) : ("down" as const),
    };
  });

const observeLinux = (
  ssh: Ssh,
  target: SshTarget,
  home: string,
): Effect.Effect<
  Pick<HostRuntimeObservation, "package" | "process" | "workAttach">
> =>
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
    const workUp = yield* probeSocket(
      ssh,
      target,
      workControlSocketPath(workControlDir(home)),
    );
    return {
      // Linux package presence is the userland payload, not a Darwin .app.
      package: "unknown" as const,
      process: enrollUp || peerUp ? ("up" as const) : ("down" as const),
      workAttach: workUp ? ("up" as const) : ("down" as const),
    };
  });

export const observeRemoteHost = (
  ssh: Ssh,
  host: RemoteHost,
  input: {
    readonly mode: HostRuntimeObservation["mode"];
    readonly priorInstallationId?: string;
  },
): Effect.Effect<HostRuntimeObservation> =>
  Effect.gen(function* () {
    const base = unknownObservation(host.id, "remote");
    if (host.kind !== "remote" || !host.sshEndpoint) {
      return {
        ...base,
        blocker: {
          kind: "unsupported",
          detail: `${host.label} has no SSH address. Enroll it with an address you can reach.`,
        },
      };
    }
    const parsed = yield* parseHostSshRoute(host).pipe(Effect.result);
    if (parsed._tag === "Failure") {
      return { ...base, network: "down" };
    }
    const unameCmd = yield* remoteUname().pipe(Effect.result);
    if (unameCmd._tag === "Failure") {
      return { ...base, network: "unknown" };
    }
    const uname = yield* ssh
      .run(oneShot(parsed.success, unameCmd.success, { budget: "short" }))
      .pipe(Effect.result);
    if (uname._tag === "Failure") {
      return { ...base, network: "down" };
    }
    const platform = platformFromUname(uname.success.stdout);
    if (platform === "unknown") {
      return {
        ...base,
        network: "up",
        platform,
        mode: input.mode,
        ...(input.priorInstallationId === undefined
          ? {}
          : { priorInstallationId: input.priorInstallationId }),
        blocker: {
          kind: "unsupported",
          detail: `${host.label} is not macOS or Linux. Vellum Command cannot deploy there.`,
        },
      };
    }

    const homeResult = yield* ssh
      .run(homeDirectoryLookup(parsed.success))
      .pipe(Effect.result);
    const home =
      homeResult._tag === "Success"
        ? decodeRemoteHomeDirectoryOutput(homeResult.success.stdout)
        : null;

    const planes =
      home === null
        ? {
            package: "unknown" as const,
            process: "unknown" as const,
            workAttach: "unknown" as const,
          }
        : platform === "darwin"
          ? yield* observeDarwin(ssh, parsed.success, home)
          : yield* observeLinux(ssh, parsed.success, home);

    return {
      hostId: host.id,
      placement: "remote",
      platform,
      network: "up",
      ...planes,
      mode: input.mode,
      ...(input.priorInstallationId === undefined
        ? {}
        : { priorInstallationId: input.priorInstallationId }),
    };
  });

export const HostRuntimeLive = Layer.effect(
  HostRuntime,
  Effect.gen(function* () {
    const hosts = yield* HostsService;
    const ssh = yield* SshTransport;
    const fleetTargets = yield* StationFleetTargetRepository;

    const observe = (hostId: string) =>
      Effect.gen(function* () {
        const host = yield* hosts.get(hostId).pipe(Effect.result);
        if (host._tag === "Failure" || host.success === undefined) {
          return unknownObservation(hostId, "remote");
        }
        if (host.success.kind === "local") {
          return {
            ...unknownObservation(hostId, "local"),
            platform:
              process.platform === "darwin"
                ? ("darwin" as const)
                : process.platform === "linux"
                  ? ("linux" as const)
                  : ("unknown" as const),
            network: "up" as const,
            mode: "command-center" as const,
          };
        }
        const prior = yield* fleetTargets.get(host.success.id).pipe(Effect.result);
        const priorInstallationId =
          prior._tag === "Success"
            ? prior.success?.stationInstallationId
            : undefined;
        return yield* observeRemoteHost(ssh, host.success, {
          mode: priorInstallationId === undefined ? "unenrolled" : "remote",
          ...(priorInstallationId === undefined
            ? {}
            : { priorInstallationId }),
        });
      });

    const plan = (hostId: string, intent: HostRuntimeIntent) =>
      Effect.gen(function* () {
        const observation = yield* observe(hostId);
        return {
          observation,
          gap: decideHostRuntimeGap(observation, intent),
          ...(observation.priorInstallationId === undefined
            ? {}
            : { priorInstallationId: observation.priorInstallationId }),
        };
      });

    return HostRuntime.of({ observe, plan });
  }),
);

export const priorInstallationForDeploy = (
  plan: HostRuntimeReconcile,
): string | undefined =>
  plan.gap === "needRestart" ? plan.priorInstallationId : undefined;

export const hostRuntimePlanDetail = (plan: HostRuntimeReconcile): string =>
  hostRuntimeGapCopy(plan.gap, plan.observation.blocker);

export type { ConfiguredRemoteDeployResult };
