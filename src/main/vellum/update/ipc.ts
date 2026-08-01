import type { IpcMain } from "electron";
import { Effect, Either } from "effect";
import { IPC_CHANNELS } from "@shared/ipc";
import {
  decodeUpdateStatus,
  idleUpdateStatus,
  type UpdateStatus,
} from "@shared/update";
import { AppRuntime } from "../../runtime";
import {
  captureInstallAuthority,
  requireUpdateHostHooks,
  requireUpdateProviderHandle,
  takeInstallAuthority,
} from "./host-slot";
import { UpdateError } from "./errors";
import {
  finalizeInstallAfterQuiesce,
  UpdateService,
} from "./service";

const errorStatus = (
  currentVersion: string,
  code: UpdateStatus["error"] extends infer E
    ? E extends { code: infer C }
      ? C
      : never
    : never,
  message: string,
  available?: UpdateStatus["available"],
): UpdateStatus =>
  decodeUpdateStatus({
    phase: "error",
    currentVersion,
    canInstall: false,
    ...(available === undefined ? {} : { available }),
    error: { code, message },
  });

export const registerUpdateIpc = (
  ipcMain: IpcMain,
  broadcast: (channel: string, payload: unknown) => void,
  currentVersion: string,
): (() => void) => {
  const handlers = [
    IPC_CHANNELS.updateGetState,
    IPC_CHANNELS.updateCheck,
    IPC_CHANNELS.updateRestartAndInstall,
  ] as const;

  ipcMain.handle(IPC_CHANNELS.updateGetState, () =>
    AppRuntime.runPromise(
      Effect.gen(function* () {
        const updates = yield* UpdateService;
        return yield* updates.getState;
      }).pipe(
        Effect.catchAll(() =>
          Effect.succeed(idleUpdateStatus(currentVersion)),
        ),
      ),
    ),
  );

  ipcMain.handle(IPC_CHANNELS.updateCheck, () =>
    AppRuntime.runPromise(
      Effect.gen(function* () {
        const updates = yield* UpdateService;
        const result = yield* Effect.either(updates.check);
        if (Either.isRight(result)) return result.right;
        return errorStatus(
          currentVersion,
          result.left.updateCode,
          result.left.message,
        );
      }),
    ),
  );

  /**
   * Split path so SQLite can be released before quitAndInstall:
   * 1. prepareInstall while AppRuntime owns StateEngine
   * 2. host quiesce (dispose runtime / close DB)
   * 3. finalizeInstallAfterQuiesce via Effect.runPromise (no runtime)
   */
  ipcMain.handle(IPC_CHANNELS.updateRestartAndInstall, async () => {
    try {
      const prepared = await AppRuntime.runPromise(
        Effect.gen(function* () {
          const updates = yield* UpdateService;
          return yield* updates.prepareInstall;
        }),
      );
      captureInstallAuthority(prepared.plan, prepared.candidate);
    } catch (error) {
      const message =
        error instanceof UpdateError
          ? error.message
          : error instanceof Error
            ? error.message
            : "prepare install failed";
      const code =
        error instanceof UpdateError ? error.updateCode : "not-ready";
      return errorStatus(currentVersion, code, message);
    }

    try {
      await requireUpdateHostHooks().quiesceForInstall();
    } catch (error) {
      // Clear pending install authority before relaunch so a later path
      // cannot finalize with a stale captured plan.
      takeInstallAuthority();
      const message =
        error instanceof Error
          ? `failed to quiesce for install: ${error.message}`
          : "failed to quiesce for install";
      requireUpdateHostHooks().relaunchWithoutInstall();
      return errorStatus(currentVersion, "readiness-failed", message);
    }

    const authority = takeInstallAuthority();
    if (authority === undefined) {
      requireUpdateHostHooks().relaunchWithoutInstall();
      return errorStatus(
        currentVersion,
        "install-refused",
        "install authority was lost during quiesce",
      );
    }

    try {
      return await Effect.runPromise(
        finalizeInstallAfterQuiesce({
          plan: authority.plan,
          candidate: authority.candidate,
          provider: requireUpdateProviderHandle(),
          host: requireUpdateHostHooks(),
        }),
      );
    } catch (error) {
      const message =
        error instanceof UpdateError
          ? error.message
          : error instanceof Error
            ? error.message
            : "install failed";
      const code =
        error instanceof UpdateError
          ? error.updateCode
          : "readiness-failed";
      // finalizeInstallAfterQuiesce already relaunches on install failure
      return errorStatus(
        currentVersion,
        code,
        message,
        authority.plan.available,
      );
    }
  });

  let unsubscribe: (() => void) | undefined;
  void AppRuntime.runPromise(
    Effect.gen(function* () {
      const updates = yield* UpdateService;
      unsubscribe = updates.subscribe((status) => {
        broadcast(IPC_CHANNELS.updateStateChanged, status);
      });
      const status = yield* updates.getState;
      broadcast(IPC_CHANNELS.updateStateChanged, status);
    }),
  );

  return () => {
    unsubscribe?.();
    unsubscribe = undefined;
    for (const channel of handlers) {
      ipcMain.removeHandler(channel);
    }
  };
};
