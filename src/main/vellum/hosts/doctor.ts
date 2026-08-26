import { access } from "node:fs/promises";
import { constants } from "node:fs";
import type { Context } from "effect";
import { Effect } from "effect";
import type { ServiceCheck } from "@shared/contracts";
import {
  BROWSER_ENABLED,
  FLEET_UI_ENABLED,
  HERMES_INTEGRATION_ENABLED,
} from "@shared/features";
import { observeLinuxHostCapabilityDoctor } from "@shared/linux-host-capability-doctor";
import type { LinuxHostCapabilityObservation } from "@shared/linux-host-capabilities";
import {
  type StationLeaseObservation,
  type StationRemoteObservation,
  type StationRouteObservation,
  redactStationDiagnostic,
  stationRecoveryForRemote,
} from "@shared/station-status";
import {
  hermesKeyFor,
  hostHasCapability,
  type RemoteHost,
} from "@shared/remote-hosts";
import { runCli, type CliResult } from "../adapters/exec";
import {
  parseHostSshRoute,
  type SshError,
} from "../ssh/domain";
import { OPENSSH_CLIENT_EXECUTABLE } from "../ssh/live";
import { oneShot } from "../ssh/program";
import {
  remoteLinuxCapabilityDoctor,
  remoteProductVersion,
  remoteUname,
} from "../ssh/read-commands";
import type { SshTransportShape } from "../ssh/service";
import {
  StationFleetPropagation,
  type StationFleetPeerUnavailable,
  type StationFleetPropagationResult,
} from "../station/fleet-propagation";
import { REMOTE_LEASE_TTL_MS, evaluateRemoteLease } from "../license/remote-lease";
import type { HostsRegistry } from "./registry";

const HOST_PROBE_TOTAL_TIMEOUT_MS = 20_000;

const boundedDoctorDetail = (value: string, limit = 1_024): string =>
  redactStationDiagnostic(value.replaceAll(/\s+/gu, " ").trim()).slice(0, limit);

type Ssh = SshTransportShape;
type Fleet = Context.Service.Shape<typeof StationFleetPropagation>;
export type HostCliRunner = (
  command: string,
  args: ReadonlyArray<string>,
  timeoutMs?: number,
) => Promise<CliResult>;

export type RemoteHostsDoctorSnapshot = {
  readonly check: ServiceCheck;
  readonly observations: ReadonlyArray<StationRemoteObservation>;
};

type RemoteHostProbeResult = {
  readonly status: "ok" | "warning" | "error";
  readonly detail: string;
  readonly observation: StationRemoteObservation;
};

const liveLeaseObservation = (lastCheckInAt: string): StationLeaseObservation => {
  const checkInMs = Date.parse(lastCheckInAt);
  if (!Number.isFinite(checkInMs)) {
    return { state: "unknown", source: "live", lastCheckInAt };
  }
  const decision = evaluateRemoteLease(
    checkInMs,
    { now: Date.now },
    REMOTE_LEASE_TTL_MS,
  );
  return {
    state: decision.ok ? "active" : "expired",
    source: "live",
    lastCheckInAt,
    ...(decision.expiresAtMs === null
      ? {}
      : { expiresAt: new Date(decision.expiresAtMs).toISOString() }),
  };
};

const routeObservation = (
  status: NonNullable<StationFleetPropagationResult["status"]>,
): StationRouteObservation => ({
  phase: status.phase,
  sessionOpen: status.sessionOpen,
  attempt: status.attempt,
  updatedAt: status.updatedAt,
  ...(status.nextRetryAt === undefined ? {} : { nextRetryAt: status.nextRetryAt }),
});

const binaryVersionArgs = (_binary: "hermes"): ReadonlyArray<string> => ["version"];

