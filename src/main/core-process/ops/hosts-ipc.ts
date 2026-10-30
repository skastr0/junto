/**
 * The machines the window reads and commands (hosts/ipc.ts), and its doctor
 * report (src/main/ipc.ts). Every answer is the envelope or result the window
 * already took; an operator command's progress is published, so the window
 * that asked hears it and no other.
 *
 * The shutdown gate around a host operation stays on main, as does routing a
 * progress event to the window whose call asked for it.
 */
import { Effect, Option } from "effect";
import type {
  DiscoveredPeer,
  HostsDiscoverPeersResult,
  HostsOpResult,
  HostsTestResult,
} from "@shared/ipc";
import type { RemoteHost } from "@shared/remote-hosts";
import { OPERATOR_PROTOCOL_VERSION, type OperatorResponseEnvelope } from "@shared/operator-control";
import { endpointHostToken, type TailscalePeer } from "@shared/tailscale-peers";
import type { StationInfo, DoctorReport } from "@shared/contracts";
import { buildDoctorReport } from "../../junto/doctor";
import { HostsService } from "../../junto/hosts/service";
import { MachineOwnerControl } from "../../junto/hosts/machine-owner";
import { dispatchMachineIpcCommand } from "../../junto/hosts/machine-ipc-command";
import { tailscalePeerCache } from "../../junto/hosts/tailscale-peers";
import { MACHINE_PROGRESS, type MachineProgressPushed } from "../channels";
import { coreOps, type CoreOp } from "../ops";
import { publish } from "../push";

declare module "../ops" {
  interface CoreOps {
    "ipc.hosts.command": CoreOp<
      { readonly input: unknown; readonly requestId: string },
      OperatorResponseEnvelope
    >;
    "ipc.hosts.list": CoreOp<Record<string, never>, HostsOpResult>;
    "ipc.hosts.discoverPeers": CoreOp<Record<string, never>, HostsDiscoverPeersResult>;
    "ipc.hosts.upsert": CoreOp<{ readonly input: unknown }, HostsOpResult>;
    "ipc.hosts.remove": CoreOp<{ readonly id: unknown }, HostsOpResult>;
    "ipc.hosts.test": CoreOp<{ readonly id: unknown }, HostsTestResult>;
    "ipc.doctor.report": CoreOp<{ readonly station: StationInfo }, DoctorReport>;
  }
}

const toOp = (either: { readonly _tag: "Success"; readonly success: ReadonlyArray<unknown> } | { readonly _tag: "Failure"; readonly failure: { readonly code: string; readonly message: string } }): HostsOpResult =>
  either._tag === "Success"
    ? { ok: true, hosts: either.success as HostsOpResult["hosts"] }
    : { ok: false, code: either.failure.code, message: either.failure.message };

const stripDnsDots = (value: string): string => value.replace(/\.+$/, "");

const firstDnsLabelOf = (value: string): string =>
  stripDnsDots(value.trim().toLowerCase()).split(".")[0] ?? "";

/** Lowercase tokens that identify an enrolled host (id, endpoint). */
const enrolledTokens = (hosts: ReadonlyArray<RemoteHost>): ReadonlySet<string> => {
  const tokens = new Set<string>();
  for (const host of hosts) {
    tokens.add(host.id.toLowerCase());
    const endpointToken = endpointHostToken(host.sshEndpoint);
    if (endpointToken) {
      tokens.add(endpointToken.toLowerCase());
      const label = firstDnsLabelOf(endpointToken);
      if (label) tokens.add(label);
    }
  }
  return tokens;
};

const peerIsEnrolled = (peer: TailscalePeer, tokens: ReadonlySet<string>): boolean => {
  if (peer.hostName && tokens.has(peer.hostName.trim().toLowerCase())) return true;
  if (peer.dnsName) {
    const dns = stripDnsDots(peer.dnsName.trim().toLowerCase());
    if (tokens.has(dns) || tokens.has(firstDnsLabelOf(peer.dnsName))) return true;
  }
  return peer.ipv4 !== undefined && tokens.has(peer.ipv4);
};

const toDiscoveredPeer = (peer: TailscalePeer): DiscoveredPeer | undefined => {
  const dns = peer.dnsName ? stripDnsDots(peer.dnsName.trim()) : undefined;
  const name = peer.hostName?.trim() || (peer.dnsName ? firstDnsLabelOf(peer.dnsName) : "") || peer.ipv4;
  if (!name) return undefined;
  const addresses = [dns, peer.ipv4].filter((value): value is string => typeof value === "string" && value.length > 0);
  return { name, addresses, online: peer.online === true, ...(peer.os ? { os: peer.os } : {}) };
};

