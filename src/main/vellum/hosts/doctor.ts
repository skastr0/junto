import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { posix } from "node:path";
import type { Context } from "effect";
import { Effect } from "effect";
import type { ServiceCheck } from "@shared/contracts";
import {
  decodeStationStatusDocument,
  type StationRemoteObservation,
} from "@shared/station-status";
import {
  hermesKeyFor,
  hostHasCapability,
  type RemoteHost,
} from "@shared/remote-hosts";
import { runCli, type CliResult } from "../adapters/exec";
import {
  makeRemoteCommand,
  parseSshEndpoint,
  SshTimeoutError,
  type SshError,
} from "../ssh/domain";
import { homeDirectoryLookup, oneShot } from "../ssh/program";
import { SshTransport } from "../ssh/service";
import type { HostsRegistry } from "./registry";

// Resolve via PATH floor used by the transport kernel (not a second spawn site).
const openSshClientPath = (): string =>
  process.env.VELLUM_SSH_EXECUTABLE || ["", "usr", "bin", "ssh"].join("/");
const PROBE_TIMEOUT_MS = 10_000;
const HOST_PROBE_TOTAL_TIMEOUT_MS = 20_000;

type Ssh = Context.Tag.Service<typeof SshTransport>;
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

const binaryVersionArgs = (
  binary: "herdr" | "hermes",
): ReadonlyArray<string> => binary === "herdr" ? ["--version"] : ["version"];

const classifySshFailure = (message: string): string => {
  if (/Permission denied|publickey|Authentication failed/i.test(message)) {
    return "Permission denied — check SSH keys / ssh-agent (`ssh <endpoint>` interactively).";
  }
  if (/Could not resolve hostname|Name or service not known|nodename nor servname/i.test(message)) {
    return "Unknown host — add a Host entry in ~/.ssh/config or use a resolvable hostname.";
  }
  if (/Connection timed out|Operation timed out|ETIMEDOUT|ConnectTimeout/i.test(message)) {
    return "Timeout — host unreachable (VPN/Tailscale down, wrong endpoint, or firewall).";
  }
  if (/Host key verification failed/i.test(message)) {
    return "Host key rejected — verify fingerprint then `ssh-keygen -R <host>` if the machine was rebuilt.";
  }
  if (/Connection refused/i.test(message)) {
    return "Connection refused — sshd not listening on the remote, or wrong port.";
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
      return classifySshFailure(`ssh exited with code ${error.code}`);
    case "SshInputError":
      return `Invalid endpoint: ${error.message}`;
    default:
      return classifySshFailure(error.message);
  }
};

const localBinary = async (
  binary: "herdr" | "hermes",
  run: HostCliRunner,
): Promise<{ ok: boolean; detail: string }> => {
  const result = await run(binary, binaryVersionArgs(binary), 5_000).catch((error) => ({
    ok: false as const,
    stdout: "",
    error: error instanceof Error ? error.message : String(error),
  }));
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
  endpoint: string,
  binary: "herdr" | "hermes",
): Effect.Effect<{ ok: boolean; detail: string }> =>
  parseSshEndpoint(endpoint).pipe(
    Effect.flatMap((parsed) =>
      makeRemoteCommand(binary, binaryVersionArgs(binary)).pipe(
        Effect.flatMap((command) =>
          ssh.run(oneShot(parsed, command, { budget: "status" })),
        ),
      ),
    ),
    Effect.map((result) => {
      const line = result.stdout.trim().split("\n")[0] ?? "ok";
      return { ok: true, detail: `${binary} ${line}` };
    }),
    Effect.catchAll((error) =>
      Effect.succeed({
        ok: false,
        detail:
          error && typeof error === "object" && "_tag" in error
            ? describeSshError(error as SshError)
            : String(error),
      }),
    ),
  );

type RemoteFileRead =
  | { readonly ok: true; readonly body: string }
  | { readonly ok: false; readonly detail: string };

