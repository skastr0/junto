import { Effect } from "effect";
import type { ServiceCheck } from "@shared/contracts";
import type { RemoteHost } from "@shared/remote-hosts";
import { parseHostSshRoute } from "../ssh/domain";
import { formatSshFailure } from "../ssh/format";
import type { SshTransportShape } from "../ssh/service";
import type { HostsRegistry } from "./registry";

export type RemoteHostsDoctorSnapshot = {
  readonly check: ServiceCheck;
  readonly observations: ReadonlyArray<{
    readonly hostId: string;
    readonly endpoint: string;
    readonly source: "live";
    readonly reachability: "reachable" | "unreachable";
    readonly reachabilityError?: string;
  }>;
};

/** Reachability only. A successful SSH connection does not prove Junto is running. */
export const testHostConnection = (ssh: SshTransportShape, host: RemoteHost) =>
  host.isThisMachine
    ? Effect.succeed({ ok: true, detail: "This machine is available", reachability: "reachable" as const })
    : parseHostSshRoute(host).pipe(
        Effect.flatMap((target) => ssh.warm(target)),
        Effect.as({ ok: true, detail: "SSH is available", reachability: "reachable" as const }),
        Effect.catch((error) => Effect.succeed({
          ok: false,
          detail: formatSshFailure(error),
          reachability: "unreachable" as const,
        })),
      );

export const runRemoteHostsDoctorSnapshot = (
  registry: HostsRegistry,
  ssh: SshTransportShape,
): Effect.Effect<RemoteHostsDoctorSnapshot> =>
  Effect.gen(function* () {
    const hosts = yield* Effect.tryPromise({
      try: () => registry.list(),
      catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
    });
    const remotes = hosts.filter((host) => !host.isThisMachine);
    const results = yield* Effect.forEach(remotes, (host) =>
      testHostConnection(ssh, host).pipe(Effect.map((result) => ({ host, result }))),
      { concurrency: 4 },
    );
    return {
      check: {
        id: "remote-hosts",
        label: "Machines",
        status: results.every(({ result }) => result.ok) ? "ok" : "warning",
        detail: results.length === 0 ? "This machine is available" :
          results.map(({ host, result }) => `${host.label}: ${result.detail}`).join(", "),
        metadata: { hostCount: String(hosts.length), remoteHostCount: String(remotes.length) },
      },
      observations: results.map(({ host, result }) => ({
        hostId: host.id,
        endpoint: host.sshEndpoint ?? "",
        source: "live" as const,
        reachability: result.reachability,
        ...(result.ok ? {} : { reachabilityError: result.detail }),
      })),
    } satisfies RemoteHostsDoctorSnapshot;
  }).pipe(Effect.catch((error) => Effect.succeed({
    check: { id: "remote-hosts", label: "Machines", status: "error" as const, detail: error.message },
    observations: [],
  })));

export const runRemoteHostsDoctor = (registry: HostsRegistry, ssh: SshTransportShape) =>
  runRemoteHostsDoctorSnapshot(registry, ssh).pipe(Effect.map((snapshot) => snapshot.check));
