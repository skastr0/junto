/**
 * Where Providers and Name and startup read and write one named machine's
 * settings. One seam keyed by machine, like harness-machine-source.ts: a
 * machine's own core answers, and a machine no channel reaches yet answers a
 * typed unreachable.
 *
 * A machine the link does not carry settings for yet answers unreachable.
 * Values of credentials never come back: a read is names and state only.
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

type Answer<A> = Promise<Result.Result<A, MachineSettingsUnavailableError>>;

export type MachineSettingsSource = {
  readonly providers: (machine: string) => Answer<MachineProviders>;
  /** Written on that machine by its own core; answers the providers read back. */
  readonly writeProviders: (machine: string, patch: ProvidersPatch) => Answer<MachineProviders>;
  readonly record: (machine: string) => Answer<MachineRecord>;
  readonly writeRecord: (machine: string, patch: MachinePreferencesPatch) => Answer<MachineRecord>;
};

type Keyed<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: { readonly machine: string; readonly reason: "unreachable" | "failed"; readonly message: string } };

const answerOf = async <A>(machine: string, call: () => Promise<Keyed<A>>): Answer<A> => {
  const answer = await call().catch((cause: unknown): Keyed<A> => ({
    ok: false,
    error: { machine, reason: "failed", message: cause instanceof Error ? cause.message : String(cause) },
  }));
  return answer.ok
    ? Result.succeed(answer.value)
    : Result.fail(new MachineSettingsUnavailableError({
      machine: answer.error.machine || machine,
      reason: answer.error.reason,
      message: answer.error.message,
    }));
};

const noBridge = (machine: string): Promise<Keyed<never>> =>
  Promise.resolve({ ok: false, error: { machine, reason: "failed", message: "This window has no Junto bridge" } });

/** Every machine is asked by name through its own core; none is answered from this window's state. */
export const coreMachineSettingsSource: MachineSettingsSource = {
  providers: (machine) =>
    answerOf(machine, () => window.junto?.machineProviders(machine) ?? noBridge(machine)),
  writeProviders: (machine, patch) =>
    answerOf(machine, () => window.junto?.machineProvidersWrite({ machine, patch }) ?? noBridge(machine)),
  record: (machine) =>
    answerOf(machine, () => window.junto?.machineRecord(machine) ?? noBridge(machine)),
  writeRecord: (machine, patch) =>
    answerOf(machine, () => window.junto?.machineRecordWrite({ machine, patch }) ?? noBridge(machine)),
};

let source: MachineSettingsSource = coreMachineSettingsSource;

export const machineSettingsSource = (): MachineSettingsSource => source;

/** The keyed IPC installs its source here when it lands; tests swap one in. */
export const setMachineSettingsSource = (next: MachineSettingsSource): void => {
  source = next;
};
