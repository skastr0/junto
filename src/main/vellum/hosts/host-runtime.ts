/**
 * HostRuntime — one Effect service for Command Center and Remote.
 *
 * Placement and platform select adapters. Deploy is reconcile:
 * observe → decideHostRuntimeGap → platform.apply. The coordinator
 * does not call deployConfiguredRemote.
 */
import { Context, Effect, Layer } from "effect";
import {
  classifyHostRuntimeBlocker,
  decideHostRuntimeGap,
  hostRuntimeGapCopy,
  type HostRuntimeGap,
  type HostRuntimeIntent,
  type HostRuntimeObservation,
  type HostRuntimePlatform,
} from "@shared/host-runtime";
import type { InstallationId } from "@shared/installation-id";
import { RemoteHostsError, type RemoteHost } from "@shared/remote-hosts";
import { parseHostSshRoute } from "../ssh/domain";
import { formatSshFailure } from "../ssh/format";
import { homeDirectoryLookup, oneShot } from "../ssh/program";
import { remoteUname } from "../ssh/read-commands";
import { SshTransport, type SshTransportShape } from "../ssh/service";
import { StationFleetTargetRepository } from "../station/fleet-target-repository";
import type { ConfigureRemoteOptions } from "./configure-remote";
import type { ConfiguredRemoteDeployResult } from "./deploy-configured-remote";
import { darwinHostRuntimePlatform } from "./host-runtime-darwin";
import { linuxHostRuntimePlatform } from "./host-runtime-linux";
import type { HostRuntimeApplyContext } from "./host-runtime-platform";
import type { LinuxReleaseCacheSource } from "./linux-release-feed";
import { decodeRemoteHomeDirectoryOutput } from "./remote-home";
import { HostsService } from "./service";

type Ssh = SshTransportShape;

export type HostRuntimeReconcileInput = {
  readonly intent: HostRuntimeIntent;
  readonly configure: ConfigureRemoteOptions;
  readonly artifactSource?: LinuxReleaseCacheSource;
  readonly onCompleted?: (
    host: RemoteHost,
    result: ConfiguredRemoteDeployResult,
  ) => Effect.Effect<void, RemoteHostsError>;
};

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

const adapterFor = (platform: "darwin" | "linux") =>
  platform === "darwin" ? darwinHostRuntimePlatform : linuxHostRuntimePlatform;

const refused = (
  host: RemoteHost,
  detail: string,
  code: NonNullable<ConfiguredRemoteDeployResult["code"]>,
): ConfiguredRemoteDeployResult => ({
  ok: false,
  detail,
  code,
  message: detail,
  stages: [],
  disposition: "not-started",
  outcome: "failed",
  packageState: "previous",
  role: "previous",
  configuration: { ok: false, detail },
});

export class HostRuntime extends Context.Service<
  HostRuntime,
  {
    readonly observe: (
      hostId: string,
    ) => Effect.Effect<HostRuntimeObservation>;
    readonly reconcile: (
      hostId: string,
      input: HostRuntimeReconcileInput,
    ) => Effect.Effect<ConfiguredRemoteDeployResult>;
  }
>()("@vellum/HostRuntime") {}

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
      return {
        ...base,
        blocker: {
          kind: "unsupported",
          detail: parsed.failure.message,
        },
      };
    }
    const unameCmd = yield* remoteUname().pipe(Effect.result);
    if (unameCmd._tag === "Failure") {
      return { ...base, network: "unknown" };
    }
    const uname = yield* ssh
      .run(oneShot(parsed.success, unameCmd.success, { budget: "short" }))
      .pipe(Effect.result);
    if (uname._tag === "Failure") {
      const blocker = classifyHostRuntimeBlocker(
        formatSshFailure(uname.failure),
      );
      return {
        ...base,
        network: "unknown",
        ...(blocker === undefined ? {} : { blocker }),
      };
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
        : yield* adapterFor(platform).observePlanes(
            ssh,
            parsed.success,
            home,
          );

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

/** Check-intent: Ready only after a real connect on a configured station. */
export const checkHostRuntime = (
  observation: HostRuntimeObservation,
): ConfiguredRemoteDeployResult => {
  const gap = decideHostRuntimeGap(observation, "check");
  const detail = hostRuntimeGapCopy(gap, observation.blocker);
  return {
    ok: gap === "ready",
    detail,
    message: detail,
    stages: [detail],
    disposition: gap === "ready" ? ("ready" as const) : ("not-started" as const),
    outcome: gap === "ready" ? ("ready" as const) : ("failed" as const),
    packageState:
      observation.package === "present"
        ? ("present" as const)
        : ("unknown" as const),
    role:
      observation.mode === "remote"
        ? ("remote" as const)
        : ("unknown" as const),
    configuration: { ok: gap === "ready", detail },
  };
};

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

    const reconcile = (hostId: string, input: HostRuntimeReconcileInput) =>
      Effect.gen(function* () {
        const host = yield* hosts.get(hostId).pipe(Effect.result);
        if (host._tag === "Failure" || host.success === undefined) {
          return refused(
            {
              id: hostId,
              label: hostId,
              kind: "remote",
              capabilities: [],
            } as RemoteHost,
            `unknown host: ${hostId}`,
            "not_found",
          );
        }
        if (host.success.kind === "local") {
          return refused(
            host.success,
            "Deploy is for a remote machine, not this one.",
            "validation",
          );
        }

        const observation = yield* observe(hostId);
        if (input.intent === "check") {
          return checkHostRuntime(observation);
        }
        const gap = decideHostRuntimeGap(observation, input.intent);
        if (gap === "needOperator") {
          return refused(
            host.success,
            hostRuntimeGapCopy(gap, observation.blocker),
            observation.blocker?.kind === "auth" ? "auth_required" : "conflict",
          );
        }
        if (gap === "stillTrying") {
          return refused(
            host.success,
            observation.network === "down"
              ? `Can't reach ${host.success.label} on the network.`
              : hostRuntimeGapCopy(gap, observation.blocker),
            "io",
          );
        }

        const platform = observation.platform;
        if (platform === "unknown") {
          return refused(
            host.success,
            hostRuntimeGapCopy("needOperator", observation.blocker),
            "validation",
          );
        }

        const context: HostRuntimeApplyContext = {
          ssh,
          host: host.success,
          gap,
          configure: input.configure,
          ...(observation.priorInstallationId === undefined
            ? {}
            : {
                priorInstallationId:
                  observation.priorInstallationId as InstallationId,
              }),
          ...(input.artifactSource === undefined
            ? {}
            : { artifactSource: input.artifactSource }),
        };
        const applied = yield* adapterFor(platform).apply(context);
        if (input.onCompleted === undefined) return applied;
        return yield* input.onCompleted(host.success, applied).pipe(
          Effect.map(() => ({ ...applied, statusRecorded: true })),
          Effect.catch((error: RemoteHostsError) =>
            Effect.succeed({
              ...applied,
              statusRecorded: false,
              detail: `${applied.detail} - local deployment receipt could not be persisted: ${error.message}`,
            }),
          ),
        );
      });

    return HostRuntime.of({ observe, reconcile });
  }),
);

export const hostRuntimeGapDetail = (
  gap: HostRuntimeGap,
  observation: HostRuntimeObservation,
): string => hostRuntimeGapCopy(gap, observation.blocker);

export type { ConfiguredRemoteDeployResult };
