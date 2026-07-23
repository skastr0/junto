import type { IpcMain } from "electron";
import { Effect } from "effect";
import { IPC_CHANNELS } from "@shared/ipc";
import type {
  HostsConfigureRemoteResult,
  HostsDeployRemoteResult,
  HostsOpResult,
  HostsTestResult,
} from "@shared/ipc";
import { RemoteHostsError } from "@shared/remote-hosts";
import {
  configureRecordFromResult,
  deployRecordFromResult,
} from "@shared/station-status";
import { AppRuntime } from "../../runtime";
import { SettingsService } from "../settings/service";
import { recordStationDeployment } from "../station-status-store";
import { HostsService } from "./service";
import {
  HOST_OPERATION_ADMISSIONS,
  HostOperationShutdownRefused,
  hostOperationGate,
  type HostOperationGate,
} from "./shutdown";

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

  ipcMain.handle(IPC_CHANNELS.hostsUpsert, (_event, input: unknown) =>
    surfaceShutdownRefusal(
      operations.run(HOST_OPERATION_ADMISSIONS.upsert, () =>
        AppRuntime.runPromise(
          Effect.gen(function* () {
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
            const result = yield* Effect.either(hosts.test(id));
            if (result._tag === "Right") {
              return {
                ok: result.right.ok,
                detail: result.right.detail,
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
  ipcMain.handle(IPC_CHANNELS.hostsDeployRemote, (_event, id: unknown) =>
    surfaceShutdownRefusal(
      operations.run(HOST_OPERATION_ADMISSIONS.deployRemote, () =>
        AppRuntime.runPromise(
          Effect.gen(function* () {
            if (typeof id !== "string" || id.length === 0) {
              return {
                ok: false,
                detail: "host id required",
                code: "validation",
                message: "host id required",
              } satisfies HostsDeployRemoteResult;
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
              } satisfies HostsDeployRemoteResult;
            }

            if (settingsResult.right.station.role !== "command-center") {
              return {
                ok: false,
                detail: "Deploy Remote is only available on Command Center",
                code: "validation",
                message: "Deploy Remote is only available on Command Center",
              } satisfies HostsDeployRemoteResult;
            }

            const deploy = yield* hosts.deployConfiguredRemote(id, {
              commandCenterRef: settingsResult.right.station.hostId,
              supervisedPreferred: true,
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
                        stages: ["durable deployment admission recorded"],
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
                      error instanceof Error ? error.message : String(error),
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
                      error instanceof Error ? error.message : String(error),
                    ),
                });
              },
            });
            return {
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
            } satisfies HostsDeployRemoteResult;
          }),
        ),
      ),
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