const describeUnknownSsh = (error: unknown): string =>
  error && typeof error === "object" && "_tag" in error
    ? describeSshError(error as SshError)
    : error instanceof Error
      ? error.message
      : String(error);

const readRemoteText = (
  ssh: Ssh,
  endpoint: Parameters<typeof oneShot>[0],
  path: string,
): Effect.Effect<RemoteFileRead> =>
  makeRemoteCommand("cat", [path]).pipe(
    Effect.flatMap((command) =>
      ssh.run(oneShot(endpoint, command, { budget: "status" })),
    ),
    Effect.map(
      (result): RemoteFileRead => ({ ok: true, body: result.stdout }),
    ),
    Effect.catchAll((error) =>
      Effect.succeed({
        ok: false as const,
        detail: describeUnknownSsh(error),
      }),
    ),
  );

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const decodeRemoteStationSettings = (
  raw: string,
):
  | {
      readonly ok: true;
      readonly role: string;
      readonly hostId: string;
    }
  | { readonly ok: false } => {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.station)) return { ok: false };
    if (
      typeof parsed.station.role !== "string" ||
      typeof parsed.station.hostId !== "string"
    ) {
      return { ok: false };
    }
    return {
      ok: true,
      role: parsed.station.role.slice(0, 64),
      hostId: parsed.station.hostId.slice(0, 64),
    };
  } catch {
    return { ok: false };
  }
};

