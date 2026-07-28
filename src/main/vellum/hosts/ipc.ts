import type { IpcMain } from "electron";
import { Context, Effect } from "effect";
import { IPC_CHANNELS } from "@shared/ipc";
import type {
  DiscoveredPeer,
  BoxAvailabilityResult,
  BoxFleetResource,
  BoxFleetResult,
  HostsConfigureRemoteResult,
  HostsDeployRemoteAuthorizationRequest,
  HostsDeployRemoteInput,
  HostsDeployRemoteResult,
  HostsDiscoverPeersResult,
  HostsOpResult,
  HostsTestResult,
} from "@shared/ipc";
import { RemoteHostsError, type RemoteHost } from "@shared/remote-hosts";
import {
  endpointHostToken,
  type TailscalePeer,
} from "@shared/tailscale-peers";
import { deployRecordFromResult } from "@shared/station-status";
import { AppRuntime } from "../../runtime";
import { SettingsService } from "../settings/service";
import { StationStatusService } from "../station-status-store";
import type { ConfiguredRemoteDeployResult } from "./deploy-configured-remote";
import type { ConfigureRemoteOptions } from "./configure-remote";
import {
  destroyLinuxAdministratorCredential,
  mintLinuxAdministratorCredential,
  type LinuxAdministratorCredentialBinding,
} from "./linux-administrator-credential";
import type { RemoteDeploymentAuthorization } from "./remote-deployment";
import { HostsService } from "./service";
import { tailscalePeerCache } from "./tailscale-peers";
import {
  HOST_OPERATION_ADMISSIONS,
  HostOperationShutdownRefused,
  hostOperationGate,
  type HostOperationGate,
} from "./shutdown";
import {
  MANAGED_REMOTE_DEPLOY_DISABLED_DETAIL,
  RELEASE_CAPABILITIES,
} from "@shared/release-capabilities";
import { computeDeployCapabilities } from "@shared/deploy-capabilities";
import { PrismService } from "../../services/prism";
import { StationRepository } from "../station/repository";
import type { InstallationId } from "@shared/station-api";
import { StationFleetTargetRepository } from "../station/fleet-target-repository";
import {
  BoxFleetService,
  type BoxResourceType,
} from "../box";

const resolveCommandCenterConfigureOptions = (
  supervisedPreferred = true,
): Effect.Effect<
  ConfigureRemoteOptions,
  RemoteHostsError,
  PrismService | StationRepository
> =>
  Effect.gen(function* () {
    const prism = yield* PrismService;
    const stations = yield* StationRepository;
    const commandCenterInstallationId = yield* stations.installationId;
    const stationInfo = yield* prism.stationInfo;
    return {
      commandCenterInstallationId,
      appVersion: stationInfo.version,
      supervisedPreferred,
    };
  }).pipe(
    Effect.mapError((error) =>
      error instanceof RemoteHostsError
        ? error
        : new RemoteHostsError(
            "io",
            error instanceof Error ? error.message : String(error),
          )
    ),
  );

const bindConfiguredRemoteTarget = (
  hosts: Context.Tag.Service<typeof HostsService>,
  hostId: string,
  stationInstallationId: InstallationId,
): Effect.Effect<
  void,
  RemoteHostsError,
  StationFleetTargetRepository
> =>
  Effect.gen(function* () {
    const host = yield* hosts.get(hostId);
    if (
      host === undefined ||
      host.kind !== "remote" ||
      host.sshEndpoint === undefined
    ) {
      return yield* Effect.fail(
        new RemoteHostsError(
          "conflict",
          `configured Station ${hostId} no longer has an enrolled Remote endpoint`,
        ),
      );
    }
    const fleetTargets = yield* StationFleetTargetRepository;
    yield* fleetTargets
      .bind({
        hostId: host.id,
        stationInstallationId,
      })
      .pipe(
        Effect.mapError(
          (error) =>
            new RemoteHostsError(
              "conflict",
              `configured Station target could not be admitted: ${error._tag}`,
            ),
        ),
      );
  });

