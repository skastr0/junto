/**
 * The core's handlers of the settings group (src/contract/core/settings.ts),
 * for the window's Settings. Every answer is the renderer's projection:
 * provider secrets are masked here, so they never cross to main. Main keeps
 * what is Electron's: the theme, the interface size and the tool directories
 * it publishes from each answer, the login item, and the save dialog of a
 * backup export.
 *
 * What the window sent was decoded closed at main's edge; these handlers are
 * handed typed values only. The settings watch publishes on
 * `SETTINGS_CHANGED` through `CorePushes`, subscribed once per server, and the
 * subscription ends with it.
 */
import { Effect, Result, Scope } from "effect";
import { SETTINGS_CHANGED } from "../../contract/core/channels";
import { SettingsBackupFailed, SettingsRpcs, SettingsUnavailable } from "../../contract/core/settings";
import type { MachineSettingsResult } from "@shared/ipc";
import { machineCacheWindowsOf, machineProvidersOf, machineRecordOf, noMachineAnswer } from "@shared/machine-settings";
import {
  redactProvidersForIpc,
  settingsOpFail,
  settingsOpOk,
  type ProvidersPatch,
  type Settings,
  type SettingsError,
  type SettingsOpResult,
} from "@shared/settings";
import type { HostsService } from "../hosts/service";
import type { MachineLink } from "../link/service";
import type { MachineRepository } from "../machines/repository";
import type { ModelRecords } from "../model/records";
import type { ModelService } from "../model/service";
import { CorePushes } from "../push";
import { type PeerSettingsClient, type ProvidersChange, peerSettings } from "../settings/link-client";
import { SettingsService } from "../settings/service";
import { exportStateBackup, listStateBackups, type StateRecoveryError } from "../state/recovery";
import { applyStoredSettings } from "./settings-apply";

/** What asking another machine needs from the core's runtime. */
type PeerSettingsNeeds = HostsService | MachineLink | MachineRepository | ModelRecords | ModelService;

/** The renderer's projection of an answer: provider secrets only as MASKED_SECRET. */
const forRenderer = (result: Result.Result<Settings, SettingsError>): SettingsOpResult =>
  Result.isSuccess(result)
    ? settingsOpOk(redactProvidersForIpc(result.success))
    : settingsOpFail(result.failure.code, result.failure.message);

const answered = (effect: Effect.Effect<Settings, SettingsError>): Effect.Effect<SettingsOpResult> =>
  Effect.map(Effect.result(effect), forRenderer);

// A change for another machine carries only what may cross; a credential
// value is set on its own machine (docs/machines.md, rule 9).
const providersChange = (patch: ProvidersPatch): ProvidersChange | string => {
  const extra = Object.keys(patch).filter((key) => key !== "enabledSources");
  if (extra.length > 0) return "A credential is set on its own machine; open Junto there to change it.";
  if (patch.enabledSources === undefined) return "a providers change sets something";
  return { enabledSources: patch.enabledSources };
};
const providersOf = (settings: Settings) => machineProvidersOf(settings, settings.machine.name);
const cacheWindowsOf = (settings: Settings) => machineCacheWindowsOf(settings, settings.machine.name);
const refused = <A>(machine: string, message: string): Effect.Effect<MachineSettingsResult<A>> =>
  Effect.succeed(noMachineAnswer(machine, "failed", message));

const backupFailed = (error: StateRecoveryError) =>
  new SettingsBackupFailed({ operation: error.operation, message: error.message });

