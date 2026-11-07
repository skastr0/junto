/**
 * The settings group: what the window's Settings asks of the core, already
 * masked for the renderer, and what main asks so this machine's runtime
 * follows the stored settings. The core answers it
 * (`src/core/ops/ipc-settings.ts`); main decodes what the window sends at its
 * own edge (`src/shared/settings.ts`, `src/shared/machine-settings.ts`) and
 * reaches the group through the client service below
 * (`src/app/settings/ipc.ts`).
 *
 * A refusal the window shows is an answer, never an error of the call:
 * `SettingsOpResult` and the machine-scoped results carry it as data. A call
 * fails only when the core cannot do what was asked at all (a backup it could
 * not list or export, settings it could not read for a watch), or with
 * `RpcClientError` when the core left before it answered.
 */
import { Context, Layer, Schema } from "effect";
import { Rpc, RpcGroup, type RpcClient, type RpcClientError } from "effect/rpc";
import {
  MachineCacheWindows,
  MachineCacheWindowsWrite,
  MachineProviders,
  MachineProvidersWrite,
  MachineRecord,
  MachineRecordWrite,
  machineSettingsResult,
} from "../../shared/machine-settings";
import { MachinePreferencesPatch, SettingsOpResult, SettingsPatch, SettingsSectionKey } from "../../shared/settings";
import { StateBackupExportReceipt, StateBackupId, StateBackupInventoryEntry } from "../../shared/state-recovery";
import { coreClient } from "./link";

/** The state backups could not be listed or exported; the window says so and keeps the file it had. */
export class SettingsBackupFailed extends Schema.TaggedError<SettingsBackupFailed>()("SettingsBackupFailed", {
  operation: Schema.String,
  message: Schema.String,
}) {}

/** The settings could not be read, so a watch has nothing to publish; main asks again. */
export class SettingsUnavailable extends Schema.TaggedError<SettingsUnavailable>()("SettingsUnavailable", {
  message: Schema.String,
}) {}

/** A machine-scoped read names its machine. */
const Machine = { machine: Schema.NonEmptyString };

export const SettingsRpcs = RpcGroup.make(
  Rpc.make("SettingsGet", { success: SettingsOpResult }),
  /** A patch already decoded closed at main's edge. Machine settings are refused here: they have their own command. */
  Rpc.make("SettingsPatch", { payload: { patch: SettingsPatch }, success: SettingsOpResult }),
  /** Supervision has its own protected preference command. */
  Rpc.make("SettingsSetMachinePreferences", { payload: { machine: MachinePreferencesPatch }, success: SettingsOpResult }),
  /** No section resets every section. */
  Rpc.make("SettingsReset", { payload: { section: Schema.optionalKey(SettingsSectionKey) }, success: SettingsOpResult }),
  Rpc.make("SettingsMachineProviders", { payload: Machine, success: machineSettingsResult(MachineProviders) }),
  Rpc.make("SettingsMachineProvidersWrite", { payload: MachineProvidersWrite, success: machineSettingsResult(MachineProviders) }),
  Rpc.make("SettingsMachineRecord", { payload: Machine, success: machineSettingsResult(MachineRecord) }),
  Rpc.make("SettingsMachineRecordWrite", { payload: MachineRecordWrite, success: machineSettingsResult(MachineRecord) }),
  Rpc.make("SettingsMachineCacheWindows", { payload: Machine, success: machineSettingsResult(MachineCacheWindows) }),
  Rpc.make("SettingsMachineCacheWindowsWrite", {
    payload: MachineCacheWindowsWrite,
    success: machineSettingsResult(MachineCacheWindows),
  }),
  Rpc.make("SettingsBackups", { success: Schema.Array(StateBackupInventoryEntry), error: SettingsBackupFailed }),
  Rpc.make("SettingsBackupExport", {
    payload: { id: StateBackupId, destination: Schema.String },
    success: StateBackupExportReceipt,
    error: SettingsBackupFailed,
  }),
  /**
   * Publish the settings as they stand on `SETTINGS_CHANGED`, then every
   * change on the same channel, masked. The core subscribes once however
   * often it is asked; main asks each core once.
   */
  Rpc.make("SettingsWatch", { error: SettingsUnavailable }),
  /**
   * Apply the stored settings to the core's runtime: the theme preference,
   * with the OS reading only main sees, and the tool directories seats are
   * spawned with. The core reads the settings itself, so the two copies
   * cannot disagree.
   */
  Rpc.make("SettingsApply", { payload: { systemPrefersDark: Schema.optionalKey(Schema.Boolean) } }),
).annotate(Rpc.ParseOptions, { onExcessProperty: "error" });

/** Main's client of the settings group. A call fails with `RpcClientError` when the core it asked left before it answered. */
export class SettingsCore extends Context.Service<SettingsCore, RpcClient.FromGroup<typeof SettingsRpcs, RpcClientError.RpcClientError>>()(
  "@junto/contract/SettingsCore",
) {
  static readonly layer = Layer.effect(SettingsCore, coreClient(SettingsRpcs));
}
