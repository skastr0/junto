/**
 * Machine-scoped Settings pages other than Agents: Providers and Name and
 * startup. Each is about one named machine and is answered by that
 * machine's own core, the window's own machine included (docs/machines.md,
 * Harness inventory: one path for every machine).
 *
 * Providers carry credential names and whether each is set, never a value
 * (rule 9: a secret's value lives only on the machine it was set on). A
 * credential is written on its machine by that machine's core.
 */
import { Schema } from "effect";
import { NativeUsageProvider } from "./usage";
import {
  PROVIDER_SECRET_FIELDS,
  PROVIDER_SECTION_KEYS,
  type ProviderSectionKey,
  type Settings,
} from "./settings";

export const MachineProviders = Schema.Struct({
  machine: Schema.String,
  enabledSources: Schema.Array(NativeUsageProvider),
  hermesHostSnapshots: Schema.Boolean,
  /** Per provider section, per secret field: whether a value is stored there. */
  credentials: Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Boolean)),
});
export type MachineProviders = typeof MachineProviders.Type;

/** A machine's own record: what other machines call it and how it is kept running. */
export const MachineRecord = Schema.Struct({
  machine: Schema.String,
  name: Schema.String,
  supervisedPreferred: Schema.Boolean,
});
export type MachineRecord = typeof MachineRecord.Type;

export class MachineSettingsUnavailableError extends Schema.TaggedError<MachineSettingsUnavailableError>()(
  "MachineSettingsUnavailableError",
  {
    machine: Schema.String,
    reason: Schema.Literals(["unreachable", "failed"]),
    message: Schema.String,
  },
) {}

/** A machine's providers as its core answers them: names and state, no values. */
export const machineProvidersOf = (settings: Settings, machine: string): MachineProviders => {
  const providers = settings.providers;
  const credentials: Record<string, Record<string, boolean>> = {};
  for (const section of PROVIDER_SECTION_KEYS) {
    const record = providers?.[section] as Readonly<Record<string, unknown>> | undefined;
    credentials[section] = Object.fromEntries(
      PROVIDER_SECRET_FIELDS[section].map((field) => {
        const value = record?.[field];
        return [field, typeof value === "string" && value.length > 0];
      }),
    );
  }
  return {
    machine,
    enabledSources: [...(providers?.enabledSources ?? [])],
    hermesHostSnapshots: providers?.hermesHostSnapshots === true,
    credentials,
  };
};

export const machineRecordOf = (settings: Settings): MachineRecord => ({
  machine: settings.machine.name,
  name: settings.machine.name,
  supervisedPreferred: settings.machine.supervisedPreferred,
});

export const credentialIsSet = (
  providers: MachineProviders,
  section: ProviderSectionKey,
  field: string,
): boolean => providers.credentials[section]?.[field] === true;
