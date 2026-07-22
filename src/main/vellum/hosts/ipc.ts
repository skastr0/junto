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
import { AppRuntime } from "../../runtime";
import { SettingsService } from "../settings/service";
import { HostsService } from "./service";

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

export const registerHostsIpc = (ipcMain: IpcMain): void => {
  ipcMain.handle(IPC_CHANNELS.hostsList, () =>
    AppRuntime.runPromise(
      Effect.gen(function* () {
        const hosts = yield* HostsService;
        const result = yield* Effect.either(hosts.list);
        return toOp(result as never);
      }),
    ),
  );

  ipcMain.handle(IPC_CHANNELS.hostsUpsert, (_event, input: unknown) =>
    AppRuntime.runPromise(
      Effect.gen(function* () {
        const hosts = yield* HostsService;
        const result = yield* Effect.either(hosts.upsert(input));
        return toOp(result as never);
      }),
    ),
  );

  ipcMain.handle(IPC_CHANNELS.hostsRemove, (_event, id: unknown) =>
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
  );

  ipcMain.handle(IPC_CHANNELS.hostsTest, (_event, id: unknown) =>
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
  );

  // Install / configure Vellum Remote on a registered host over existing SSH.
  // Only the Command Center may push remote station stamps (no reverse RPC).
  ipcMain.handle(IPC_CHANNELS.hostsConfigureRemote, (_event, id: unknown) =>
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
  );

  // Install/update Vellum.app on remote over SSH + start headless station.
  ipcMain.handle(IPC_CHANNELS.hostsDeployRemote, (_event, id: unknown) =>
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

        // Stamp station role first so the launched app boots as Remote.
        const configure = yield* Effect.either(
          hosts.configureRemote(id, {
            commandCenterRef: settingsResult.right.station.hostId,
            supervisedPreferred: true,
          }),
        );
        if (configure._tag === "Left") {
          return {
            ok: false,
            detail: configure.left.message,
            code: configure.left.code,
            message: configure.left.message,
          } satisfies HostsDeployRemoteResult;
        }
        if (!configure.right.ok) {
          return {
            ok: false,
            detail: configure.right.detail,
            code: configure.right.code,
            message: configure.right.message ?? configure.right.detail,
          } satisfies HostsDeployRemoteResult;
        }

        const deploy = yield* hosts.deployRemote(id);
        return {
          ok: deploy.ok,
          detail: deploy.ok
            ? `${configure.right.detail} · ${deploy.detail}`
            : deploy.detail,
          code: deploy.code,
          message: deploy.message ?? deploy.detail,
          stages: deploy.stages,
        } satisfies HostsDeployRemoteResult;
      }),
    ),
  );
};
