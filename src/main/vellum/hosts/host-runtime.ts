/**
 * HostRuntime — WHEN. HostOps — HOW.
 *
 * Deploy is reconcile: observe → decideHostRuntimeGap → admit → apply.
 * Observe loads HostOps.layerForTarget, calls inspect, then attach when
 * workAttach stayed unknown. Ready is that connect, not a sock and not SSH-up.
 * Apply is one loop: cleanup, copy, configure (first install), activate, attach.
 * Reconcile is the only deployment path; HostsService has no deploy verb.
 */
import { Context, Effect, Layer, Option } from "effect";
import { HOST_RUNTIME_REMEDY_STAGE } from "@shared/deploy-job";
import { releaseAllowsTargetPlatform } from "@shared/deploy-capabilities";
import type {
  HostOpsConfigure,
  HostOpsCopy,
  HostOpsInspect,
} from "@shared/host-ops";
import {
  classifyHostRuntimeBlocker,
  decideHostRuntimeGap,
  expectedPackageStateFromGap,
  hostRuntimeGapCopy,
  type HostRuntimeGap,
  type HostRuntimeIntent,
  type HostRuntimeObservation,
} from "@shared/host-runtime";
import type { InstallationId } from "@shared/installation-id";
import {
  RELEASE_CAPABILITIES,
  type ReleaseCapabilities,
} from "@shared/release-capabilities";
import { RemoteHostsError, type RemoteHost } from "@shared/remote-hosts";
import { parseHostSshRoute, type SshError } from "../ssh/domain";
import { formatSshFailure } from "../ssh/format";
import { SshTransport, type SshTransportShape } from "../ssh/service";
import { RemotePlatformProbeError } from "../ssh/read-commands";
import { StationFleetTargetRepository } from "../station/fleet-target-repository";
import type { ConfigureRemoteOptions } from "./configure-remote";
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
import { appendDeployJobStage } from "./deploy-job-registry";
import { HostConfigure, HostOps } from "./host-ops";
import {
  HOST_RUNTIME_REMEDY_ROUNDS,
  hostRuntimeBlockedDeploy,
  sealHostRuntimeStages,
} from "./host-runtime-platform";
import type { LinuxReleaseCacheSource } from "./linux-release-feed";
import {
  HostMaintenanceAuthority,
  makeLiveHostMaintenanceAuthority,
  withIncumbentMaintenance,
} from "./maintenance";
import { commandCenterMayPrepareRemote } from "./remote-platform";
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

export type HostRuntimeApplyInput = {
  readonly host: RemoteHost;
  readonly gap: HostRuntimeGap;
  readonly priorInstallationId?: InstallationId;
};

