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
  createStartupProvider,
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
  const startupProvider = createStartupProvider(app);
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

  // Topology (station role / host / CC ref / supervised) — dedicated channel.
  // Generic settingsPatch refuses station keys; this path persists the
  // normalized protected topology.
  ipcMain.handle(IPC_CHANNELS.settingsSetStationTopology, (_event, station: unknown) =>
    AppRuntime.runPromise(
      Effect.gen(function* () {
        const settings = yield* SettingsService;
        if (station === null || typeof station !== "object" || Array.isArray(station)) {
          return settingsOpFail(
            "validation",
            "station topology patch must be a plain object",
          );
        }
        const result = yield* Effect.either(settings.setStationTopology(station));
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

  ipcMain.handle(IPC_CHANNELS.loginItemGet, () => startupProvider.get());
  ipcMain.handle(IPC_CHANNELS.loginItemSet, (_event, openAtLogin: unknown) =>
    startupProvider.set(openAtLogin),
  );

  void AppRuntime.runPromise(
    Effect.gen(function* () {
      const settings = yield* SettingsService;
      settings.subscribe((next) => broadcast(IPC_CHANNELS.settingsChanged, next));
      // Prime cache so first UI open is warm and doctor is honest.
      yield* settings.get.pipe(Effect.catchAll(() => Effect.void));
    }),
  );
};
