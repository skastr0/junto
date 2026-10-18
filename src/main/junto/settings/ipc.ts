import type { IpcMain, SaveDialogOptions } from "electron";
import { app, BrowserWindow, dialog, nativeTheme } from "electron";
import { Effect, Result } from "effect";
import { IPC_CHANNELS, type MachineSettingsResult } from "@shared/ipc";
import { machineCacheWindowsOf, machineProvidersOf, machineRecordOf } from "@shared/machine-settings";
import { OffboardRulesPatch } from "@shared/seat-offboard";
import { refreshThemeFromSystem, setThemePreference } from "../theme-state";
import { themePublishDecision } from "./theme-publish";
import { setInterfaceScale } from "../interface-scale";
import {
  SettingsSectionKey,
  interfaceScaleOf,
  redactProvidersForIpc,
  settingsOpFail,
  settingsOpOk,
  type Settings,
  type SettingsOpResult,
} from "@shared/settings";
import { setConfiguredToolDirectories } from "../adapters/exec";
import { Schema } from "effect";
import { AppRuntime } from "../../runtime";
import {
  createStartupProvider,
} from "../login-item";
import { SettingsService } from "./service";
import { type PeerSettingsClient, type ProvidersChange, peerSettings } from "./link-client";
import type { HostsService } from "../hosts/service";
import type { MachineLink } from "../link/service";
import type { MachineRepository } from "../machines/repository";
import type { ModelRecords } from "../model/records";
import type { ModelService } from "../model/service";
import type { NativeUsageProvider } from "@shared/usage";

/** What asking another machine needs from the app runtime. */
type PeerSettingsNeeds = HostsService | MachineLink | MachineRepository | ModelRecords | ModelService;
import {
  createStateRecoveryIpcHandlers,
  type StateRecoveryDestinationChoice,
} from "../state/recovery-ipc";
import {
  exportStateBackup,
  listStateBackups,
} from "../state/recovery";

const decodeSection = Schema.decodeUnknownResult(SettingsSectionKey);

/**
 * Renderer-facing projection: provider secrets leave main only as
 * MASKED_SECRET. Raw values stay inside main (SettingsService and the
 * usage-plane accessor); they never ride IPC results or broadcasts.
 */
const toRendererOpResult = (op: SettingsOpResult): SettingsOpResult =>
  op.settings === undefined ? op : { ...op, settings: redactProvidersForIpc(op.settings) };

const toOpResult = (
  either: Result.Result<
    import("@shared/settings").Settings,
    import("@shared/settings").SettingsError
  >,
): SettingsOpResult => {
  if (Result.isSuccess(either)) return settingsOpOk(either.success);
  return settingsOpFail(either.failure.code, either.failure.message);
};