export type HostRuntimeObserveInput = {
  readonly mode: HostRuntimeObservation["mode"];
  readonly priorInstallationId?: string;
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

const isSshError = (error: unknown): error is SshError =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  typeof (error as { readonly _tag: unknown })._tag === "string" &&
  (error as { readonly _tag: string })._tag.startsWith("Ssh");

/** Layer load failed. Station pair stays a configure receipt, not this path. */
const applyProvisionFailure = (
  host: RemoteHost,
  error: unknown,
): ConfiguredRemoteDeployResult => {
  if (error instanceof RemotePlatformProbeError) {
    return refused(host, `${host.label}: ${error.message}`, "validation");
  }
  if (isSshError(error)) {
    const detail = formatSshFailure(error);
    const blocker = classifyHostRuntimeBlocker(detail);
    if (blocker?.kind === "auth") {
      return refused(host, blocker.detail, "auth_required");
    }
    return refused(host, `${host.label}: SSH failed — ${detail}`, "io");
  }
  return refused(
    host,
    error instanceof Error ? error.message : String(error),
    "io",
  );
};

export type HostRuntimeApplyAdmission =
  | { readonly ok: true; readonly platform: "darwin" | "linux" }
  | {
      readonly ok: false;
      readonly detail: string;
      readonly code:
        | "io"
        | "validation"
        | "not_found"
        | "conflict"
        | "auth_required";
    };

/**
 * After observe: pairing (local .app when the Remote needs one) then the
 * release freeze. linuxRemoteDeploy stays a real apply gate, not a label.
 */
export const admitHostRuntimeApply = (input: {
  readonly observation: HostRuntimeObservation;
  readonly hostLabel: string;
  readonly commandCenterPlatform: NodeJS.Platform;
  readonly release?: Pick<
    ReleaseCapabilities,
    "linuxRemoteDeploy" | "darwinRemoteDeploy"
  >;
}): HostRuntimeApplyAdmission => {
  const release = input.release ?? RELEASE_CAPABILITIES;
  const platform = input.observation.platform;
  if (platform === "unknown") {
    return {
      ok: false,
      detail: hostRuntimeGapCopy("needOperator", input.observation.blocker),
      code: "validation",
    };
  }
  if (
    !commandCenterMayPrepareRemote(input.commandCenterPlatform, platform)
  ) {
    return {
      ok: false,
      detail: `${input.hostLabel}: a Darwin Remote needs a macOS Command Center (local .app source)`,
      code: "validation",
    };
  }
  const gate = releaseAllowsTargetPlatform(release, platform);
  if (!gate.ok) {
    return {
      ok: false,
      detail: `${input.hostLabel}: ${gate.detail}`,
      code: "validation",
    };
  }
  return { ok: true, platform };
};

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

const withHostOps = <A, E>(
  ssh: Ssh,
  target: Parameters<typeof HostOps.layerForTarget>[0],
  configure: ConfigureRemoteOptions | undefined,
  use: Effect.Effect<A, E, HostOps>,
): Effect.Effect<A, E | SshError | RemotePlatformProbeError> =>
  use.pipe(
    Effect.provide(
      HostOps.layerForTarget(target).pipe(
        Layer.provide(
          configure === undefined
            ? HostConfigure.layerUnset
            : HostConfigure.layer(configure),
        ),
        Layer.provide(Layer.succeed(SshTransport, ssh)),
      ),
    ),
  );

const configuredFromOps = (
  receipt: HostOpsConfigure,
): Parameters<typeof finishWithConfiguration>[2] => ({
  ok: receipt.ok,
  detail: receipt.detail,
  ...(receipt.stationInstallationId === undefined
    ? {}
    : {
        stationInstallationId:
          receipt.stationInstallationId as InstallationId,
      }),
  ...(receipt.configuredAt === undefined
    ? {}
    : { configuredAt: receipt.configuredAt }),
  ...(receipt.code === undefined ? {} : { code: receipt.code }),
});

const parseHostOpsCopyPhase = (
  stdout: string,
  stderr: string,
):
  | {
      readonly ok: true;
      readonly phase: "enrollment" | "runtime";
      readonly detail: string;
    }
  | { readonly ok: false; readonly detail: string } => {
  if (/^ENROLLMENT_READY pid=[1-9][0-9]* station=1$/mu.test(stdout)) {
    return {
      ok: true,
      phase: "enrollment",
      detail: "Vellum Command is installed and waiting to join the fleet",
    };
  }
  if (/^STATION_READY pid=[1-9][0-9]* term=1 browser=1$/mu.test(stdout)) {
    return {
      ok: true,
      phase: "runtime",
      detail: "Vellum Command is running on this Mac",
    };
  }
  const diagnostic = stderr.trim() || stdout.trim();
  return {
    ok: false,
    detail:
      diagnostic.slice(0, 900) ||
      "Vellum Command install did not prove enrollment or runtime readiness",
  };
};

/** Map a HostOps copy receipt onto the apply loop's package result. */
export const deployResultFromHostOpsCopy = (
  host: { readonly label: string; readonly sshEndpoint?: string },
  copied: HostOpsCopy,
): import("./remote-deployment").DeployRemoteResult => {
  const parsed = parseHostOpsCopyPhase(copied.stdout, copied.stderr);
  const prefix =
    host.sshEndpoint === undefined || host.sshEndpoint.length === 0
      ? host.label
      : `${host.label} (${host.sshEndpoint})`;
  if (copied.ok || parsed.ok) {
    const phase = parsed.ok ? parsed.phase : "runtime";
    const detail = parsed.ok ? parsed.detail : copied.stderr || copied.stdout || "package ready";
    return {
      ok: true,
      detail: `${prefix}: ${detail}`,
      stages: [detail],
      disposition:
        phase === "enrollment" ? "configuration-required" : "ready",
    };
  }
  const detail =
    copied.tag !== undefined && copied.tag !== parsed.detail
      ? copied.stderr.length > 0 && copied.stderr !== copied.tag
        ? `${copied.tag} ${copied.stderr}`
        : copied.tag
      : parsed.detail;
  return {
    ok: false,
    detail: `${prefix}: ${detail}`,
    code: "io",
    message: detail,
    stages: [detail],
    disposition:
      copied.tag === "LINUX_REMOTE_DEPLOY_OFF" ||
      copied.exit === 12 ||
      copied.exit === 3
        ? "not-started"
        : copied.exit === 10
          ? "ready"
          : "indeterminate",
  };
};

/** One apply loop. Tests provide a HostOps layer. */
export const applyHostRuntime = (
  context: HostRuntimeApplyInput,
): Effect.Effect<ConfiguredRemoteDeployResult, never, HostOps> =>
  Effect.gen(function* () {
    const { host, gap } = context;
    const ops = yield* HostOps;
    const remedyStages: string[] = [];
    const note = (stage: string) => {
      appendDeployJobStage(host.id, stage);
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

    const cleaned = yield* ops.cleanup();
    if (cleaned.removed.length > 0) {
      note(
        `removed abandoned leftovers: ${cleaned.removed.join(", ")}`,
      );
    }

    const firstInstall = gap === "needInstall" || gap === "needConfigure";
    let configured: ReturnType<typeof configuredFromOps> | undefined;
    let lastDeployed: Parameters<typeof failedPackageResult>[1] | undefined;
    let lastActivated: { ok: boolean; detail: string } | undefined;

    for (let round = 0; round < HOST_RUNTIME_REMEDY_ROUNDS; round++) {
      note(
        round === 0
          ? HOST_RUNTIME_REMEDY_STAGE.copy
          : HOST_RUNTIME_REMEDY_STAGE.copyAgain,
      );
      const copied = yield* ops.copy(expectedPackageStateFromGap(gap));
      const deployed = deployResultFromHostOpsCopy(host, copied);
      lastDeployed = deployed;
      const deployBlocker = classifyHostRuntimeBlocker(deployed.detail);
      if (deployBlocker !== undefined) {
        return seal(hostRuntimeBlockedDeploy(host, deployed, deployBlocker));
      }
      if (!packageAdmitted(deployed) && !copied.ok) {
        if (round === HOST_RUNTIME_REMEDY_ROUNDS - 1) {
          return seal(failedPackageResult(host, deployed));
        }
        continue;
      }
      if (copied.ok && copied.localApp !== undefined) {
        note(HOST_RUNTIME_REMEDY_STAGE.sign);
      }
      if (firstInstall && configured === undefined) {
        const next = yield* ops.configure();
        if (!next.ok) {
          return seal(
            configurationFailure(host, deployed, configuredFromOps(next)),
          );
        }
        configured = configuredFromOps(next);
      }
      note(HOST_RUNTIME_REMEDY_STAGE.restart);
      const activated = yield* ops.activate();
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
      const attached = yield* ops.attach();
      if (attached.workAttach === "up") {
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

const observationFromInspect = (
  host: RemoteHost,
  input: HostRuntimeObserveInput,
  receipt: HostOpsInspect,
  workAttach: HostOpsInspect["workAttach"],
): HostRuntimeObservation => ({
  hostId: host.id,
  placement: "remote",
  platform: receipt.platform,
  network: receipt.network,
  package: receipt.package,
  process: receipt.process,
  workAttach,
  mode: input.mode,
  ...(input.priorInstallationId === undefined
    ? {}
    : { priorInstallationId: input.priorInstallationId }),
});

/** Observe through HostOps. Tests provide a HostOps layer. */
export const observeHostRuntime = (
  host: RemoteHost,
  input: HostRuntimeObserveInput,
): Effect.Effect<HostRuntimeObservation, never, HostOps> =>
  Effect.gen(function* () {
    const ops = yield* HostOps;
    const receipt = yield* ops.inspect();
    // inspect already connects when it can; attach only if that plane stayed unknown
    const workAttach =
      receipt.workAttach === "unknown"
        ? (yield* ops.attach()).workAttach
        : receipt.workAttach;
    return observationFromInspect(host, input, receipt, workAttach);
  });

export const observeRemoteHost = (
  ssh: Ssh,
  host: RemoteHost,
  input: HostRuntimeObserveInput,
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

    const observed = yield* withHostOps(
      ssh,
      parsed.success,
      undefined,
      observeHostRuntime(host, input),
    ).pipe(Effect.result);

    if (observed._tag === "Failure") {
      const error = observed.failure;
      if (error instanceof RemotePlatformProbeError) {
        if (error.reason === "unsupported") {
          return {
            ...base,
            network: "up",
            platform: "unknown",
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
        return { ...base, network: "unknown" };
      }
      const blocker = classifyHostRuntimeBlocker(formatSshFailure(error));
      return {
        ...base,
        network: "unknown",
        ...(blocker === undefined ? {} : { blocker }),
      };
    }

    return observed.success;
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
    // Tests may inject a maintenance authority; production uses the live one
    // (Command Center route cut + held Remote terminal maintenance lease).
    const maintenanceOption = yield* Effect.serviceOption(
      HostMaintenanceAuthority,
    );
    const maintenance = Option.isSome(maintenanceOption)
      ? maintenanceOption.value
      : makeLiveHostMaintenanceAuthority(ssh);

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
        const remote = host.success;
        if (remote.kind === "local") {
          return refused(
            remote,
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
            remote,
            hostRuntimeGapCopy(gap, observation.blocker),
            observation.blocker?.kind === "auth" ? "auth_required" : "conflict",
          );
        }
        if (gap === "stillTrying") {
          return refused(
            remote,
            observation.network === "down"
              ? `Can't reach ${remote.label} on the network.`
              : hostRuntimeGapCopy(gap, observation.blocker),
            "io",
          );
        }

        const admission = admitHostRuntimeApply({
          observation,
          hostLabel: remote.label,
          commandCenterPlatform: process.platform,
        });
        if (!admission.ok) {
          return refused(remote, admission.detail, admission.code);
        }

        const parsed = yield* parseHostSshRoute(remote).pipe(Effect.result);
        if (parsed._tag === "Failure") {
          return refused(remote, parsed.failure.message, "validation");
        }

        const applyEffect = applyHostRuntime({
          host: remote,
          gap,
          ...(observation.priorInstallationId === undefined
            ? {}
            : {
                priorInstallationId:
                  observation.priorInstallationId as InstallationId,
              }),
        }).pipe(
          Effect.provide(
            HostOps.layerForTarget(parsed.success, remote.id).pipe(
              Layer.provide(HostConfigure.layer(input.configure)),
              Layer.provide(Layer.succeed(SshTransport, ssh)),
            ),
          ),
          Effect.catch((error) =>
            Effect.succeed(applyProvisionFailure(remote, error)),
          ),
        );
        // Update of an incumbent (never first install): hold the Remote
        // terminal maintenance lease across every incumbent mutation. Lease
        // refusal returns typed with the incumbent untouched; the lease
        // releases on every outcome.
        const applied =
          gap === "needRestart"
            ? yield* withIncumbentMaintenance(
                maintenance,
                {
                  host: remote,
                  sshTarget: parsed.success,
                  workAttach: observation.workAttach,
                  platform: admission.platform,
                },
                (stage) => {
                  appendDeployJobStage(remote.id, stage);
                },
                applyEffect,
              )
            : yield* applyEffect;
        if (input.onCompleted === undefined) return applied;
        return yield* input.onCompleted(remote, applied).pipe(
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
