/**
 * Where Providers and Name and startup read and write one named machine's
 * settings. One seam keyed by machine, like harness-machine-source.ts: a
 * machine's own core answers, and a machine no channel reaches yet answers a
 * typed unreachable.
 *
 * Until the keyed IPC lands, the window's own machine is answered by the
 * window's own core over the settings IPC it already has; every other
 * machine is unreachable. Values of credentials never come back: a read is
 * names and state only.
 */
import { Result } from "effect";
import {
  MachineSettingsUnavailableError,
  machineProvidersOf,
  machineRecordOf,
  type MachineProviders,
  type MachineRecord,
} from "@shared/machine-settings";
import type { MachinePreferencesPatch, ProvidersPatch } from "@shared/settings";
import { patchSettings, setMachinePreferences } from "./settings-state";
import { state$ } from "./state";

type Answer<A> = Promise<Result.Result<A, MachineSettingsUnavailableError>>;

export type MachineSettingsSource = {
  readonly providers: (machine: string) => Answer<MachineProviders>;
  /** Written on that machine by its own core; answers the providers read back. */
  readonly writeProviders: (machine: string, patch: ProvidersPatch) => Answer<MachineProviders>;
  readonly record: (machine: string) => Answer<MachineRecord>;
  readonly writeRecord: (machine: string, patch: MachinePreferencesPatch) => Answer<MachineRecord>;
};

const unreachable = (machine: string) =>
  Result.fail(
    new MachineSettingsUnavailableError({
      machine,
      reason: "unreachable",
      message: "Another machine's settings come over the link, which does not carry them yet",
    }),
  );

const failed = (machine: string) =>
  Result.fail(
    new MachineSettingsUnavailableError({
      machine,
      reason: "failed",
      message: state$.settingsError.peek() || "the settings write failed",
    }),
  );

const ownCore = (machine: string): boolean => machine === state$.settings.machine.name.peek();

export const coreMachineSettingsSource: MachineSettingsSource = {
  providers: async (machine) =>
    ownCore(machine) ? Result.succeed(machineProvidersOf(state$.settings.peek(), machine)) : unreachable(machine),
  writeProviders: async (machine, patch) => {
    if (!ownCore(machine)) return unreachable(machine);
    return (await patchSettings({ providers: patch }))
      ? Result.succeed(machineProvidersOf(state$.settings.peek(), machine))
      : failed(machine);
  },
  record: async (machine) =>
    ownCore(machine) ? Result.succeed(machineRecordOf(state$.settings.peek())) : unreachable(machine),
  writeRecord: async (machine, patch) => {
    if (!ownCore(machine)) return unreachable(machine);
    return (await setMachinePreferences(patch)) ? Result.succeed(machineRecordOf(state$.settings.peek())) : failed(machine);
  },
};

let source: MachineSettingsSource = coreMachineSettingsSource;

export const machineSettingsSource = (): MachineSettingsSource => source;

/** The keyed IPC installs its source here when it lands; tests swap one in. */
export const setMachineSettingsSource = (next: MachineSettingsSource): void => {
  source = next;
};