export const SettingsHandlers = SettingsRpcs.toLayer(
  Effect.gen(function* () {
    const settings = yield* SettingsService;
    const pushes = yield* CorePushes;
    const scope = yield* Scope.Scope;

    // Machine-scoped pages ask a machine by name. This core answers for its
    // own machine; another machine answers over the link's settings channel
    // (docs/machines.md, Harness inventory: one path for every machine).
    const forMachine = <A>(
      machine: string,
      answer: (current: Settings) => A,
      change: Effect.Effect<unknown, { readonly message: string }> | undefined,
      peer: (client: PeerSettingsClient, machine: string) => Effect.Effect<MachineSettingsResult<A>, never, PeerSettingsNeeds>,
    ): Effect.Effect<MachineSettingsResult<A>, never, PeerSettingsNeeds> =>
      Effect.gen(function* () {
        const current = yield* Effect.result(settings.get);
        if (Result.isFailure(current)) return noMachineAnswer(machine, "failed", current.failure.message);
        if (machine !== current.success.machine.name) return yield* peer(peerSettings(), machine);
        if (change === undefined) return { ok: true as const, value: answer(current.success) };
        const changed = yield* Effect.result(change);
        if (Result.isFailure(changed)) return noMachineAnswer(machine, "failed", changed.failure.message);
        const after = yield* Effect.result(settings.get);
        return Result.isSuccess(after)
          ? { ok: true as const, value: answer(after.success) }
          : noMachineAnswer(machine, "failed", after.failure.message);
      });

    // Subscribed once per server, on the first watch: every change is
    // published masked, as the window gets it, until the server closes.
    const subscribed = yield* Effect.cached(
      Effect.acquireRelease(
        Effect.sync(() =>
          settings.subscribe((next) => Effect.runSync(pushes.publish(SETTINGS_CHANGED, redactProvidersForIpc(next)))),
        ),
        (unsubscribe) => Effect.sync(unsubscribe),
      ).pipe(Scope.provide(scope)),
    );

    return {
      SettingsGet: () => answered(settings.get),
      SettingsPatch: ({ patch }) => answered(settings.patch(patch)),
      SettingsSetMachinePreferences: ({ machine }) => answered(settings.setMachinePreferences(machine)),
      SettingsReset: ({ section }) => answered(settings.reset(section)),
      SettingsMachineProviders: ({ machine }) =>
        forMachine(machine, providersOf, undefined, (client, name) => client.providers(name)),
      SettingsMachineProvidersWrite: ({ machine, patch }) =>
        forMachine(machine, providersOf, settings.patch({ providers: patch }), (client, name) => {
          const change = providersChange(patch);
          return typeof change === "string" ? refused(name, change) : client.setProviders(name, change);
        }),
      SettingsMachineRecord: ({ machine }) =>
        forMachine(machine, machineRecordOf, undefined, (client, name) => client.record(name)),
      SettingsMachineRecordWrite: ({ machine, patch }) =>
        forMachine(machine, machineRecordOf, settings.setMachinePreferences(patch), (client, name) =>
          // The name is this machine's label for it; only startup is set over the link.
          patch.supervisedPreferred === undefined
            ? refused(name, "Over the link a machine's record changes only its startup preference")
            : client.setStartup(name, patch.supervisedPreferred)),
      SettingsMachineCacheWindows: ({ machine }) =>
        forMachine(machine, cacheWindowsOf, undefined, (client, name) => client.cacheWindows(name)),
      SettingsMachineCacheWindowsWrite: ({ machine, patch }) =>
        forMachine(machine, cacheWindowsOf, settings.patch({ offboard: patch }), (client, name) => client.setCacheWindows(name, patch)),
      SettingsBackups: () => listStateBackups().pipe(Effect.mapError(backupFailed)),
      SettingsBackupExport: ({ id, destination }) => exportStateBackup(id, destination).pipe(Effect.mapError(backupFailed)),
      // Each watch also publishes the settings as they stand, after the
      // subscription, so a watcher reads every value from the one ordered push stream.
      SettingsWatch: () =>
        Effect.gen(function* () {
          yield* subscribed;
          const current = yield* settings.get.pipe(Effect.mapError((error) => new SettingsUnavailable({ message: error.message })));
          yield* pushes.publish(SETTINGS_CHANGED, redactProvidersForIpc(current));
        }),
      SettingsApply: ({ systemPrefersDark }) => applyStoredSettings(systemPrefersDark),
    };
  }),
);
