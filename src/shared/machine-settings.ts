/**
 * Machine-scoped Settings pages other than Agents: Providers, Name and
 * startup, and the cache windows. Each is about one named machine and is answered by that
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
  offboardRules,
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

/**
 * A machine's cache windows: its own, and each harness's that differs. A
 * still seat's session is cut on its own machine once it has been still this
 * long (shared/seat-offboard.ts), so each machine keeps and answers its own.
 */
export const MachineCacheWindows = Schema.Struct({
  machine: Schema.String,
  cacheWindowMinutes: Schema.Number,
  /** Harness id to minutes, for each harness with a window of its own. */
  harness: Schema.Record(Schema.String, Schema.Number),
});
export type MachineCacheWindows = typeof MachineCacheWindows.Type;

export class MachineSettingsUnavailableError extends Schema.TaggedError<MachineSettingsUnavailableError>()(
  "MachineSettingsUnavailableError",
  {
    machine: Schema.String,
    reason: Schema.Literals(["unreachable", "failed"]),
    message: Schema.String,
    /** The typed failure behind the reason, e.g. LinkUnavailable. */
    failure: Schema.optionalKey(Schema.String),
    /** The operation both machines logged the request under. */
    operationId: Schema.optionalKey(Schema.String),
  },
) {}

/** How a page says a machine did not answer: its typed failure when it has one, else the reason. */
export const machineSettingsRefusal = (label: string, error: MachineSettingsUnavailableError): string =>
  `${label} did not answer (${error.failure ?? error.reason}): ${error.message.replace(/\.$/u, "")}`;

/** A machine's providers as its core answers them: names and state, no values. */
export const machineProvidersOf = (settings: Settings, machine: string): MachineProviders => {
  const providers = settings.providers;
  const credentials: Record<string, Record<string, boolean>> = {};
  for (const section of PROVIDER_SECTION_KEYS) {
    const record = providers?.[section] as Readonly<Record<string, unknown>> | undefined;
    credentials[section] = Object.fromEntries(
      PROVIDER_SECRET_FIELDS[section].map((field) => {
        const value = record?.[field];
        // A vault-backed secret is absent from settings and says so beside it (`apiKeyConfigured`).
        return [field, (typeof value === "string" && value.length > 0) || record?.[`${field}Configured`] === true];
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

export const machineCacheWindowsOf = (settings: Settings, machine: string): MachineCacheWindows => {
  const rules = offboardRules(settings);
  return {
    machine,
    cacheWindowMinutes: rules.cacheWindowMinutes,
    harness: Object.fromEntries(
      Object.entries(rules.harness ?? {}).flatMap(([harness, over]) =>
        over.cacheWindowMinutes === undefined ? [] : [[harness, over.cacheWindowMinutes]]),
    ),
  };
};
