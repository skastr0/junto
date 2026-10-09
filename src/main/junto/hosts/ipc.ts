import type { IpcMain } from "electron";
import { Effect, Option, Result } from "effect";
import { IPC_CHANNELS } from "@shared/ipc";
import type {
  DiscoveredPeer,
  HostsDiscoverPeersResult,
  HostsOpResult,
  HostsTestResult,
} from "@shared/ipc";
import { RemoteHostsError, type RemoteHost } from "@shared/remote-hosts";
import { endpointHostToken, type TailscalePeer } from "@shared/tailscale-peers";
import { AppRuntime } from "../../runtime";
import { HostsService } from "./service";
import { MachineOwnerControl } from "./machine-owner";
import { dispatchMachineIpcCommand } from "./machine-ipc-command";
import { OPERATOR_PROTOCOL_VERSION, type OperatorResponseEnvelope } from "@shared/operator-control";
import { tailscalePeerCache } from "./tailscale-peers";
import {
  HOST_OPERATION_ADMISSIONS,
  HostOperationShutdownRefused,
  hostOperationGate,
  type HostOperationGate,
} from "./shutdown";
const toOp = (
  either: Result.Result<ReadonlyArray<unknown>, RemoteHostsError>,
): HostsOpResult => {
  if (Result.isSuccess(either)) {
    return { ok: true, hosts: either.success as HostsOpResult["hosts"] };
  }
  return { ok: false, code: either.failure.code, message: either.failure.message };
};

const surfaceShutdownRefusal = <A>(
  operation: Promise<A>,
  refusal: (error: HostOperationShutdownRefused) => A,
): Promise<A> =>
  operation.catch((error: unknown) => {
    if (error instanceof HostOperationShutdownRefused) return refusal(error);
    throw error;
  });

const stripDnsDots = (value: string): string => value.replace(/\.+$/, "");

const firstDnsLabelOf = (value: string): string =>
  stripDnsDots(value.trim().toLowerCase()).split(".")[0] ?? "";

/** Lowercase tokens that identify an enrolled host (id, hermesId, endpoint). */
const enrolledTokens = (
  hosts: ReadonlyArray<RemoteHost>,
): ReadonlySet<string> => {
  const tokens = new Set<string>();
  for (const host of hosts) {
    tokens.add(host.id.toLowerCase());
    if (host.hermesId) tokens.add(host.hermesId.toLowerCase());
    const endpointToken = endpointHostToken(host.sshEndpoint);
    if (endpointToken) {
      tokens.add(endpointToken.toLowerCase());
      const label = firstDnsLabelOf(endpointToken);
      if (label) tokens.add(label);
    }
  }
  return tokens;
};

const peerIsEnrolled = (
  peer: TailscalePeer,
  tokens: ReadonlySet<string>,
): boolean => {
  if (peer.hostName && tokens.has(peer.hostName.trim().toLowerCase())) {
    return true;
  }
  if (peer.dnsName) {
    const dns = stripDnsDots(peer.dnsName.trim().toLowerCase());
    if (tokens.has(dns) || tokens.has(firstDnsLabelOf(peer.dnsName))) {
      return true;
    }
  }
  return peer.ipv4 !== undefined && tokens.has(peer.ipv4);
};

const toDiscoveredPeer = (peer: TailscalePeer): DiscoveredPeer | undefined => {
  const dns = peer.dnsName ? stripDnsDots(peer.dnsName.trim()) : undefined;
  const name =
    peer.hostName?.trim() ||
    (peer.dnsName ? firstDnsLabelOf(peer.dnsName) : "") ||
    peer.ipv4;
  if (!name) return undefined;
  const addresses = [dns, peer.ipv4].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  return {
    name,
    addresses,
    online: peer.online === true,
    ...(peer.os ? { os: peer.os } : {}),
  };
};

const DISCOVER_PEERS_EMPTY: HostsDiscoverPeersResult = {
  ok: true,
  peers: [],
};

