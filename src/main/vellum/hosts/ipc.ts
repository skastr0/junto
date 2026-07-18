import type { IpcMain } from "electron";
import { Effect } from "effect";
import { IPC_CHANNELS } from "@shared/ipc";
import type { HostsOpResult, HostsTestResult } from "@shared/ipc";
import { RemoteHostsError } from "@shared/remote-hosts";
import { AppRuntime } from "../../runtime";
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
};