export const registerSettingsIpc = (
  ipcMain: IpcMain,
  broadcast: (channel: string, payload: unknown) => void,
): void => {
  const startupProvider = createStartupProvider(app);
  /**
   * Feed main's theme state. Main owns the resolved theme for the whole app —
   * every canvas, rendered or not, and every seat spawned with no surface — so
   * the stored preference has to reach it whenever it loads or changes.
   */
  const publishThemePreference = (settings: Settings): void => {
    setThemePreference(settings.appearance.theme);
  };
  /** The interface size is main's to apply: it is the window's zoom factor. */
  const publishInterfaceScale = (settings: Settings): void => {
    setInterfaceScale(interfaceScaleOf(settings));
  };
  const publishToolDirectories = (settings: Settings): void => {
    setConfiguredToolDirectories(settings.advanced.toolDirectories ?? []);
  };
  /** Same publish, from an IPC result. See `themePublishDecision`. */
  const publishThemeFromOp = (op: SettingsOpResult): void => {
    const decision = themePublishDecision(op);
    if (decision.kind === "leave") return;
    setThemePreference(decision.preference);
  };
  const publishToolDirectoriesFromOp = (op: SettingsOpResult): void => {
    if (op.settings === undefined) return;
    publishToolDirectories(op.settings);
  };
  // Only matters while the preference is "system"; harmless otherwise.
  nativeTheme.on("updated", () => refreshThemeFromSystem());

  const stateRecovery = createStateRecoveryIpcHandlers({
    listBackups: () => AppRuntime.runPromise(listStateBackups()),
    exportBackup: (id, destination) =>
      AppRuntime.runPromise(exportStateBackup(id, destination)),
  });
  ipcMain.handle(IPC_CHANNELS.settingsGet, () =>
    AppRuntime.runPromise(
      Effect.gen(function* () {
        const settings = yield* SettingsService;
        const result = yield* Effect.result(settings.get);
        const op = toOpResult(result);
        publishThemeFromOp(op);
        publishToolDirectoriesFromOp(op);
        return toRendererOpResult(op);
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
        const result = yield* Effect.result(settings.patch(patch));
        const op = toOpResult(result);
        publishThemeFromOp(op);
        publishToolDirectoriesFromOp(op);
        return toRendererOpResult(op);
      }),
    ),
  );

  // Supervision has its own protected preference command.
  ipcMain.handle(IPC_CHANNELS.settingsSetMachinePreferences, (_event, machine: unknown) =>
    AppRuntime.runPromise(
      Effect.gen(function* () {
        const settings = yield* SettingsService;
        if (machine === null || typeof machine !== "object" || Array.isArray(machine)) {
          return settingsOpFail(
            "validation",
            "machine preferences patch must be a plain object",
          );
        }
        const result = yield* Effect.result(settings.setMachinePreferences(machine));
        return toRendererOpResult(toOpResult(result));
      }),
    ),
  );

  // Machine-scoped pages ask a machine by name. This core answers for its own
  // machine; another machine answers over the link once it carries settings
  // (docs/machines.md, Harness inventory: one path for every machine).
  const forMachine = <A>(
    machine: unknown,
    answer: (settings: Settings) => A,
    change: ((service: typeof SettingsService.Service) => Effect.Effect<unknown, { readonly message: string }>) | undefined,
    peer: (client: PeerSettingsClient, machine: string) => Effect.Effect<MachineSettingsResult<A>, never, PeerSettingsNeeds>,
  ): Promise<MachineSettingsResult<A>> =>
    AppRuntime.runPromise(Effect.gen(function* () {
      const service = yield* SettingsService;
      const name = typeof machine === "string" ? machine : "";
      const fail = (reason: "unreachable" | "failed", message: string): MachineSettingsResult<A> =>
        ({ ok: false, error: { _tag: "MachineSettingsUnavailableError", machine: name, reason, message } });
      const current = yield* Effect.result(service.get);
      if (Result.isFailure(current)) return fail("failed", current.failure.message);
      if (name === "") return fail("unreachable", "A machine-scoped settings request names its machine");
      // Another machine answers over the link's settings channel.
      if (name !== current.success.machine.name) return yield* peer(peerSettings(), name);
      if (change === undefined) return { ok: true, value: answer(current.success) };
      const changed = yield* Effect.result(change(service));
      if (Result.isFailure(changed)) return fail("failed", changed.failure.message);
      const after = yield* Effect.result(service.get);
      return Result.isSuccess(after) ? { ok: true, value: answer(after.success) } : fail("failed", after.failure.message);
    }));
  const plainObject = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  const keyedPatch = (input: unknown): { readonly machine: unknown; readonly patch: Record<string, unknown> } | undefined =>
    plainObject(input) && plainObject(input.patch) ? { machine: input.machine, patch: input.patch } : undefined;

  // A change for another machine carries only what may cross; a credential
  // value is set on its own machine (docs/machines.md, rule 9).
  const refused = <A>(machine: string, message: string) =>
    Effect.succeed<MachineSettingsResult<A>>({ ok: false, error: { _tag: "MachineSettingsUnavailableError", machine, reason: "failed", message } });
  const providersChange = (patch: Record<string, unknown>): ProvidersChange | string => {
    const extra = Object.keys(patch).filter((key) => key !== "enabledSources" && key !== "hermesHostSnapshots");
    if (extra.length > 0) return "A credential is set on its own machine; open Junto there to change it.";
    const { enabledSources, hermesHostSnapshots } = patch;
    if (enabledSources !== undefined && !Array.isArray(enabledSources)) return "enabledSources must be a list";
    if (hermesHostSnapshots !== undefined && typeof hermesHostSnapshots !== "boolean") return "hermesHostSnapshots must be true or false";
    if (enabledSources === undefined && hermesHostSnapshots === undefined) return "a providers change sets something";
    return {
      ...(enabledSources === undefined ? {} : { enabledSources: enabledSources as ReadonlyArray<NativeUsageProvider> }),
      ...(hermesHostSnapshots === undefined ? {} : { hermesHostSnapshots }),
    };
  };

  ipcMain.handle(IPC_CHANNELS.machineProviders, (_event, machine: unknown) =>
    forMachine(machine, (settings) => machineProvidersOf(settings, settings.machine.name), undefined,
      (client, name) => client.providers(name)));
  ipcMain.handle(IPC_CHANNELS.machineProvidersWrite, (_event, input: unknown) => {
    const request = keyedPatch(input);
    return forMachine(request?.machine, (settings) => machineProvidersOf(settings, settings.machine.name),
      (service) => request === undefined
        ? Effect.fail({ message: "a providers write needs a machine and a patch" })
        : service.patch({ providers: request.patch }),
      (client, name) => {
        const change = request === undefined ? "a providers write needs a machine and a patch" : providersChange(request.patch);
        return typeof change === "string" ? refused(name, change) : client.setProviders(name, change);
      });
  });
  ipcMain.handle(IPC_CHANNELS.machineRecord, (_event, machine: unknown) =>
    forMachine(machine, machineRecordOf, undefined, (client, name) => client.record(name)));
  ipcMain.handle(IPC_CHANNELS.machineRecordWrite, (_event, input: unknown) => {
    const request = keyedPatch(input);
    return forMachine(request?.machine, machineRecordOf,
      (service) => request === undefined
        ? Effect.fail({ message: "a record write needs a machine and a patch" })
        : service.setMachinePreferences(request.patch),
      (client, name) => {
        const keys = request === undefined ? [] : Object.keys(request.patch);
        const preferred = request?.patch.supervisedPreferred;
        // The name is this machine's label for it; only startup is set over the link.
        return keys.length !== 1 || typeof preferred !== "boolean"
          ? refused(name, "Over the link a machine's record changes only its startup preference")
          : client.setStartup(name, preferred);
      });
  });

  // A cache windows change is the offboard rules' own patch, decoded closed.
  const decodeCacheWindowsPatch = Schema.decodeUnknownResult(OffboardRulesPatch, { onExcessProperty: "error" });
  ipcMain.handle(IPC_CHANNELS.machineCacheWindows, (_event, machine: unknown) =>
    forMachine(machine, (settings) => machineCacheWindowsOf(settings, settings.machine.name), undefined,
      (client, name) => client.cacheWindows(name)));
  ipcMain.handle(IPC_CHANNELS.machineCacheWindowsWrite, (_event, input: unknown) => {
    const request = keyedPatch(input);
    const decoded = request === undefined ? undefined : decodeCacheWindowsPatch(request.patch);
    const patch = decoded !== undefined && Result.isSuccess(decoded) ? decoded.success : undefined;
    const why = "A cache windows change sets the machine's window or a harness's, in whole minutes from 1 to 10080, or the cache mode: off, manual, auto or hybrid";
    return forMachine(request?.machine, (settings) => machineCacheWindowsOf(settings, settings.machine.name),
      (service) => patch === undefined ? Effect.fail({ message: why }) : service.patch({ offboard: patch }),
      (client, name) => patch === undefined ? refused(name, why) : client.setCacheWindows(name, patch));
  });

  ipcMain.handle(IPC_CHANNELS.settingsReset, (_event, section?: unknown) =>
    AppRuntime.runPromise(
      Effect.gen(function* () {
        const settings = yield* SettingsService;
        if (section === undefined || section === null || section === "") {
          const result = yield* Effect.result(settings.reset());
          const op = toOpResult(result);
          publishToolDirectoriesFromOp(op);
          return toRendererOpResult(op);
        }
        const decoded = decodeSection(section);
        if (Result.isFailure(decoded)) {
          return settingsOpFail("validation", "settings reset section is invalid");
        }
        const result = yield* Effect.result(settings.reset(decoded.success));
        const op = toOpResult(result);
        publishToolDirectoriesFromOp(op);
        return toRendererOpResult(op);
      }),
    ),
  );

  ipcMain.handle(IPC_CHANNELS.loginItemGet, () => startupProvider.get());
  ipcMain.handle(IPC_CHANNELS.loginItemSet, (_event, openAtLogin: unknown) =>
    startupProvider.set(openAtLogin),
  );

  ipcMain.handle(IPC_CHANNELS.stateBackupsList, () =>
    stateRecovery.list(),
  );
  ipcMain.handle(
    IPC_CHANNELS.stateBackupExport,
    async (event, id: unknown) => {
      const chooseDestination = async (
        suggestedFileName: string,
      ): Promise<StateRecoveryDestinationChoice> => {
        const options: SaveDialogOptions = {
          title: "Export verified Junto state backup",
          buttonLabel: "Export backup",
          defaultPath: suggestedFileName,
          filters: [
            {
              name: "SQLite database",
              extensions: ["db"],
            },
          ],
          properties: ["createDirectory"],
        };
        const owner = BrowserWindow.fromWebContents(event.sender);
        const selected =
          owner === null
            ? await dialog.showSaveDialog(options)
            : await dialog.showSaveDialog(owner, options);
        if (selected.canceled) {
          return { outcome: "canceled" };
        }
        if (selected.filePath.length === 0) {
          throw new Error("save dialog returned no destination");
        }
        return {
          outcome: "selected",
          path: selected.filePath,
        };
      };
      return stateRecovery.export(id, chooseDestination);
    },
  );

  void AppRuntime.runPromise(
    Effect.gen(function* () {
      const settings = yield* SettingsService;
      settings.subscribe((next) => {
        publishThemePreference(next);
        publishInterfaceScale(next);
        publishToolDirectories(next);
        broadcast(IPC_CHANNELS.settingsChanged, redactProvidersForIpc(next));
      });
      // Prime cache so first UI open is warm and doctor is honest. This also
      // gives main the theme before any renderer exists, so a seat woken early
      // is not spawned against the pre-settings default.
      const primed = yield* settings.get.pipe(Effect.result);
      if (Result.isSuccess(primed)) {
        publishThemePreference(primed.success);
        publishInterfaceScale(primed.success);
        publishToolDirectories(primed.success);
      }
    }),
  );
};
