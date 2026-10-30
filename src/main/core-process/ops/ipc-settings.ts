/**
 * The window's Settings, answered by the core (junto/settings/ipc.ts). Every
 * answer is the renderer's projection: provider secrets are masked here, so
 * they never cross to main. Main keeps what is Electron's: the theme, the
 * interface size and the tool directories it publishes from each answer, the
 * login item, and the save dialog of a backup export.
 */
import { Effect, Result, Schema } from "effect";
import type { MachineSettingsResult } from "@shared/ipc";
import { machineCacheWindowsOf, machineProvidersOf, machineRecordOf } from "@shared/machine-settings";
import { OffboardRulesPatch } from "@shared/seat-offboard";
import type { NativeUsageProvider } from "@shared/usage";
import {
  SettingsSectionKey,
  redactProvidersForIpc,
  settingsOpFail,
  settingsOpOk,
  type Settings,
  type SettingsError,
  type SettingsOpResult,
} from "@shared/settings";
import type { HostsService } from "../../junto/hosts/service";
import type { MachineLink } from "../../junto/link/service";
import type { MachineRepository } from "../../junto/machines/repository";
import type { ModelRecords } from "../../junto/model/records";
import type { ModelService } from "../../junto/model/service";
import { type PeerSettingsClient, type ProvidersChange, peerSettings } from "../../junto/settings/link-client";
import { SettingsService } from "../../junto/settings/service";
import { exportStateBackup, listStateBackups } from "../../junto/state/recovery";
import type { StateBackupExportReceipt, StateBackupId, StateBackupInventoryEntry } from "../../junto/state/recovery";
import { coreOps, type CoreOp } from "../ops";

type Input = { readonly input: unknown };
type Machine = { readonly machine: unknown };

declare module "../ops" {
  interface CoreOps {
    "settings.get": CoreOp<Record<string, never>, SettingsOpResult>;
    "settings.patch": CoreOp<{ readonly patch: unknown }, SettingsOpResult>;
    "settings.setMachinePreferences": CoreOp<Machine, SettingsOpResult>;
    "settings.reset": CoreOp<{ readonly section?: unknown }, SettingsOpResult>;
    "settings.machineProviders": CoreOp<Machine, MachineSettingsResult<unknown>>;
    "settings.machineProvidersWrite": CoreOp<Input, MachineSettingsResult<unknown>>;
    "settings.machineRecord": CoreOp<Machine, MachineSettingsResult<unknown>>;
    "settings.machineRecordWrite": CoreOp<Input, MachineSettingsResult<unknown>>;
    "settings.machineCacheWindows": CoreOp<Machine, MachineSettingsResult<unknown>>;
    "settings.machineCacheWindowsWrite": CoreOp<Input, MachineSettingsResult<unknown>>;
    "settings.backups": CoreOp<Record<string, never>, ReadonlyArray<StateBackupInventoryEntry>>;
    "settings.backupExport": CoreOp<{ readonly id: StateBackupId; readonly destination: string }, StateBackupExportReceipt>;
  }
}

/** What asking another machine needs from the core's runtime. */
type PeerSettingsNeeds = HostsService | MachineLink | MachineRepository | ModelRecords | ModelService;

const decodeSection = Schema.decodeUnknownResult(SettingsSectionKey);
// A cache windows change is the offboard rules' own patch, decoded closed.
const decodeCacheWindowsPatch = Schema.decodeUnknownResult(OffboardRulesPatch, { onExcessProperty: "error" });

/** The renderer's projection of an answer: provider secrets only as MASKED_SECRET. */
const forRenderer = (result: Result.Result<Settings, SettingsError>): SettingsOpResult =>
  Result.isSuccess(result)
    ? settingsOpOk(redactProvidersForIpc(result.success))
    : settingsOpFail(result.failure.code, result.failure.message);

const plainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const keyedPatch = (input: unknown): { readonly machine: unknown; readonly patch: Record<string, unknown> } | undefined =>
  plainObject(input) && plainObject(input.patch) ? { machine: input.machine, patch: input.patch } : undefined;

// Machine-scoped pages ask a machine by name. This core answers for its own
// machine; another machine answers over the link once it carries settings
// (docs/machines.md, Harness inventory: one path for every machine).
const forMachine = <A>(
  machine: unknown,
  answer: (settings: Settings) => A,
  change: ((service: typeof SettingsService.Service) => Effect.Effect<unknown, { readonly message: string }>) | undefined,
  peer: (client: PeerSettingsClient, machine: string) => Effect.Effect<MachineSettingsResult<A>, never, PeerSettingsNeeds>,
) =>
  Effect.gen(function* () {
    const service = yield* SettingsService;
    const name = typeof machine === "string" ? machine : "";
    const fail = (reason: "unreachable" | "failed", message: string): MachineSettingsResult<A> =>
      ({ ok: false, error: { _tag: "MachineSettingsUnavailableError", machine: name, reason, message } });
    const current = yield* Effect.result(service.get);
    if (Result.isFailure(current)) return fail("failed", current.failure.message);
    if (name === "") return fail("unreachable", "A machine-scoped settings request names its machine");
    // Another machine answers over the link's settings channel.
    if (name !== current.success.machine.name) return yield* peer(peerSettings(), name);
    if (change === undefined) return { ok: true, value: answer(current.success) } as MachineSettingsResult<A>;
    const changed = yield* Effect.result(change(service));
    if (Result.isFailure(changed)) return fail("failed", changed.failure.message);
    const after = yield* Effect.result(service.get);
    return Result.isSuccess(after) ? { ok: true, value: answer(after.success) } as MachineSettingsResult<A> : fail("failed", after.failure.message);
  });