const DISCOVER_PEERS_EMPTY: HostsDiscoverPeersResult = { ok: true, peers: [] };

coreOps({
  // An operator command with its progress: the asking window is named, so the
  // push lands in that window alone.
  "ipc.hosts.command": ({ input, requestId }) =>
    Effect.gen(function* () {
      const actions = yield* Effect.serviceOption(MachineOwnerControl);
      if (Option.isNone(actions)) {
        return {
          protocol: OPERATOR_PROTOCOL_VERSION,
          ok: false,
          error: { type: "runtime_down", message: "Machine control is not ready", details: { retryable: false } },
        } satisfies OperatorResponseEnvelope;
      }
      return yield* dispatchMachineIpcCommand(actions.value, input, (progress) =>
        publish(MACHINE_PROGRESS, { requestId, progress } satisfies MachineProgressPushed),
      );
    }),
  "ipc.hosts.list": () =>
    Effect.gen(function* () {
      const hosts = yield* HostsService;
      const result = yield* Effect.result(hosts.list);
      return toOp(result as never);
    }),
  // Tailscale mesh peers not yet enrolled. Degrades to an empty peer list; the
  // tailscale CLI being absent is never an error surface.
  "ipc.hosts.discoverPeers": () =>
    Effect.gen(function* () {
      const hosts = yield* HostsService;
      const listed = yield* Effect.result(hosts.list);
      if (listed._tag === "Failure") {
        yield* Effect.logWarning("machines could not be read; discovery cannot hide enrolled peers", listed.failure);
      }
      const enrolled = listed._tag === "Success" ? enrolledTokens(listed.success) : new Set<string>();
      const snapshot = yield* Effect.promise(() => tailscalePeerCache.refresh());
      if (!snapshot) return DISCOVER_PEERS_EMPTY;
      const peers = snapshot.peers
        .filter((peer) => !peerIsEnrolled(peer, enrolled))
        .map(toDiscoveredPeer)
        .filter((peer): peer is DiscoveredPeer => peer !== undefined);
      return { ok: true, peers } satisfies HostsDiscoverPeersResult;
    }).pipe(
      // Discovery never throws (HostsDiscoverPeersResult); a failure is logged, then no peers.
      Effect.catchCause((cause) =>
        Effect.logWarning("machine discovery failed; no peers are shown", cause).pipe(Effect.as(DISCOVER_PEERS_EMPTY)),
      ),
      Effect.annotateLogs({ area: "machines", operation: "discover-peers" }),
    ),
  "ipc.hosts.upsert": ({ input }) =>
    Effect.gen(function* () {
      const hosts = yield* HostsService;
      const result = yield* Effect.result(hosts.upsert(input));
      return toOp(result as never);
    }),
  "ipc.hosts.remove": ({ id }) =>
    Effect.gen(function* () {
      if (typeof id !== "string" || id.length === 0) {
        return { ok: false, code: "validation", message: "host id required" } satisfies HostsOpResult;
      }
      const hosts = yield* HostsService;
      const result = yield* Effect.result(hosts.remove(id));
      return toOp(result as never);
    }),
  "ipc.hosts.test": ({ id }) =>
    Effect.gen(function* () {
      if (typeof id !== "string" || id.length === 0) {
        return {
          ok: false,
          detail: "host id required",
          code: "validation",
          message: "host id required",
        } satisfies HostsTestResult;
      }
      const hosts = yield* HostsService;
      const startedAt = Date.now();
      const result = yield* Effect.result(hosts.test(id));
      const latencyMs = Date.now() - startedAt;
      if (result._tag === "Success") {
        return {
          ok: result.success.ok,
          detail: result.success.detail,
          latencyMs,
          ...(result.success.reachability === undefined ? {} : { reachability: result.success.reachability }),
        } satisfies HostsTestResult;
      }
      return {
        ok: false,
        detail: result.failure.message,
        code: result.failure.code,
        message: result.failure.message,
      } satisfies HostsTestResult;
    }),
  // The window's doctor: every service's own answer, as one document, with
  // this installation's station facts as main knows them.
  "ipc.doctor.report": ({ station }) => buildDoctorReport(station),
});
