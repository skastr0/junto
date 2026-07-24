import type { IpcMain } from "electron";
import { Effect } from "effect";
import { IPC_CHANNELS } from "@shared/ipc";
import type {
  DiscoveredPeer,
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
import {
  configureRecordFromResult,
  deployRecordFromResult,
} from "@shared/station-status";
import { AppRuntime } from "../../runtime";
import { SettingsService } from "../settings/service";
import { recordStationDeployment } from "../station-status-store";
import type { ConfiguredRemoteDeployResult } from "./deploy-configured-remote";
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
import { pushLiveProjectionToEnrolledRemotes } from "../projection/product-push";

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
  rollback: deploy.rollback,
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
    const endpointToken = endpointHostToken(host.endpoint);
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
  return { name, addresses, online: peer.online === true };
};

const DISCOVER_PEERS_EMPTY: HostsDiscoverPeersResult = {
  ok: true,
  peers: [],
};

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
                  "Only a sealed Command Center may mutate the host registry",
              } satisfies HostsOpResult;
            }
            const hosts = yield* HostsService;
            const result = yield* Effect.either(hosts.upsert(input));
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
                  "Only a sealed Command Center may mutate the host registry",
              } satisfies HostsOpResult;
            }
            if (typeof id !== "string" || id.length === 0) {
              return {
                ok: false,
                code: "validation",
                message: "host id required",
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

            const commandCenterRef = station.hostId;
            const result = yield* Effect.either(
              hosts.configureRemote(id, {
                commandCenterRef,
                supervisedPreferred: true,
              }),
            );

            if (result._tag === "Left") {
              return {
                ok: false,
                detail: result.left.message,
                code: result.left.code,
                message: result.left.message,
              } satisfies HostsConfigureRemoteResult;
            }

            // Best-effort: after enroll, stage a projection frame on remotes.
            // Failures do not undo configure — Doctor lastProjection surfaces truth.
            if (result.right.ok && RELEASE_CAPABILITIES.stationProjection) {
              const push = yield* Effect.either(
                pushLiveProjectionToEnrolledRemotes,
              );
              if (push._tag === "Left") {
                console.error(
                  "[projection] post-configure push failed:",
                  push.left,
                );
              } else if (!push.right.ok) {
                console.error(
                  "[projection] post-configure push rejected:",
                  push.right.detail,
                );
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

  // Install/update Vellum.app on remote over SSH + start headless station.
  // Beta: managed deploy is compile-time disabled (manual .deb only).
  ipcMain.handle(IPC_CHANNELS.hostsDeployRemote, (_event, input: unknown) =>
    surfaceShutdownRefusal(
      operations.run(HOST_OPERATION_ADMISSIONS.deployRemote, () => {
        if (!RELEASE_CAPABILITIES.managedRemoteDeploy) {
          return Promise.resolve({
            ok: false,
            detail: MANAGED_REMOTE_DEPLOY_DISABLED_DETAIL,
            code: "validation",
            message: MANAGED_REMOTE_DEPLOY_DISABLED_DETAIL,
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

                const settingsResult = yield* Effect.either(settingsSvc.get);
                if (settingsResult._tag === "Left") {
                  return {
                    ok: false,
                    detail: settingsResult.left.message,
                    code: settingsResult.left.code,
                    message: settingsResult.left.message,
                  } satisfies HostsDeployRemoteResult;
                }

                if (settingsResult.right.station.role !== "command-center") {
                  return {
                    ok: false,
                    detail:
                      "Deploy Remote is only available on Command Center",
                    code: "validation",
                    message:
                      "Deploy Remote is only available on Command Center",
                  } satisfies HostsDeployRemoteResult;
                }

                const deploy = yield* hosts.deployConfiguredRemote(decoded.id, {
                  commandCenterRef: settingsResult.right.station.hostId,
                  supervisedPreferred: true,
                  ...(authorization === undefined ? {} : { authorization }),
                  onAdmitted: (host) => {
                    const admittedAt = new Date().toISOString();
                    const detail = `${host.label}: deployment admitted; completion receipt pending`;
                    return Effect.tryPromise({
                      try: () =>
                        recordStationDeployment(
                          deployRecordFromResult({
                            hostId: host.id,
                            endpoint: host.endpoint ?? "",
                            ok: false,
                            outcome: "indeterminate",
                            packageState: "previous",
                            role: "previous",
                            rollback: "not-required",
                            configurationOk: false,
                            detail,
                            stages: [
                              "durable deployment admission recorded",
                            ],
                            at: admittedAt,
                          }),
                          configureRecordFromResult({
                            ok: false,
                            hostId: host.id,
                            detail,
                            at: admittedAt,
                          }),
                        ),
                      catch: (error) =>
                        new RemoteHostsError(
                          "io",
                          error instanceof Error
                            ? error.message
                            : String(error),
                        ),
                    });
                  },
                  onCompleted: (host, result) => {
                    const recordedAt = new Date().toISOString();
                    return Effect.tryPromise({
                      try: () =>
                        recordStationDeployment(
                          deployRecordFromResult({
                            hostId: host.id,
                            endpoint: host.endpoint ?? "",
                            ok: result.ok,
                            outcome: result.outcome,
                            packageState: result.packageState,
                            role: result.role,
                            version: result.version,
                            lastSeen: result.lastSeen,
                            rollback: result.rollback,
                            configurationOk: result.configuration.ok,
                            detail: result.detail,
                            stages: result.stages,
                            at: recordedAt,
                          }),
                          configureRecordFromResult({
                            ok: result.outcome === "ready",
                            hostId: host.id,
                            detail: result.configuration.detail,
                            at: recordedAt,
                          }),
                        ),
                      catch: (error) =>
                        new RemoteHostsError(
                          "io",
                          error instanceof Error
                            ? error.message
                            : String(error),
                        ),
                    });
                  },
                });
                return projectDeployRemoteResult(deploy);
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
