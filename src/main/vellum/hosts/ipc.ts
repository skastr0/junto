import type { IpcMain } from "electron";
import { BrowserWindow } from "electron";
import { Effect } from "effect";
import { IPC_CHANNELS } from "@shared/ipc";
import type {
  DiscoveredPeer,
  BoxAvailabilityResult,
  BoxFleetResource,
  BoxFleetResult,
  HostsDiscoverPeersResult,
  HostsOpResult,
  HostsTestResult,
} from "@shared/ipc";
import {
  getDeployJob,
  listDeployJobs,
  subscribeDeployJobs,
} from "./deploy-job-registry";
import { RemoteHostsError, type RemoteHost } from "@shared/remote-hosts";
import { endpointHostToken, type TailscalePeer } from "@shared/tailscale-peers";
import { AppRuntime } from "../../runtime";
import { SettingsService } from "../settings/service";
import { makeHostsOperatorCoordinator } from "./operator-coordinator";
import { HostsService } from "./service";
import { tailscalePeerCache } from "./tailscale-peers";
import {
  HOST_OPERATION_ADMISSIONS,
  HostOperationShutdownRefused,
  hostOperationGate,
  type HostOperationGate,
} from "./shutdown";
import { RELEASE_CAPABILITIES } from "@shared/release-capabilities";
import { computeDeployCapabilities } from "@shared/deploy-capabilities";
import { StationFleetTargetRepository } from "../station/fleet-target-repository";
import {
  BoxFleetService,
  BoxActivityPolicy,
  type BoxResourceType,
} from "../box";

export {
  decodeHostsDeployRemoteInput,
  projectDeployRemoteResult,
} from "./operator-coordinator";

const pruneFleetTargetsAgainstHosts = (
  hosts: ReadonlyArray<RemoteHost>,
): Effect.Effect<void, RemoteHostsError, StationFleetTargetRepository> =>
  Effect.gen(function* () {
    const fleetTargets = yield* StationFleetTargetRepository;
    const targets = yield* fleetTargets.list.pipe(
      Effect.mapError(
        (error) =>
          new RemoteHostsError(
            "io",
            `fleet targets could not be reconciled: ${error._tag}`,
          ),
      ),
    );
    for (const target of targets) {
      const host = hosts.find((candidate) => candidate.id === target.hostId);
      // Identity is hostId + installation; route lives on the registry.
      if (host?.kind === "remote") {
        continue;
      }
      yield* fleetTargets
        .remove(target.hostId)
        .pipe(
          Effect.mapError(
            (error) =>
              new RemoteHostsError(
                "io",
                `stale fleet target could not be removed: ${error._tag}`,
              ),
          ),
        );
    }
  });

