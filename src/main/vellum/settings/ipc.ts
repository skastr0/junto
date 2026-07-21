import type { IpcMain } from "electron";
import { app } from "electron";
import { Effect, Either } from "effect";
import { IPC_CHANNELS } from "@shared/ipc";
import {
  SettingsSectionKey,
  settingsOpFail,
  settingsOpOk,
  type SettingsOpResult,
} from "@shared/settings";
import { Schema } from "effect";
import { AppRuntime } from "../../runtime";
import {
  loginItemOpFail,
  loginItemOpOk,
  readLoginItemState,
  setLoginItemOpenAtLogin,
} from "../login-item";
import { SettingsService } from "./service";

const decodeSection = Schema.decodeUnknownEither(SettingsSectionKey);

const toOpResult = (
  either: Either.Either<
    import("@shared/settings").Settings,
    import("@shared/settings").SettingsError
  >,
): SettingsOpResult => {
  if (Either.isRight(either)) return settingsOpOk(either.right);
  return settingsOpFail(either.left.code, either.left.message);
};

export const registerSettingsIpc = (
  ipcMain: IpcMain,
  broadcast: (channel: string, payload: unknown) => void,
): void => {
  ipcMain.handle(IPC_CHANNELS.settingsGet, () =>
    AppRuntime.runPromise(
      Effect.gen(function* () {
        const settings = yield* SettingsService;
        const result = yield* Effect.either(settings.get);
        return toOpResult(result);
      }),
    ),
  );

  ipcMain.handle(IPC_CHANNELS.settingsPatch, (_event, patch: unknown) =>
    AppRuntime.runPromise(
      Effect.gen(function* () {
        const settings = yield* SettingsService;
        // Reject non-objects early so IPC cannot pass arrays/primitives that
        // would otherwise produce opaque schema trees.
        if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
          return settingsOpFail("validation", "settings patch must be a plain object");
        }
        const result = yield* Effect.either(settings.patch(patch));
        return toOpResult(result);
      }),
    ),
  );

  ipcMain.handle(IPC_CHANNELS.settingsReset, (_event, section?: unknown) =>
    AppRuntime.runPromise(
      Effect.gen(function* () {
        const settings = yield* SettingsService;
        if (section === undefined || section === null || section === "") {
          const result = yield* Effect.either(settings.reset());
          return toOpResult(result);
        }
        const decoded = decodeSection(section);
        if (Either.isLeft(decoded)) {
          return settingsOpFail("validation", "settings reset section is invalid");
        }
        const result = yield* Effect.either(settings.reset(decoded.right));
        return toOpResult(result);
      }),
    ),
  );

  // Login item: OS is source of truth. Read real state on demand; set only on
  // explicit toggle — never enroll at boot or on settings load.
  ipcMain.handle(IPC_CHANNELS.loginItemGet, () => {
    try {
      return loginItemOpOk(readLoginItemState(app));
    } catch (error) {
      return loginItemOpFail(error instanceof Error ? error.message : String(error));
    }
  });

  ipcMain.handle(IPC_CHANNELS.loginItemSet, (_event, openAtLogin: unknown) => {
    if (typeof openAtLogin !== "boolean") {
      return loginItemOpFail("openAtLogin must be a boolean");
    }
    try {
      return loginItemOpOk(setLoginItemOpenAtLogin(app, openAtLogin));
    } catch (error) {
      return loginItemOpFail(error instanceof Error ? error.message : String(error));
    }
  });

  void AppRuntime.runPromise(
    Effect.gen(function* () {
      const settings = yield* SettingsService;
      settings.subscribe((next) => broadcast(IPC_CHANNELS.settingsChanged, next));
      // Prime cache so first UI open is warm and doctor is honest.
      yield* settings.get.pipe(Effect.catchAll(() => Effect.void));
    }),
  );
};