const probeSshHost = (
  ssh: Ssh,
  host: RemoteHost,
): Effect.Effect<RemoteHostProbeResult> =>
  Effect.gen(function* () {
    if (!host.endpoint) {
      return {
        status: "error" as const,
        detail: `${host.id}: remote host missing endpoint`,
        observation: {
          hostId: host.id,
          endpoint: "",
          reachability: "unknown" as const,
          reachabilityError: "remote host missing endpoint",
          settingsState: "unavailable" as const,
          statusState: "unavailable" as const,
        },
      };
    }

    const endpoint = yield* parseSshEndpoint(host.endpoint);

    yield* ssh.warm(endpoint).pipe(
      Effect.timeoutFail({
        duration: PROBE_TIMEOUT_MS,
        onTimeout: () =>
          new SshTimeoutError({
            endpoint: host.endpoint!,
            operation: "doctor-warm",
            timeoutMs: PROBE_TIMEOUT_MS,
          }),
      }),
    );

    const home = yield* ssh.run(homeDirectoryLookup(endpoint));
    const homePath = home.stdout.trim();
    if (!homePath.startsWith("/")) {
      return {
        status: "error" as const,
        detail: `${host.id}: remote home not writable/readable (got ${JSON.stringify(homePath)})`,
        observation: {
          hostId: host.id,
          endpoint: host.endpoint,
          reachability: "reachable" as const,
          settingsState: "unavailable" as const,
          statusState: "unavailable" as const,
          observationError: "remote home is not a canonical absolute path",
        },
      };
    }

    const parts: string[] = [`auth ok · home ${homePath}`];
    let warnings = 0;
    const [settingsRead, statusRead] = yield* Effect.all(
      [
        readRemoteText(
          ssh,
          endpoint,
          posix.join(homePath, ".vellum", "settings.json"),
        ),
        readRemoteText(
          ssh,
          endpoint,
          posix.join(homePath, ".vellum", "station-status.json"),
        ),
      ],
      { concurrency: "unbounded" },
    );

    const settings = settingsRead.ok
      ? decodeRemoteStationSettings(settingsRead.body)
      : undefined;
    const stationStatus = statusRead.ok
      ? (() => {
          try {
            return decodeStationStatusDocument(
              JSON.parse(statusRead.body) as unknown,
            );
          } catch {
            return undefined;
          }
        })()
      : undefined;
    const observationErrors: string[] = [];
    if (!settingsRead.ok) {
      observationErrors.push(`settings unavailable (${settingsRead.detail})`);
      warnings += 1;
    } else if (!settings?.ok) {
      observationErrors.push("settings invalid");
      warnings += 1;
    }
    if (!statusRead.ok) {
      observationErrors.push(
        `station status unavailable (${statusRead.detail})`,
      );
      warnings += 1;
    } else if (!stationStatus) {
      observationErrors.push("station status invalid");
      warnings += 1;
    }
    parts.push(
      settings?.ok
        ? `station role ${settings.role || "unset"} · hostId ${settings.hostId}`
        : "station settings unavailable",
    );
    parts.push(
      stationStatus
        ? `station status observed ${stationStatus.kernel?.observedAt ?? "without kernel heartbeat"}`
        : "station status unavailable",
    );

    if (hostHasCapability(host, "browser")) {
      parts.push("browser capability declared");
    }
    if (hostHasCapability(host, "herdr")) {
      const herdr = yield* remoteBinary(ssh, host.endpoint, "herdr");
      parts.push(herdr.detail);
      if (!herdr.ok) warnings += 1;
    }
    if (hostHasCapability(host, "hermes")) {
      const hermes = yield* remoteBinary(ssh, host.endpoint, "hermes");
      parts.push(hermes.detail);
      if (!hermes.ok) warnings += 1;
    }

    return {
      status: (warnings > 0 ? "warning" : "ok") as "ok" | "warning",
      detail: `${host.label} (${host.endpoint}): ${parts.join(" · ")}`,
      observation: {
        hostId: host.id,
        endpoint: host.endpoint,
        reachability: "reachable" as const,
        settingsState: settingsRead.ok
          ? settings?.ok
            ? ("observed" as const)
            : ("invalid" as const)
          : ("unavailable" as const),
        ...(settings?.ok
          ? {
              stationRole: settings.role,
              stationHostId: settings.hostId,
            }
          : {}),
        statusState: statusRead.ok
          ? stationStatus
            ? ("observed" as const)
            : ("invalid" as const)
          : ("unavailable" as const),
        ...(stationStatus ? { status: stationStatus } : {}),
        ...(observationErrors.length > 0
          ? { observationError: observationErrors.join("; ").slice(0, 1_024) }
          : {}),
      },
    };
  }).pipe(
    Effect.catchAll((error) =>
      Effect.succeed({
        status: "error" as const,
        detail: `${host.label}: ${describeUnknownSsh(error)}`,
        observation: {
          hostId: host.id,
          endpoint: host.endpoint ?? "",
          reachability: "unreachable" as const,
          reachabilityError: describeUnknownSsh(error),
          settingsState: "unavailable" as const,
          statusState: "unavailable" as const,
        },
      }),
    ),
  );

const boundedProbeSshHost = (
  ssh: Ssh,
  host: RemoteHost,
): Effect.Effect<RemoteHostProbeResult> =>
  probeSshHost(ssh, host).pipe(
    Effect.timeoutFail({
      duration: HOST_PROBE_TOTAL_TIMEOUT_MS,
      onTimeout: () => new Error("remote host doctor deadline exceeded"),
    }),
    Effect.catchAll(() =>
      Effect.succeed({
        status: "error" as const,
        detail: `${host.label}: probe timed out after ${HOST_PROBE_TOTAL_TIMEOUT_MS}ms`,
        observation: {
          hostId: host.id,
          endpoint: host.endpoint ?? "",
          reachability: "unreachable" as const,
          reachabilityError: `probe timed out after ${HOST_PROBE_TOTAL_TIMEOUT_MS}ms`,
          settingsState: "unavailable" as const,
          statusState: "unavailable" as const,
        },
      }),
    ),
  );