export const registerHostsIpc = (
  ipcMain: IpcMain,
  operations: HostOperationGate = hostOperationGate,
): void => {

  ipcMain.handle(IPC_CHANNELS.machineCommand, (event, input: unknown) =>
    AppRuntime.runPromise(Effect.gen(function* () {
      const actions = yield* Effect.serviceOption(MachineOwnerControl);
      if (Option.isNone(actions)) return {
        protocol: OPERATOR_PROTOCOL_VERSION, ok: false,
        error: { type: "runtime_down", message: "Machine control is not ready", details: { retryable: false } },
      } satisfies OperatorResponseEnvelope;
      return yield* dispatchMachineIpcCommand(actions.value, input, progress => {
        if (!event.sender.isDestroyed()) event.sender.send(IPC_CHANNELS.machineProgress, progress);
      });
    })),
  );

  ipcMain.handle(IPC_CHANNELS.hostsList, () =>
    surfaceShutdownRefusal(
      operations.run(HOST_OPERATION_ADMISSIONS.list, () =>
        AppRuntime.runPromise(
          Effect.gen(function* () {
            const hosts = yield* HostsService;
            const result = yield* Effect.result(hosts.list);
            return toOp(result as never);
          }),
        ),
      ),
      (error) => ({ ok: false, code: error.code, message: error.message }),
    ),
  );

  // Tailscale mesh peers not yet enrolled. Read path — mirrors hostsList
  // gating (registry-read admission). Degrades to an empty peer list; the
  // tailscale CLI being absent is never an error surface.
  ipcMain.handle(IPC_CHANNELS.hostsDiscoverPeers, () =>
    surfaceShutdownRefusal(
      operations.run(HOST_OPERATION_ADMISSIONS.list, () =>
        AppRuntime.runPromise(
          Effect.gen(function* () {
            const hosts = yield* HostsService;
            const listed = yield* Effect.result(hosts.list);
            const enrolled =
              listed._tag === "Success"
                ? enrolledTokens(listed.success)
                : new Set<string>();
            const snapshot = yield* Effect.promise(() =>
              tailscalePeerCache.refresh(),
            );
            if (!snapshot) return DISCOVER_PEERS_EMPTY;
            const peers = snapshot.peers
              .filter((peer) => !peerIsEnrolled(peer, enrolled))
              .map(toDiscoveredPeer)
              .filter((peer): peer is DiscoveredPeer => peer !== undefined);
            return { ok: true, peers } satisfies HostsDiscoverPeersResult;
          }).pipe(Effect.catch(() => Effect.succeed(DISCOVER_PEERS_EMPTY))),
        ),
      ),
      () => DISCOVER_PEERS_EMPTY,
    ),
  );

  ipcMain.handle(IPC_CHANNELS.hostsUpsert, (_event, input: unknown) =>
    surfaceShutdownRefusal(
      operations.run(HOST_OPERATION_ADMISSIONS.upsert, () =>
        AppRuntime.runPromise(
          Effect.gen(function* () {
            const hosts = yield* HostsService;
            const result = yield* Effect.result(hosts.upsert(input));
            return toOp(result as never);
          }),
        ),
      ),
      (error) => ({ ok: false, code: error.code, message: error.message }),
    ),
  );

  ipcMain.handle(IPC_CHANNELS.hostsRemove, (_event, id: unknown) =>
    surfaceShutdownRefusal(
      operations.run(HOST_OPERATION_ADMISSIONS.remove, () =>
        AppRuntime.runPromise(
          Effect.gen(function* () {
            if (typeof id !== "string" || id.length === 0) {
              return {
                ok: false,
                code: "validation",
                message: "host id required",
              } satisfies HostsOpResult;
            }
            const hosts = yield* HostsService;
            const result = yield* Effect.result(hosts.remove(id));
            return toOp(result as never);
          }),
        ),
      ),
      (error) => ({ ok: false, code: error.code, message: error.message }),
    ),
  );

  ipcMain.handle(IPC_CHANNELS.hostsTest, (_event, id: unknown) =>
    surfaceShutdownRefusal(
      operations.run(HOST_OPERATION_ADMISSIONS.test, () =>
        AppRuntime.runPromise(
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
                ...(result.success.reachability === undefined
                  ? {}
                  : { reachability: result.success.reachability }),

              } satisfies HostsTestResult;
            }
            return {
              ok: false,
              detail: result.failure.message,
              code: result.failure.code,
              message: result.failure.message,
            } satisfies HostsTestResult;
          }),
        ),
      ),
      (error) =>
        ({
          ok: false,
          detail: error.message,
          code: error.code,
          message: error.message,
        }) satisfies HostsTestResult,
    ),
  );

};