const toOp = (
  either:
    | { readonly _tag: "Right"; readonly right: ReadonlyArray<unknown> }
    | {
        readonly _tag: "Left";
        readonly left: RemoteHostsError;
      },
): HostsOpResult => {
  if (either._tag === "Success") {
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

const projectBoxResource = (resource: BoxResourceType): BoxFleetResource => ({
  boxId: resource.machine.id,
  ...(resource.hostId ? { hostId: resource.hostId } : {}),
  name: resource.machine.name,
  ip: resource.machine.ip,
  state: resource.machine.state,
  createdAt: resource.machine.createdAt,
  updatedAt: resource.machine.updatedAt,
  enrolledAt: resource.enrolledAt,
  ...(resource.sshPreparedAt ? { sshPreparedAt: resource.sshPreparedAt } : {}),
  ...(resource.sshVerifiedAt ? { sshVerifiedAt: resource.sshVerifiedAt } : {}),
});

const boxFailure = (error: unknown): BoxFleetResult => ({
  ok: false,
  ...(typeof error === "object" &&
  error !== null &&
  "boxId" in error &&
  typeof error.boxId === "string"
    ? { recoveryBoxId: error.boxId }
    : {}),
  ...(typeof error === "object" &&
  error !== null &&
  "stage" in error &&
  typeof error.stage === "string"
    ? { provisioningStage: error.stage }
    : {}),
  code:
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    typeof error._tag === "string"
      ? error._tag
      : "box_error",
  message:
    typeof error === "object" &&
    error !== null &&
    "detail" in error &&
    typeof error.detail === "string"
      ? error.detail
      : error instanceof Error
        ? error.message
        : String(error),
});

export const registerHostsIpc = (
  ipcMain: IpcMain,
  operations: HostOperationGate = hostOperationGate,
): void => {
  const operatorCoordinator = makeHostsOperatorCoordinator(operations);

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

  ipcMain.handle(IPC_CHANNELS.boxAvailability, () =>
    surfaceShutdownRefusal(
      operations.run<BoxAvailabilityResult>(
        HOST_OPERATION_ADMISSIONS.boxAvailability,
        () =>
          AppRuntime.runPromise(
            Effect.gen(function* () {
              const boxes = yield* BoxFleetService;
              const status = yield* boxes.availability;
              return {
                ok: true,
                ...status,
              } as BoxAvailabilityResult;
            }),
          ),
      ),
      (error) =>
        ({
          ok: false,
          available: false,
          authenticated: false,
          healthy: false,
          detail: error.message,
          message: error.message,
        }) satisfies BoxAvailabilityResult,
    ),
  );

  ipcMain.handle(IPC_CHANNELS.boxListOwned, () =>
    surfaceShutdownRefusal(
      operations.run(HOST_OPERATION_ADMISSIONS.boxListOwned, () =>
        AppRuntime.runPromise(
          Effect.gen(function* () {
            const boxes = yield* BoxFleetService;
            const result = yield* Effect.result(boxes.list);
            return result._tag === "Success"
              ? ({
                  ok: true,
                  boxes: result.success.map(projectBoxResource),
                } satisfies BoxFleetResult)
              : boxFailure(result.failure);
          }),
        ),
      ),
      (error) => boxFailure(error),
    ),
  );

  ipcMain.handle(IPC_CHANNELS.boxCreate, () =>
    surfaceShutdownRefusal(
      operations.run(HOST_OPERATION_ADMISSIONS.boxCreate, () =>
        AppRuntime.runPromise(
          Effect.gen(function* () {
            const boxes = yield* BoxFleetService;
            const activity = yield* BoxActivityPolicy;
            const result = yield* Effect.result(boxes.create());
            if (result._tag === "Success") activity.request();
            return result._tag === "Success"
              ? ({
                  ok: true,
                  box: projectBoxResource(result.success),
                } satisfies BoxFleetResult)
              : boxFailure(result.failure);
          }),
        ),
      ),
      (error) => boxFailure(error),
    ),
  );

  ipcMain.handle(IPC_CHANNELS.boxRefresh, (_event, boxId: unknown) =>
    surfaceShutdownRefusal(
      operations.run(HOST_OPERATION_ADMISSIONS.boxRefresh, () =>
        AppRuntime.runPromise(
          Effect.gen(function* () {
            if (typeof boxId !== "string" || boxId.length === 0) {
              return {
                ok: false,
                code: "validation",
                message: "Box id required",
              } satisfies BoxFleetResult;
            }
            const boxes = yield* BoxFleetService;
            const activity = yield* BoxActivityPolicy;
            const result = yield* Effect.result(boxes.refresh(boxId));
            if (result._tag === "Success") activity.request();
            return result._tag === "Success"
              ? ({
                  ok: true,
                  box: projectBoxResource(result.success),
                } satisfies BoxFleetResult)
              : boxFailure(result.failure);
          }),
        ),
      ),
      (error) => boxFailure(error),
    ),
  );

  ipcMain.handle(IPC_CHANNELS.boxStop, (_event, boxId: unknown) =>
    surfaceShutdownRefusal(
      operations.run(HOST_OPERATION_ADMISSIONS.boxStop, () =>
        AppRuntime.runPromise(
          Effect.gen(function* () {
            if (typeof boxId !== "string" || boxId.length === 0) {
              return {
                ok: false,
                code: "validation",
                message: "Box id required",
              } satisfies BoxFleetResult;
            }
            const boxes = yield* BoxFleetService;
            const activity = yield* BoxActivityPolicy;
            const result = yield* Effect.result(boxes.stop(boxId));
            if (result._tag === "Success") activity.request();
            return result._tag === "Success"
              ? ({
                  ok: true,
                  box: projectBoxResource(result.success),
                } satisfies BoxFleetResult)
              : boxFailure(result.failure);
          }),
        ),
      ),
      (error) => boxFailure(error),
    ),
  );

  ipcMain.handle(IPC_CHANNELS.boxPrepareSsh, (_event, boxId: unknown) =>
    surfaceShutdownRefusal(
      operations.run(HOST_OPERATION_ADMISSIONS.boxPrepareSsh, () =>
        AppRuntime.runPromise(
          Effect.gen(function* () {
            if (typeof boxId !== "string" || boxId.length === 0) {
              return {
                ok: false,
                code: "validation",
                message: "Box id required",
              } satisfies BoxFleetResult;
            }
            const boxes = yield* BoxFleetService;
            const result = yield* Effect.result(boxes.prepareSsh(boxId));
            return result._tag === "Success"
              ? ({
                  ok: true,
                  box: projectBoxResource(result.success),
                } satisfies BoxFleetResult)
              : boxFailure(result.failure);
          }),
        ),
      ),
      (error) => boxFailure(error),
    ),
  );

  ipcMain.handle(IPC_CHANNELS.boxResume, (_event, boxId: unknown) =>
    surfaceShutdownRefusal(
      operations.run(HOST_OPERATION_ADMISSIONS.boxResume, () =>
        AppRuntime.runPromise(
          Effect.gen(function* () {
            if (typeof boxId !== "string" || boxId.length === 0) {
              return {
                ok: false,
                code: "validation",
                message: "Box id required",
              } satisfies BoxFleetResult;
            }
            const boxes = yield* BoxFleetService;
            const activity = yield* BoxActivityPolicy;
            const result = yield* Effect.result(boxes.resume(boxId));
            if (result._tag === "Success") activity.request();
            return result._tag === "Success"
              ? ({
                  ok: true,
                  box: projectBoxResource(result.success),
                } satisfies BoxFleetResult)
              : boxFailure(result.failure);
          }),
        ),
      ),
      (error) => boxFailure(error),
    ),
  );

  ipcMain.handle(IPC_CHANNELS.boxDetach, (_event, boxId: unknown) =>
    surfaceShutdownRefusal(
      operations.run(HOST_OPERATION_ADMISSIONS.boxDetach, () =>
        AppRuntime.runPromise(
          Effect.gen(function* () {
            if (typeof boxId !== "string" || boxId.length === 0) {
              return {
                ok: false,
                code: "validation",
                message: "Box id required",
              } satisfies BoxFleetResult;
            }
            const boxes = yield* BoxFleetService;
            const result = yield* Effect.result(boxes.detach(boxId));
            return result._tag === "Success"
              ? ({ ok: true } satisfies BoxFleetResult)
              : boxFailure(result.failure);
          }),
        ),
      ),
      (error) => boxFailure(error),
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
            // Doctrine: only Command Center authors fleet enrollment topology.
            const settings = yield* SettingsService;
            const current = yield* settings.get;
            if (current.station.role !== "command-center") {
              return {
                ok: false,
                code: "validation",
                message:
                  "Only a Command Center with established protected topology may mutate the host registry",
              } satisfies HostsOpResult;
            }
            const hosts = yield* HostsService;
            const result = yield* Effect.result(hosts.upsert(input));
            if (result._tag === "Success") {
              const reconciled = yield* Effect.result(
                pruneFleetTargetsAgainstHosts(result.success),
              );
              if (reconciled._tag === "Failure") {
                return {
                  ok: false,
                  code: reconciled.failure.code,
                  message: reconciled.failure.message,
                } satisfies HostsOpResult;
              }
            }
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
            const settings = yield* SettingsService;
            const current = yield* settings.get;
            if (current.station.role !== "command-center") {
              return {
                ok: false,
                code: "validation",
                message:
                  "Only a Command Center with established protected topology may mutate the host registry",
              } satisfies HostsOpResult;
            }
            if (typeof id !== "string" || id.length === 0) {
              return {
                ok: false,
                code: "validation",
                message: "host id required",
              } satisfies HostsOpResult;
            }
            const fleetTargets = yield* StationFleetTargetRepository;
            const targetRemoved = yield* Effect.result(fleetTargets.remove(id));
            if (targetRemoved._tag === "Failure") {
              return {
                ok: false,
                code: "io",
                message: `fleet target could not be removed: ${targetRemoved.failure._tag}`,
              } satisfies HostsOpResult;
            }
            // Box-owned hosts: also drop ownership so the Box panel + Fleet
            // stay consistent (stop alone no longer unenrolls).
            const boxes = yield* BoxFleetService;
            const owned = yield* Effect.result(
              boxes.list.pipe(
                Effect.map((list) =>
                  list.find((resource) => resource.hostId === id),
                ),
              ),
            );
            if (owned._tag === "Success" && owned.success !== undefined) {
              const detached = yield* Effect.result(
                boxes.detach(owned.success.machine.id),
              );
              if (detached._tag === "Failure") {
                return {
                  ok: false,
                  code: "io",
                  message:
                    detached.failure instanceof Error
                      ? detached.failure.message
                      : "Box could not be detached from Vellum Command",
                } satisfies HostsOpResult;
              }
              // detach already removed host_registry; reload list for caller.
              const hosts = yield* HostsService;
              const remaining = yield* Effect.result(hosts.list);
              return toOp(remaining as never);
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
            // Box IPs churn on stop/resume — refresh provider route before probe.
            const boxes = yield* BoxFleetService;
            yield* boxes.ensureHostAvailable(id).pipe(Effect.ignore);
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
                ...(result.success.protocol === undefined
                  ? {}
                  : { protocol: result.success.protocol }),
                ...(result.success.linuxCapabilities === undefined
                  ? {}
                  : { linuxCapabilities: result.success.linuxCapabilities }),
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

  // Install / configure Vellum Command Remote on a registered host over existing SSH.
  // Only the Command Center may push remote station stamps (no reverse RPC).
  ipcMain.handle(IPC_CHANNELS.hostsConfigureRemote, (_event, id: unknown) =>
    operatorCoordinator.configureRemote(typeof id === "string" ? id : ""),
  );

  // Effective deploy capabilities (RELEASE ∩ operator kill-switch ∩ role).
  // Computed straight from settings: there is no install plane behind this.
  ipcMain.handle(IPC_CHANNELS.hostsDeployCapabilities, () =>
    surfaceShutdownRefusal(
      operations.run(HOST_OPERATION_ADMISSIONS.configureRemote, () =>
        AppRuntime.runPromise(
          Effect.gen(function* () {
            const settingsSvc = yield* SettingsService;
            const doc = yield* settingsSvc.get;
            // Global Fleet surface (no target platform yet). Per-target Linux
            // / Darwin freezes apply when deploy resolves remote uname.
            return computeDeployCapabilities({
              stationRole: doc.station.role,
              remoteManagedInstalls: doc.fleet.remoteManagedInstalls,
              release: RELEASE_CAPABILITIES,
            });
          }).pipe(
            Effect.catch((error) =>
              Effect.succeed({
                ok: false as const,
                code: "io" as const,
                message: error instanceof Error ? error.message : String(error),
              }),
            ),
          ),
        ),
      ),
      (error) => ({
        ok: false as const,
        code: "io" as const,
        message: error.message,
      }),
    ),
  );

  const broadcastDeployJob = (job: ReturnType<typeof getDeployJob>) => {
    if (job === undefined) return;
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed() || window.webContents.isDestroyed()) continue;
      try {
        window.webContents.send(IPC_CHANNELS.hostsDeployJobChanged, job);
      } catch (error) {
        console.error(
          `[hosts-ipc] broadcast ${IPC_CHANNELS.hostsDeployJobChanged} failed for window ${window.id}:`,
          error,
        );
      }
    }
  };
  const unsubscribeDeployJobs = subscribeDeployJobs((job) => {
    broadcastDeployJob(job);
  });
  void unsubscribeDeployJobs;

  ipcMain.handle(IPC_CHANNELS.hostsDeployJobGet, (_event, hostId: unknown) => {
    if (typeof hostId !== "string" || hostId.length === 0) return null;
    return getDeployJob(hostId) ?? null;
  });
  ipcMain.handle(IPC_CHANNELS.hostsDeployJobsList, () => listDeployJobs());

  ipcMain.handle(IPC_CHANNELS.hostsDeployRemote, (_event, input: unknown) =>
    operatorCoordinator.deployRemote(input),
  );
};