const classifySshFailure = (message: string): string => {
  if (/Permission denied|publickey|Authentication failed/i.test(message)) {
    return "Permission denied — check SSH keys / ssh-agent (`ssh <endpoint>` interactively).";
  }
  if (
    /Could not resolve hostname|Name or service not known|nodename nor servname/i.test(
      message,
    )
  ) {
    return "Unknown host — add a Host entry in ~/.ssh/config or use a resolvable hostname.";
  }
  if (
    /Connection timed out|Operation timed out|ETIMEDOUT|ConnectTimeout/i.test(
      message,
    )
  ) {
    return "Timeout — host unreachable (VPN down, wrong endpoint, or firewall).";
  }
  if (/Host key verification failed/i.test(message)) {
    return "Host key rejected — verify fingerprint then `ssh-keygen -R <host>` if the machine was rebuilt.";
  }
  if (/Connection refused/i.test(message)) {
    return "Connection refused — sshd not listening on the remote, or wrong port.";
  }
  if (/too long for Unix domain socket|unix_listener/i.test(message)) {
    return "SSH control socket path is too long for this OS.";
  }
  return message;
};

const describeSshError = (error: SshError): string => {
  switch (error._tag) {
    case "SshTimeoutError":
      return classifySshFailure(
        `Connection timed out after ${error.timeoutMs}ms`,
      );
    case "SshExitError":
      return classifySshFailure(
        error.detail ?? `ssh exited with code ${error.code}`,
      );
    case "SshInputError":
      return `Invalid endpoint: ${error.message}`;
    case "SshOutputLimitError":
      return `SSH ${error.stream} exceeded ${error.limitBytes} bytes`;
    default:
      return classifySshFailure(error.message);
  }
};

const describeFleetFailure = (
  error: StationFleetPeerUnavailable,
): string =>
  error.reason === "not-enrolled"
    ? "This machine is not in the fleet yet"
    : error.message;

/** SSH warm only. Station silence is not the machine going away. */
const probeSshNetwork = (
  ssh: Ssh,
  host: RemoteHost,
): Effect.Effect<"up" | "down"> =>
  parseHostSshRoute(host).pipe(
    Effect.flatMap((target) => ssh.warm(target)),
    Effect.as("up" as const),
    Effect.catch(() => Effect.succeed("down" as const)),
    Effect.catchDefect(() => Effect.succeed("down" as const)),
  );