// A change for another machine carries only what may cross; a credential
// value is set on its own machine (docs/machines.md, rule 9).
const refused = <A>(machine: string, message: string) =>
  Effect.succeed<MachineSettingsResult<A>>({ ok: false, error: { _tag: "MachineSettingsUnavailableError", machine, reason: "failed", message } });
const providersChange = (patch: Record<string, unknown>): ProvidersChange | string => {
  const extra = Object.keys(patch).filter((key) => key !== "enabledSources");
  if (extra.length > 0) return "A credential is set on its own machine; open Junto there to change it.";
  const { enabledSources } = patch;
  if (enabledSources === undefined) return "a providers change sets something";
  if (!Array.isArray(enabledSources)) return "enabledSources must be a list";
  return { enabledSources: enabledSources as ReadonlyArray<NativeUsageProvider> };
};
const providersOf = (settings: Settings) => machineProvidersOf(settings, settings.machine.name);
const cacheWindowsOf = (settings: Settings) => machineCacheWindowsOf(settings, settings.machine.name);
const CACHE_WINDOWS_WHY = "A cache windows change sets the machine's window or a harness's, in whole minutes from 1 to 10080, or the cache mode: off, manual, auto or hybrid";

coreOps({
  "settings.get": () => Effect.flatMap(SettingsService, (settings) => Effect.map(Effect.result(settings.get), forRenderer)),
  "settings.patch": ({ patch }) =>
    Effect.flatMap(SettingsService, (settings) =>
      // Reject non-objects early so IPC cannot pass arrays/primitives that
      // would otherwise produce opaque schema trees.
      !plainObject(patch)
        ? Effect.succeed(settingsOpFail("validation", "settings patch must be a plain object"))
        : Effect.map(Effect.result(settings.patch(patch)), forRenderer)),
  // Supervision has its own protected preference command.
  "settings.setMachinePreferences": ({ machine }) =>
    Effect.flatMap(SettingsService, (settings) =>
      !plainObject(machine)
        ? Effect.succeed(settingsOpFail("validation", "machine preferences patch must be a plain object"))
        : Effect.map(Effect.result(settings.setMachinePreferences(machine)), forRenderer)),
  "settings.reset": ({ section }) =>
    Effect.flatMap(SettingsService, (settings) => {
      if (section === undefined || section === null || section === "") return Effect.map(Effect.result(settings.reset()), forRenderer);
      const decoded = decodeSection(section);
      if (Result.isFailure(decoded)) return Effect.succeed(settingsOpFail("validation", "settings reset section is invalid"));
      return Effect.map(Effect.result(settings.reset(decoded.success)), forRenderer);
    }),
  "settings.machineProviders": ({ machine }) =>
    forMachine(machine, providersOf, undefined, (client, name) => client.providers(name)),
  "settings.machineProvidersWrite": ({ input }) => {
    const request = keyedPatch(input);
    return forMachine(request?.machine, providersOf,
      (service) => request === undefined
        ? Effect.fail({ message: "a providers write needs a machine and a patch" })
        : service.patch({ providers: request.patch }),
      (client, name) => {
        const change = request === undefined ? "a providers write needs a machine and a patch" : providersChange(request.patch);
        return typeof change === "string" ? refused(name, change) : client.setProviders(name, change);
      });
  },
  "settings.machineRecord": ({ machine }) =>
    forMachine(machine, machineRecordOf, undefined, (client, name) => client.record(name)),
  "settings.machineRecordWrite": ({ input }) => {
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
  },
  "settings.machineCacheWindows": ({ machine }) =>
    forMachine(machine, cacheWindowsOf, undefined, (client, name) => client.cacheWindows(name)),
  "settings.machineCacheWindowsWrite": ({ input }) => {
    const request = keyedPatch(input);
    const decoded = request === undefined ? undefined : decodeCacheWindowsPatch(request.patch);
    const patch = decoded !== undefined && Result.isSuccess(decoded) ? decoded.success : undefined;
    return forMachine(request?.machine, cacheWindowsOf,
      (service) => patch === undefined ? Effect.fail({ message: CACHE_WINDOWS_WHY }) : service.patch({ offboard: patch }),
      (client, name) => patch === undefined ? refused(name, CACHE_WINDOWS_WHY) : client.setCacheWindows(name, patch));
  },
  "settings.backups": () => listStateBackups(),
  "settings.backupExport": ({ id, destination }) => exportStateBackup(id, destination),
});