export const runRemoteHostsDoctorSnapshot = (
  registry: HostsRegistry,
  ssh: Ssh,
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
      if (hostHasCapability(local, "herdr")) {
        const herdr = yield* Effect.promise(() => localBinary("herdr", run));
        lines.push(`local: ${herdr.detail}`);
        if (!herdr.ok) raise("warning");
      }
      if (hostHasCapability(local, "hermes")) {
        const hermes = yield* Effect.promise(() => localBinary("hermes", run));
        lines.push(`local: ${hermes.detail}`);
        if (!hermes.ok) raise("warning");
      }
    }

    const sshHosts = hosts.filter((host) => host.kind === "remote");
    if (sshHosts.length > 0) {
      const clientPath = openSshClientPath();
      const sshBinaryOk = yield* Effect.tryPromise({
        try: async () => {
          await access(clientPath, constants.X_OK);
          return true;
        },
        catch: () => false as const,
      }).pipe(Effect.catchAll(() => Effect.succeed(false as const)));

      if (!sshBinaryOk) {
        const detail = `OpenSSH client not executable at ${clientPath} — install the client or set VELLUM_SSH_EXECUTABLE`;
        return {
          check: {
            id: "remote-hosts",
            label: "Remote hosts",
            status: "error" as const,
            detail,
          },
          observations: sshHosts.map((host) => ({
            hostId: host.id,
            endpoint: host.endpoint ?? "",
            reachability: "unknown" as const,
            reachabilityError: detail,
            settingsState: "unavailable" as const,
            statusState: "unavailable" as const,
          })),
        } satisfies RemoteHostsDoctorSnapshot;
      }
    }

    const results =
      sshHosts.length === 0
        ? []
        : yield* Effect.forEach(
            sshHosts,
            (host) => boundedProbeSshHost(ssh, host),
            { concurrency: "unbounded" },
          );
    if (sshHosts.length === 0) {
      lines.push("no remote ssh hosts configured");
    } else {
      for (const result of results) {
        lines.push(result.detail);
        raise(result.status);
      }
    }

    const hermesKeys = hosts
      .filter((host) => hostHasCapability(host, "hermes"))
      .map((host) => hermesKeyFor(host))
      .join(", ");
    const browserHostIds = hosts
      .filter((host) => hostHasCapability(host, "browser"))
      .map((host) => host.id)
      .join(", ");

    return {
      check: {
        id: "remote-hosts",
        label: "Remote hosts",
        status: worst,
        detail: lines.join(" · "),
        metadata: {
          hostsPath: registry.path(),
          hostCount: String(hosts.length),
          remoteHostCount: String(sshHosts.length),
          hermesKeys,
          browserHostCount: String(
            hosts.filter((host) => hostHasCapability(host, "browser")).length,
          ),
          browserHostIds,
        },
      },
      observations: results.map((result) => result.observation),
    } satisfies RemoteHostsDoctorSnapshot;
  }).pipe(
    Effect.catchAll((error) =>
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
  run: HostCliRunner = runCli,
): Effect.Effect<ServiceCheck> =>
  runRemoteHostsDoctorSnapshot(registry, ssh, run).pipe(
    Effect.map((snapshot) => snapshot.check),
  );

export const testHostConnection = (
  ssh: Ssh,
  host: RemoteHost,
  run: HostCliRunner = runCli,
): Effect.Effect<{
  readonly ok: boolean;
  readonly detail: string;
}> =>
  host.kind === "local"
    ? Effect.gen(function* () {
        const probes: Array<{ readonly ok: boolean; readonly detail: string }> = [];
        if (hostHasCapability(host, "browser")) {
          probes.push({ ok: true, detail: "browser capability declared" });
        }
        if (hostHasCapability(host, "herdr")) {
          probes.push(yield* Effect.promise(() => localBinary("herdr", run)));
        }
        if (hostHasCapability(host, "hermes")) {
          probes.push(yield* Effect.promise(() => localBinary("hermes", run)));
        }
        return {
          ok: probes.every((probe) => probe.ok),
          detail: probes.map((probe) => probe.detail).join(" · ") || "local host ready",
        };
      })
    : probeSshHost(ssh, host).pipe(
        Effect.map((result) => ({
          ok: result.status === "ok",
          detail: result.detail,
        })),
      );