const localBinary = async (
  binary: "hermes",
  run: HostCliRunner,
): Promise<{ ok: boolean; detail: string }> => {
  const result = await run(binary, binaryVersionArgs(binary), 5_000).catch(
    (error) => ({
      ok: false as const,
      stdout: "",
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  if (!result.ok) {
    const err = result.error ?? "not found";
    if (/ENOENT|not found|command not found/i.test(err)) {
      return {
        ok: false,
        detail: `missing ${binary} on PATH — install the ${binary} CLI for this machine`,
      };
    }
    return { ok: false, detail: `${binary}: ${err}` };
  }
  const version = result.stdout.trim().split("\n")[0] ?? "ok";
  return { ok: true, detail: `${binary} ${version}` };
};

const remoteBinary = (
  ssh: Ssh,
  host: RemoteHost,
  binary: "hermes",
): Effect.Effect<{ ok: boolean; detail: string }> =>
  parseHostSshRoute(host).pipe(
    Effect.flatMap((parsed) =>
      remoteProductVersion(binary).pipe(
        Effect.flatMap((command) =>
          ssh.run(oneShot(parsed, command, { budget: "status" })),
        ),
      ),
    ),
    Effect.map((result) => {
      const line = result.stdout.trim().split("\n")[0] ?? "ok";
      return { ok: true, detail: `${binary} ${line}` };
    }),
    Effect.catch((error) =>
      Effect.succeed({
        ok: false,
        detail:
          error && typeof error === "object" && "_tag" in error
            ? describeSshError(error as SshError)
            : String(error),
      }),
    ),
  );

/**
 * Linux capability Doctor over SSH. Darwin and unknown platforms never run
 * it — a non-linux probe is not a host-health signal.
 */
const probeLinuxHostCapabilities = (
  ssh: Ssh,
  host: RemoteHost,
): Effect.Effect<LinuxHostCapabilityObservation | undefined> =>
  parseHostSshRoute(host).pipe(
    Effect.flatMap((parsed) =>
      remoteUname().pipe(
        Effect.flatMap((uname) =>
          ssh.run(oneShot(parsed, uname, { budget: "short" })),
        ),
        Effect.flatMap((unameResult) => {
          if (unameResult.stdout !== "Linux\n") {
            return Effect.succeed(undefined);
          }
          return remoteLinuxCapabilityDoctor().pipe(
            Effect.flatMap((command) =>
              ssh.run(oneShot(parsed, command, { budget: "status" })),
            ),
            Effect.map((result) => {
              const observation = observeLinuxHostCapabilityDoctor(
                result.stdout,
              );
              return observation?.facts.platform === "linux"
                ? observation
                : undefined;
            }),
          );
        }),
      ),
    ),
    Effect.catch(() => Effect.succeed(undefined)),
    // Test doubles and transport defects must not surface through hostsTest.
    Effect.catchDefect(() => Effect.succeed(undefined)),
  );

const probeSshHost = (
  ssh: Ssh,
  fleet: Fleet,
  host: RemoteHost,
): Effect.Effect<RemoteHostProbeResult> =>
  Effect.gen(function* () {
    if (!host.sshEndpoint) {
      return {
        status: "error" as const,
        detail: `${host.id}: remote host missing endpoint`,
        observation: {
          hostId: host.id,
          endpoint: "",
          reachability: "unknown" as const,
          source: "live" as const,
          reachabilityError: "remote host missing endpoint",
          observationError: "remote host missing endpoint",
          recovery: stationRecoveryForRemote({
            identityConflict: false,
            unreachable: true,
            stationAvailable: false,
            readinessFailed: false,
            stale: false,
          }),
        },
      };
    }

    const synchronized = yield* fleet.synchronize(host.id);
    const result = synchronized[0];
    if (result === undefined || result.ok === false) {
      const detail = result === undefined
        ? "This machine is not in the fleet yet"
        : describeFleetFailure(result.error);
      const updateRequired =
        result?.ok === false &&
        result.error.reason === "update-required";
      const route = result?.status === undefined
        ? undefined
        : routeObservation(result.status);
      const protocol = result?.status?.protocol;
      let reachability = updateRequired
        ? "reachable" as const
        : result?.ok === false && result.error.reason === "not-enrolled"
          ? "unknown" as const
          : "unreachable" as const;
      let operatorDetail = `${host.label}: ${boundedDoctorDetail(detail)}`;
      if (reachability === "unreachable") {
        const network = yield* probeSshNetwork(ssh, host);
        if (network === "up") {
          reachability = "reachable";
          operatorDetail = `${host.label}: On the network. Vellum Command is not answering.`;
        }
      }
      const recovery = stationRecoveryForRemote({
        identityConflict: false,
        protocol,
        unreachable: reachability === "unreachable",
        stationAvailable: false,
        readinessFailed: false,
        stale: false,
      });
      return {
        status: updateRequired ? "warning" as const : "error" as const,
        detail: operatorDetail,
        observation: {
          hostId: host.id,
          endpoint: host.sshEndpoint,
          reachability,
          source: result?.status === undefined ? "live" as const : "last-acknowledged" as const,
          ...(updateRequired ? {} : { reachabilityError: boundedDoctorDetail(detail) }),
          ...(protocol === undefined
            ? {}
            : { protocol }),
          ...(result?.stationInstallationId === undefined
            ? {}
            : { expectedInstallationId: result.stationInstallationId }),
          ...(route === undefined ? {} : { route }),
          ...(result?.status?.updatedAt === undefined
            ? {}
            : { observedAt: result.status.updatedAt }),
          ...(recovery === undefined ? {} : { recovery }),
          observationError: boundedDoctorDetail(detail),
        },
      };
    }

    const station = result.receipt.remoteStatus;
    const configuration = station.configuration;
    const parts = [
      `Vellum Command ${station.state}`,
      `installation ${station.installationId}`,
    ];
    const protocol = result.status.protocol;
    const observedAt = new Date().toISOString();
    const lease = liveLeaseObservation(observedAt);
    const route = routeObservation(result.status);
    let worst: "ok" | "warning" | "error" = "ok";
    const problems: string[] = [];
    const raise = (severity: "warning" | "error", problem: string) => {
      if (severity === "error" || worst === "ok") worst = severity;
      problems.push(problem);
    };

    if (protocol !== undefined) {
      parts.push(
        protocol.compatibility === "update-required"
          ? "protocol update required"
          : `protocol ${protocol.negotiatedProtocol} ${protocol.compatibility}`,
      );
      if (protocol.compatibility === "deprecated") {
        raise(
          "warning",
          `Station protocol ${protocol.negotiatedProtocol} is deprecated`,
        );
      }
    }

    if (configuration === undefined) {
      parts.push("configuration absent");
      raise("warning", "station is not configured");
    } else {
      parts.push(
        `role ${configuration.role} - hostId ${configuration.hostId}`,
      );
      if (
        configuration.role !== "remote" ||
        configuration.hostId !== host.id
      ) {
        raise(
          "error",
          `registered host ${host.id} does not match Station configuration`,
        );
      }
    }

    const ready = Object.entries(station.readiness)
      .filter(([, value]) => !value)
      .map(([name]) => name);
    if (ready.length > 0) {
      raise("warning", `not ready: ${ready.join(", ")}`);
    }
    parts.push(
      `readiness database=${station.readiness.database} work=${station.readiness.workControl} simulation=${station.readiness.simulation}`,
    );
    if (station.projection) {
      parts.push(`projection ${station.projection.generation}`);
    }
    const reportIncomplete =
      result.receipt.report.hasMoreOutbound ||
      result.receipt.report.hasMoreInbound ||
      result.receipt.report.inboundRejected > 0;
    parts.push(
      `report rounds=${result.receipt.report.rounds} sent=${result.receipt.report.outboundSent} received=${result.receipt.report.inboundReceived} rejected=${result.receipt.report.inboundRejected}`,
    );
    if (reportIncomplete) {
      raise("warning", "last work report did not converge cleanly");
    }

    if (hostHasCapability(host, "browser")) {
      parts.push("browser capability declared");
    }
    if (HERMES_INTEGRATION_ENABLED && hostHasCapability(host, "hermes")) {
      const hermes = yield* remoteBinary(ssh, host, "hermes");
      parts.push(hermes.detail);
      if (!hermes.ok) raise("warning", hermes.detail);
    }

    const recovery = reportIncomplete
      ? {
          kind: "retryable" as const,
          nextStep:
            "Inspect the rejected work route, correct its authority or causal predecessor, then retry the link test.",
        }
      : stationRecoveryForRemote({
          identityConflict:
            configuration?.role !== "remote" || configuration.hostId !== host.id,
          protocol,
          lease,
          unreachable: false,
          stationAvailable: true,
          readinessFailed: ready.length > 0,
          stale: false,
        });

    return {
      status: worst,
      detail: boundedDoctorDetail(
        `${host.label} (${host.sshEndpoint}): ${parts.join(" - ")}`,
      ),
      observation: {
        hostId: host.id,
        endpoint: host.sshEndpoint,
        reachability: "reachable" as const,
        source: "live" as const,
        observedAt,
        expectedInstallationId: result.stationInstallationId,
        ...(protocol === undefined ? {} : { protocol }),
        route,
        lease,
        readiness: {
          database: station.readiness.database,
          workControl: station.readiness.workControl,
          simulation: station.readiness.simulation,
        },
        topology: result.receipt.projection.topology,
        synchronization: {
          projectionDecision: result.receipt.projection.decision,
          projectionGeneration: result.receipt.projection.active.generation,
          projectionContentSha256:
            result.receipt.projection.active.contentSha256,
          reportRounds: result.receipt.report.rounds,
          outboundSent: result.receipt.report.outboundSent,
          inboundReceived: result.receipt.report.inboundReceived,
          inboundAccepted: result.receipt.report.inboundAccepted,
          inboundIdempotent: result.receipt.report.inboundIdempotent,
          inboundRejected: result.receipt.report.inboundRejected,
          hasMoreOutbound: result.receipt.report.hasMoreOutbound,
          hasMoreInbound: result.receipt.report.hasMoreInbound,
          converged:
            !result.receipt.report.hasMoreOutbound &&
            !result.receipt.report.hasMoreInbound &&
            result.receipt.report.inboundRejected === 0,
        },
        ...(protocol?.peer?.appVersion === undefined
          ? {}
          : { packageGeneration: protocol.peer.appVersion }),
        station,
        ...(recovery === undefined ? {} : { recovery }),
        ...(problems.length === 0
          ? {}
          : { observationError: boundedDoctorDetail(problems.join("; ")) }),
      },
    };
  }).pipe(
    Effect.catch((error) => {
      const detail =
        typeof error === "object" &&
          error !== null &&
          "message" in error &&
          typeof error.message === "string"
          ? error.message
          : String(error);
      return Effect.succeed({
        status: "error" as const,
        detail: `${host.label}: ${detail}`,
        observation: {
          hostId: host.id,
          endpoint: host.sshEndpoint ?? "",
          reachability: "unreachable" as const,
          source: "live" as const,
          reachabilityError: boundedDoctorDetail(detail),
          observationError: boundedDoctorDetail(detail),
          recovery: stationRecoveryForRemote({
            identityConflict: false,
            unreachable: true,
            stationAvailable: false,
            readinessFailed: false,
            stale: false,
          }),
        },
      });
    }),
  );

const boundedProbeSshHost = (
  ssh: Ssh,
  fleet: Fleet,
  host: RemoteHost,
): Effect.Effect<RemoteHostProbeResult> =>
  probeSshHost(ssh, fleet, host).pipe(
    Effect.timeoutOrElse({
      duration: HOST_PROBE_TOTAL_TIMEOUT_MS,
      orElse: () => Effect.fail(new Error("remote host doctor deadline exceeded")),}),
    Effect.catch(() =>
      Effect.succeed({
        status: "error" as const,
        detail: `${host.label}: probe timed out after ${HOST_PROBE_TOTAL_TIMEOUT_MS}ms`,
        observation: {
          hostId: host.id,
          endpoint: host.sshEndpoint ?? "",
          reachability: "unreachable" as const,
          source: "live" as const,
          reachabilityError: `probe timed out after ${HOST_PROBE_TOTAL_TIMEOUT_MS}ms`,
          observationError:
            `probe timed out after ${HOST_PROBE_TOTAL_TIMEOUT_MS}ms`,
          recovery: stationRecoveryForRemote({
            identityConflict: false,
            unreachable: true,
            stationAvailable: false,
            readinessFailed: false,
            stale: false,
          }),
        },
      }),
    ),
  );

export const runRemoteHostsDoctorSnapshot = (
  registry: HostsRegistry,
  ssh: Ssh,
  fleet: Fleet,
  run: HostCliRunner = runCli,
): Effect.Effect<RemoteHostsDoctorSnapshot> =>
  Effect.gen(function* () {
    const hosts = yield* Effect.tryPromise({
      try: () => registry.list(),
      catch: (error) =>
        error instanceof Error ? error : new Error(String(error)),
    });

    const lines: string[] = [];
    let worst: "ok" | "warning" | "error" = "ok";
    const raise = (status: "ok" | "warning" | "error") => {
      if (status === "error") worst = "error";
      else if (status === "warning" && worst === "ok") worst = "warning";
    };

    const local = hosts.find((host) => host.kind === "local");
    if (local) {
      if (hostHasCapability(local, "browser")) {
        lines.push("local: browser capability declared");
      }
      if (HERMES_INTEGRATION_ENABLED && hostHasCapability(local, "hermes")) {
        const hermes = yield* Effect.promise(() =>
          localBinary("hermes", run),
        );
        lines.push(`local: ${hermes.detail}`);
        if (!hermes.ok) raise("warning");
      }
    }

    const remoteHosts = FLEET_UI_ENABLED
      ? hosts.filter((host) => host.kind === "remote")
      : [];
    if (!FLEET_UI_ENABLED && hosts.some((host) => host.kind === "remote")) {
      lines.push("remote host probing is disabled in this Vellum Command build");
    }
    if (remoteHosts.length > 0) {
      const sshBinaryOk = yield* Effect.tryPromise({
        try: async () => {
          await access(OPENSSH_CLIENT_EXECUTABLE, constants.X_OK);
          return true;
        },
        catch: () => false as const,
      }).pipe(Effect.catch(() => Effect.succeed(false as const)));

      if (!sshBinaryOk) {
        const detail = `OpenSSH client not executable at ${OPENSSH_CLIENT_EXECUTABLE} — install the client`;
        return {
          check: {
            id: "remote-hosts",
            label: "Remote hosts",
            status: "error" as const,
            detail,
          },
          observations: remoteHosts.map((host) => ({
            hostId: host.id,
            endpoint: host.sshEndpoint ?? "",
            reachability: "unknown" as const,
            reachabilityError: detail,
            observationError: detail,
          })),
        } satisfies RemoteHostsDoctorSnapshot;
      }
    }

    const results =
      remoteHosts.length === 0
        ? []
        : yield* Effect.forEach(
            remoteHosts,
            (host) => boundedProbeSshHost(ssh, fleet, host),
            { concurrency: "unbounded" },
          );
    if (remoteHosts.length === 0) {
      lines.push("no remote ssh hosts configured");
    } else {
      for (const result of results) {
        lines.push(result.detail);
        raise(result.status);
      }
    }

    const hermesKeys = HERMES_INTEGRATION_ENABLED
      ? hosts
          .filter((host) => hostHasCapability(host, "hermes"))
          .map((host) => hermesKeyFor(host))
          .join(", ")
      : "";
    const browserHostIds = BROWSER_ENABLED
      ? hosts
          .filter((host) => hostHasCapability(host, "browser"))
          .map((host) => host.id)
          .join(", ")
      : "";

    return {
      check: {
        id: "remote-hosts",
        label: "Remote hosts",
        status: worst,
        detail: lines.join(" - "),
        metadata: {
          hostCount: String(hosts.length),
          remoteHostCount: String(remoteHosts.length),
          hermesKeys,
          browserHostCount: String(
            hosts.filter((host) =>
              hostHasCapability(host, "browser"),
            ).length,
          ),
          browserHostIds,
        },
      },
      observations: results.map((result) => result.observation),
    } satisfies RemoteHostsDoctorSnapshot;
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed({
        check: {
          id: "remote-hosts",
          label: "Remote hosts",
          status: "error" as const,
          detail: error instanceof Error ? error.message : String(error),
        },
        observations: [],
      } satisfies RemoteHostsDoctorSnapshot),
    ),
  );

export const runRemoteHostsDoctor = (
  registry: HostsRegistry,
  ssh: Ssh,
  fleet: Fleet,
  run: HostCliRunner = runCli,
): Effect.Effect<ServiceCheck> =>
  runRemoteHostsDoctorSnapshot(registry, ssh, fleet, run).pipe(
    Effect.map((snapshot) => snapshot.check),
  );

export const testHostConnection = (
  ssh: Ssh,
  fleet: Fleet,
  host: RemoteHost,
  run: HostCliRunner = runCli,
): Effect.Effect<{
  readonly ok: boolean;
  readonly detail: string;
  readonly reachability?: "reachable" | "unreachable" | "unknown";
  readonly protocol?: StationRemoteObservation["protocol"];
  readonly linuxCapabilities?: LinuxHostCapabilityObservation;
  readonly observation?: StationRemoteObservation;
}> =>
  host.kind === "local"
    ? Effect.gen(function* () {
        const probes: Array<{
          readonly ok: boolean;
          readonly detail: string;
        }> = [];
        if (hostHasCapability(host, "browser")) {
          probes.push({
            ok: true,
            detail: "browser capability declared",
          });
        }
        if (HERMES_INTEGRATION_ENABLED && hostHasCapability(host, "hermes")) {
          probes.push(
            yield* Effect.promise(() => localBinary("hermes", run)),
          );
        }
        return {
          ok: probes.every((probe) => probe.ok),
          detail:
            probes.map((probe) => probe.detail).join(" - ") ||
            "local host ready",
        };
      })
    : Effect.gen(function* () {
        const result = yield* probeSshHost(ssh, fleet, host);
        const linuxCapabilities = yield* probeLinuxHostCapabilities(ssh, host);
        const linuxCore =
          linuxCapabilities !== undefined &&
          linuxCapabilities.facts.platform === "linux";
        const coreReady =
          !linuxCore || linuxCapabilities.status === "ready";
        return {
          ok: result.status === "ok" && coreReady,
          detail:
            !linuxCore
              ? boundedDoctorDetail(result.detail)
              : boundedDoctorDetail(`${result.detail} - host ${linuxCapabilities.status}: ${linuxCapabilities.summary}`),
          reachability: result.observation.reachability,
          ...(result.observation.protocol === undefined
            ? {}
            : { protocol: result.observation.protocol }),
          observation: result.observation,
          ...(linuxCore ? { linuxCapabilities } : {}),
        };
      });