const pruneFleetTargetsAgainstHosts = (
  hosts: ReadonlyArray<RemoteHost>,
): Effect.Effect<
  void,
  RemoteHostsError,
  StationFleetTargetRepository
> =>
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
      yield* fleetTargets.remove(target.hostId).pipe(
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

const deploymentFleetBindingFailure = (
  deploy: ConfiguredRemoteDeployResult,
  detail: string,
): ConfiguredRemoteDeployResult => ({
  ...deploy,
  ok: false,
  detail: `${deploy.detail} · ${detail}`,
  message: `${deploy.message ?? deploy.detail} · ${detail}`,
  outcome: "indeterminate",
  statusRecorded: false,
});

const toOp = (
  either: { readonly _tag: "Right"; readonly right: ReadonlyArray<unknown> } | {
    readonly _tag: "Left";
    readonly left: RemoteHostsError;
  },
): HostsOpResult => {
  if (either._tag === "Right") {
    return { ok: true, hosts: either.right as HostsOpResult["hosts"] };
  }
  return { ok: false, code: either.left.code, message: either.left.message };
};

const surfaceShutdownRefusal = <A>(
  operation: Promise<A>,
  refusal: (error: HostOperationShutdownRefused) => A,
): Promise<A> =>
  operation.catch((error: unknown) => {
    if (error instanceof HostOperationShutdownRefused) return refusal(error);
    throw error;
  });

type DecodedHostsDeployRemoteInput = HostsDeployRemoteInput;

const exactKeys = (
  value: Record<string, unknown>,
  expected: ReadonlyArray<string>,
): boolean => {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
};

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const decodeAuthorizationRequest = (
  value: unknown,
): HostsDeployRemoteAuthorizationRequest | undefined => {
  const input = record(value);
  if (
    input === undefined ||
    !exactKeys(input, [
      "kind",
      "hostId",
      "endpoint",
      "version",
      "manifestSha256",
      "debSha256",
      "inventorySha256",
    ]) ||
    input.kind !== "linux-administrator-password" ||
    typeof input.hostId !== "string" ||
    typeof input.endpoint !== "string" ||
    typeof input.version !== "string" ||
    typeof input.manifestSha256 !== "string" ||
    typeof input.debSha256 !== "string" ||
    typeof input.inventorySha256 !== "string"
  ) {
    return undefined;
  }
  return {
    kind: "linux-administrator-password",
    hostId: input.hostId,
    endpoint: input.endpoint,
    version: input.version,
    manifestSha256: input.manifestSha256,
    debSha256: input.debSha256,
    inventorySha256: input.inventorySha256,
  };
};

export const decodeHostsDeployRemoteInput = (
  value: unknown,
): DecodedHostsDeployRemoteInput | undefined => {
  const input = record(value);
  if (
    input === undefined ||
    (exactKeys(input, ["id"]) === false &&
      exactKeys(input, ["id", "authorization"]) === false) ||
    typeof input.id !== "string" ||
    input.id.length === 0
  ) {
    return undefined;
  }
  if (!Object.hasOwn(input, "authorization")) {
    return "authorization" in input ? undefined : { id: input.id };
  }

  const authorization = record(input.authorization);
  if (
    authorization === undefined ||
    !exactKeys(authorization, ["request", "password"]) ||
    typeof authorization.password !== "string"
  ) {
    return undefined;
  }
  const request = decodeAuthorizationRequest(authorization.request);
  if (request === undefined || request.hostId !== input.id) return undefined;
  return {
    id: input.id,
    authorization: {
      request,
      password: authorization.password,
    },
  };
};

const credentialBinding = (
  request: HostsDeployRemoteAuthorizationRequest,
): LinuxAdministratorCredentialBinding => ({
  hostId: request.hostId,
  // The credential constructor validates the branded endpoint before storing
  // any password bytes; this cast only preserves the exact serialized value.
  endpoint:
    request.endpoint as LinuxAdministratorCredentialBinding["endpoint"],
  version: request.version,
  manifestSha256: request.manifestSha256,
  debSha256: request.debSha256,
  inventorySha256: request.inventorySha256,
});

class LinuxAdministratorAuthorizationInputError extends Error {
  readonly _tag: "LinuxAdministratorAuthorizationInputError" =
    "LinuxAdministratorAuthorizationInputError";
}

/**
 * Mint one opaque main-only credential and destroy it after the sole attempt,
 * regardless of success, failure, or interruption.
 */
export const withHostsDeployRemoteAuthorization = <A, E, R>(
  input: DecodedHostsDeployRemoteInput,
  use: (
    authorization: RemoteDeploymentAuthorization | undefined,
  ) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | LinuxAdministratorAuthorizationInputError, R> => {
  if (!("authorization" in input)) return use(undefined);
  const request = input.authorization.request;
  return Effect.acquireUseRelease(
    Effect.try({
      try: () =>
        mintLinuxAdministratorCredential(
          input.authorization.password,
          credentialBinding(request),
        ),
      catch: () =>
        new LinuxAdministratorAuthorizationInputError(
          "Linux administrator authorization is invalid",
        ),
    }),
    (credential) =>
      use({
        kind: "linux-administrator-password",
        credential,
      }),
    (credential) =>
      Effect.sync(() => {
        destroyLinuxAdministratorCredential(credential);
      }),
  );
};

export const projectDeployRemoteResult = (
  deploy: ConfiguredRemoteDeployResult,
): HostsDeployRemoteResult => ({
  ok: deploy.ok,
  detail: deploy.detail,
  code: deploy.code,
  message: deploy.message ?? deploy.detail,
  stages: deploy.stages,
  outcome: deploy.outcome,
  packageState: deploy.packageState,
  role: deploy.role,
  version: deploy.version,
  lastSeen: deploy.lastSeen,
  statusRecorded: deploy.statusRecorded ?? false,
  ...(deploy.recoveryAction === undefined
    ? {}
    : { recoveryAction: deploy.recoveryAction }),
  ...(deploy.authorizationRequest === undefined
    ? {}
    : { authorizationRequest: deploy.authorizationRequest }),
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
  const name = peer.hostName?.trim() ||
    (peer.dnsName ? firstDnsLabelOf(peer.dnsName) : "") ||
    peer.ipv4;
  if (!name) return undefined;
  const addresses = [dns, peer.ipv4].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  return { name, addresses, online: peer.online === true, ...(peer.os ? { os: peer.os } : {}) };
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
  ...(resource.sshPreparedAt
    ? { sshPreparedAt: resource.sshPreparedAt }
    : {}),
  ...(resource.sshVerifiedAt
    ? { sshVerifiedAt: resource.sshVerifiedAt }
    : {}),
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
  ipcMain.handle(IPC_CHANNELS.hostsList, () =>
    surfaceShutdownRefusal(
      operations.run(HOST_OPERATION_ADMISSIONS.list, () =>
        AppRuntime.runPromise(
          Effect.gen(function* () {
            const hosts = yield* HostsService;
            const result = yield* Effect.either(hosts.list);
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
              return ({
                ok: true,
                ...status,
              }) as BoxAvailabilityResult;
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
            const result = yield* Effect.either(boxes.list);
            return result._tag === "Right"
              ? {
                  ok: true,
                  boxes: result.right.map(projectBoxResource),
                } satisfies BoxFleetResult
              : boxFailure(result.left);
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
            const result = yield* Effect.either(boxes.create());
            return result._tag === "Right"
              ? {
                  ok: true,
                  box: projectBoxResource(result.right),
                } satisfies BoxFleetResult
              : boxFailure(result.left);
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
            const result = yield* Effect.either(boxes.refresh(boxId));
            return result._tag === "Right"
              ? {
                  ok: true,
                  box: projectBoxResource(result.right),
                } satisfies BoxFleetResult
              : boxFailure(result.left);
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
            const result = yield* Effect.either(boxes.stop(boxId));
            return result._tag === "Right"
              ? {
                  ok: true,
                  box: projectBoxResource(result.right),
                } satisfies BoxFleetResult
              : boxFailure(result.left);
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
            const result = yield* Effect.either(boxes.prepareSsh(boxId));
            return result._tag === "Right"
              ? {
                  ok: true,
                  box: projectBoxResource(result.right),
                } satisfies BoxFleetResult
              : boxFailure(result.left);
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
            const result = yield* Effect.either(boxes.resume(boxId));
            return result._tag === "Right"
              ? {
                  ok: true,
                  box: projectBoxResource(result.right),
                } satisfies BoxFleetResult
              : boxFailure(result.left);
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
            const listed = yield* Effect.either(hosts.list);
            const enrolled =
              listed._tag === "Right" ? enrolledTokens(listed.right) : new Set<string>();
            const snapshot = yield* Effect.promise(() =>
              tailscalePeerCache.refresh(),
            );
            if (!snapshot) return DISCOVER_PEERS_EMPTY;
            const peers = snapshot.peers
              .filter((peer) => !peerIsEnrolled(peer, enrolled))
              .map(toDiscoveredPeer)
              .filter((peer): peer is DiscoveredPeer => peer !== undefined);
            return { ok: true, peers } satisfies HostsDiscoverPeersResult;
          }).pipe(Effect.catchAll(() => Effect.succeed(DISCOVER_PEERS_EMPTY))),
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
            const result = yield* Effect.either(hosts.upsert(input));
            if (result._tag === "Right") {
              const reconciled = yield* Effect.either(
                pruneFleetTargetsAgainstHosts(result.right),
              );
              if (reconciled._tag === "Left") {
                return {
                  ok: false,
                  code: reconciled.left.code,
                  message: reconciled.left.message,
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
            const targetRemoved = yield* Effect.either(
              fleetTargets.remove(id),
            );
            if (targetRemoved._tag === "Left") {
              return {
                ok: false,
                code: "io",
                message:
                  `fleet target could not be removed: ${targetRemoved.left._tag}`,
              } satisfies HostsOpResult;
            }
            const hosts = yield* HostsService;
            const result = yield* Effect.either(hosts.remove(id));
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
            const result = yield* Effect.either(hosts.test(id));
            const latencyMs = Date.now() - startedAt;
            if (result._tag === "Right") {
              return {
                ok: result.right.ok,
                detail: result.right.detail,
                latencyMs,
                ...(result.right.reachability === undefined
                  ? {}
                  : { reachability: result.right.reachability }),
                ...(result.right.protocol === undefined
                  ? {}
                  : { protocol: result.right.protocol }),
              } satisfies HostsTestResult;
            }
            return {
              ok: false,
              detail: result.left.message,
              code: result.left.code,
              message: result.left.message,
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

  // Install / configure Vellum Remote on a registered host over existing SSH.
  // Only the Command Center may push remote station stamps (no reverse RPC).
  ipcMain.handle(IPC_CHANNELS.hostsConfigureRemote, (_event, id: unknown) =>
    surfaceShutdownRefusal(
      operations.run(HOST_OPERATION_ADMISSIONS.configureRemote, () =>
        AppRuntime.runPromise(
          Effect.gen(function* () {
            if (typeof id !== "string" || id.length === 0) {
              return {
                ok: false,
                detail: "host id required",
                code: "validation",
                message: "host id required",
              } satisfies HostsConfigureRemoteResult;
            }

            const settingsSvc = yield* SettingsService;
            const hosts = yield* HostsService;

            const settingsResult = yield* Effect.either(settingsSvc.get);
            if (settingsResult._tag === "Left") {
              return {
                ok: false,
                detail: settingsResult.left.message,
                code: settingsResult.left.code,
                message: settingsResult.left.message,
              } satisfies HostsConfigureRemoteResult;
            }

            const station = settingsResult.right.station;
            if (station.role !== "command-center") {
              return {
                ok: false,
                detail:
                  "Configure as Remote is only available when this station is Command Center",
                code: "validation",
                message:
                  "Configure as Remote is only available when this station is Command Center",
              } satisfies HostsConfigureRemoteResult;
            }

            const authority = yield* Effect.either(
              resolveCommandCenterConfigureOptions(true),
            );
            if (authority._tag === "Left") {
              return {
                ok: false,
                detail: authority.left.message,
                code: authority.left.code,
                message: authority.left.message,
              } satisfies HostsConfigureRemoteResult;
            }
            const result = yield* Effect.either(
              hosts.configureRemote(id, authority.right),
            );

            if (result._tag === "Left") {
              return {
                ok: false,
                detail: result.left.message,
                code: result.left.code,
                message: result.left.message,
              } satisfies HostsConfigureRemoteResult;
            }

            if (result.right.ok) {
              if (result.right.stationInstallationId === undefined) {
                return {
                  ok: false,
                  detail:
                    "Remote configuration succeeded without a Station installation identity",
                  code: "conflict",
                  message:
                    "Remote configuration succeeded without a Station installation identity",
                } satisfies HostsConfigureRemoteResult;
              }
              const bound = yield* Effect.either(
                bindConfiguredRemoteTarget(
                  hosts,
                  id,
                  result.right.stationInstallationId,
                ),
              );
              if (bound._tag === "Left") {
                return {
                  ok: false,
                  detail: bound.left.message,
                  code: bound.left.code,
                  message: bound.left.message,
                } satisfies HostsConfigureRemoteResult;
              }
            }

            return {
              ok: result.right.ok,
              detail: result.right.detail,
              station: result.right.station,
              code: result.right.code,
              message: result.right.message ?? result.right.detail,
            } satisfies HostsConfigureRemoteResult;
          }),
        ),
      ),
      (error) =>
        ({
          ok: false,
          detail: error.message,
          code: error.code,
          message: error.message,
        }) satisfies HostsConfigureRemoteResult,
    ),
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
            return computeDeployCapabilities({
              stationRole: doc.station.role,
              remoteManagedInstalls: doc.fleet.remoteManagedInstalls,
              release: RELEASE_CAPABILITIES,
              platform: process.platform,
            });
          }).pipe(
            Effect.catchAll((error) =>
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

  // Install/update Vellum.app on remote over SSH + start headless station.
  // Gated by RELEASE_CAPABILITIES and operator kill-switch (effective.deployRemote).
  ipcMain.handle(IPC_CHANNELS.hostsDeployRemote, (_event, input: unknown) =>
    surfaceShutdownRefusal(
      operations.run(HOST_OPERATION_ADMISSIONS.deployRemote, () => {
        // Release-frozen surface refuses BEFORE credential decode and BEFORE
        // entering the app runtime: no credential parse, no provider load, no
        // Effect flight retention. Operator/role inputs are forced permissive
        // so this gate can only ever deny for release-surface reasons — the
        // settings-backed operator/role gates still run inside the runtime.
        const releaseGate = computeDeployCapabilities({
          stationRole: "command-center",
          remoteManagedInstalls: true,
          release: RELEASE_CAPABILITIES,
          platform: process.platform,
        });
        if (!releaseGate.effective.deployRemote) {
          const detail =
            releaseGate.detail.deployRemote ??
            MANAGED_REMOTE_DEPLOY_DISABLED_DETAIL;
          return Promise.resolve({
            ok: false,
            detail,
            code: "validation",
            message: detail,
            stages: [],
          } satisfies HostsDeployRemoteResult);
        }

        const decoded = decodeHostsDeployRemoteInput(input);
        if (decoded === undefined) {
          return Promise.resolve({
            ok: false,
            detail: "invalid Remote deployment request",
            code: "validation",
            message: "invalid Remote deployment request",
          } satisfies HostsDeployRemoteResult);
        }

        return AppRuntime.runPromise(
          withHostsDeployRemoteAuthorization(
            decoded,
            (authorization) =>
              Effect.gen(function* () {
                const settingsSvc = yield* SettingsService;
                const hosts = yield* HostsService;
                const stationStatus = yield* StationStatusService;

                const settingsResult = yield* Effect.either(settingsSvc.get);
                if (settingsResult._tag === "Left") {
                  return {
                    ok: false,
                    detail: settingsResult.left.message,
                    code: settingsResult.left.code,
                    message: settingsResult.left.message,
                  } satisfies HostsDeployRemoteResult;
                }

                const effective = computeDeployCapabilities({
                  stationRole: settingsResult.right.station.role,
                  remoteManagedInstalls:
                    settingsResult.right.fleet.remoteManagedInstalls,
                  release: RELEASE_CAPABILITIES,
                  platform: process.platform,
                });
                if (!effective.effective.deployRemote) {
                  const detail =
                    effective.detail.deployRemote ??
                    MANAGED_REMOTE_DEPLOY_DISABLED_DETAIL;
                  return {
                    ok: false,
                    detail,
                    code: "validation",
                    message: detail,
                    stages: [],
                  } satisfies HostsDeployRemoteResult;
                }

                const authority = yield* Effect.either(
                  resolveCommandCenterConfigureOptions(true),
                );
                if (authority._tag === "Left") {
                  return {
                    ok: false,
                    detail: authority.left.message,
                    code: authority.left.code,
                    message: authority.left.message,
                    stages: [],
                  } satisfies HostsDeployRemoteResult;
                }

                const deploy = yield* hosts.deployConfiguredRemote(decoded.id, {
                  ...authority.right,
                  ...(authorization === undefined ? {} : { authorization }),
                  onAdmitted: (host) => {
                    const admittedAt = new Date().toISOString();
                    const detail = `${host.label}: deployment admitted; completion receipt pending`;
                    return stationStatus
                      .recordDeployment(
                        deployRecordFromResult({
                          hostId: host.id,
                          endpoint: host.sshEndpoint ?? "",
                          ok: false,
                          outcome: "indeterminate",
                          packageState: "previous",
                          role: "previous",
                          configurationOk: false,
                          detail,
                          stages: [
                            "durable deployment admission recorded",
                          ],
                          at: admittedAt,
                        }),
                      )
                      .pipe(
                        Effect.mapError((error) =>
                          new RemoteHostsError(
                            "io",
                            error instanceof Error
                              ? error.message
                              : String(error),
                          )
                        ),
                      );
                  },
                  onCompleted: (host, result) => {
                    const recordedAt = new Date().toISOString();
                    return stationStatus
                      .recordDeployment(
                        deployRecordFromResult({
                          hostId: host.id,
                          endpoint: host.sshEndpoint ?? "",
                          ok: result.ok,
                          outcome: result.outcome,
                          packageState: result.packageState,
                          role: result.role,
                          version: result.version,
                          ...(result.lastSeen === undefined
                            ? {}
                            : { lastSeen: result.lastSeen }),
                          configurationOk: result.configuration.ok,
                          detail: result.detail,
                          stages: result.stages,
                          at: recordedAt,
                        }),
                      )
                      .pipe(
                        Effect.mapError((error) =>
                          new RemoteHostsError(
                            "io",
                            error instanceof Error
                              ? error.message
                              : String(error),
                          )
                        ),
                      );
                  },
                });
                if (!deploy.ok) return projectDeployRemoteResult(deploy);
                if (deploy.stationInstallationId === undefined) {
                  return projectDeployRemoteResult(
                    deploymentFleetBindingFailure(
                      deploy,
                      "Remote configuration returned no Station installation identity",
                    ),
                  );
                }
                const bound = yield* Effect.either(
                  bindConfiguredRemoteTarget(
                    hosts,
                    decoded.id,
                    deploy.stationInstallationId,
                  ),
                );
                return projectDeployRemoteResult(
                  bound._tag === "Right"
                    ? deploy
                    : deploymentFleetBindingFailure(
                        deploy,
                        bound.left.message,
                      ),
                );
              }),
          ).pipe(
            Effect.catchTag("LinuxAdministratorAuthorizationInputError", () =>
              Effect.succeed({
                ok: false,
                detail: "Linux administrator authorization is invalid",
                code: "validation",
                message: "Linux administrator authorization is invalid",
              } satisfies HostsDeployRemoteResult),
            ),
          ),
        );
      }),
      (error) =>
        ({
          ok: false,
          detail: error.message,
          code: error.code,
          message: error.message,
        }) satisfies HostsDeployRemoteResult,
    ),
  );
};
