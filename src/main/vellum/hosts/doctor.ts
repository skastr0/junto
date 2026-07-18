import { access } from "node:fs/promises";
import { constants } from "node:fs";
import type { Context } from "effect";
import { Effect } from "effect";
import type { ServiceCheck } from "@shared/contracts";
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

const probeSshHost = (
  ssh: Ssh,
  host: RemoteHost,
): Effect.Effect<{
  readonly status: "ok" | "warning" | "error";
  readonly detail: string;
}> =>
  Effect.gen(function* () {
    if (!host.endpoint) {
      return {
        status: "error" as const,
        detail: `${host.id}: remote host missing endpoint`,
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
      };
    }

    const parts: string[] = [`auth ok · home ${homePath}`];
    let warnings = 0;

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
    };
  }).pipe(
    Effect.catchAll((error) =>
      Effect.succeed({
        status: "error" as const,
        detail: `${host.label}: ${
          error && typeof error === "object" && "_tag" in error
            ? describeSshError(error as SshError)
            : String(error)
        }`,
      }),
    ),
  );

const boundedProbeSshHost = (
  ssh: Ssh,
  host: RemoteHost,
): Effect.Effect<{
  readonly status: "ok" | "warning" | "error";
  readonly detail: string;
}> =>
  probeSshHost(ssh, host).pipe(
    Effect.timeoutFail({
      duration: HOST_PROBE_TOTAL_TIMEOUT_MS,
      onTimeout: () => new Error("remote host doctor deadline exceeded"),
    }),
    Effect.catchAll(() =>
      Effect.succeed({
        status: "error" as const,
        detail: `${host.label}: probe timed out after ${HOST_PROBE_TOTAL_TIMEOUT_MS}ms`,
      }),
    ),
  );

export const runRemoteHostsDoctor = (
  registry: HostsRegistry,
  ssh: Ssh,
  run: HostCliRunner = runCli,
): Effect.Effect<ServiceCheck> =>
  Effect.gen(function* () {
    const clientPath = openSshClientPath();
    const sshBinaryOk = yield* Effect.tryPromise({
      try: async () => {
        await access(clientPath, constants.X_OK);
        return true;
      },
      catch: () => false as const,
    }).pipe(Effect.catchAll(() => Effect.succeed(false as const)));

    if (!sshBinaryOk) {
      return {
        id: "remote-hosts",
        label: "Remote hosts",
        status: "error" as const,
        detail: `OpenSSH client not executable at ${clientPath} — install the client or set VELLUM_SSH_EXECUTABLE`,
      } satisfies ServiceCheck;
    }

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
    if (sshHosts.length === 0) {
      lines.push("no remote ssh hosts configured");
    } else {
      const results = yield* Effect.forEach(
        sshHosts,
        (host) => boundedProbeSshHost(ssh, host),
        { concurrency: "unbounded" },
      );
      for (const result of results) {
        lines.push(result.detail);
        raise(result.status);
      }
    }

    const hermesKeys = hosts
      .filter((host) => hostHasCapability(host, "hermes"))
      .map((host) => hermesKeyFor(host))
      .join(", ");

    return {
      id: "remote-hosts",
      label: "Remote hosts",
      status: worst,
      detail: lines.join(" · "),
      metadata: {
        hostsPath: registry.path(),
        hostCount: String(hosts.length),
        remoteHostCount: String(sshHosts.length),
        hermesKeys,
      },
    } satisfies ServiceCheck;
  }).pipe(
    Effect.catchAll((error) =>
      Effect.succeed({
        id: "remote-hosts",
        label: "Remote hosts",
        status: "error" as const,
        detail: error instanceof Error ? error.message : String(error),
      } satisfies ServiceCheck),
    ),
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
