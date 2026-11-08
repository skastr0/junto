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
import { Result, Schema } from "effect";
import { NativeUsageProvider } from "./usage";
import { CacheMode, DEFAULT_CACHE_MODE, OffboardRulesPatch } from "./seat-offboard";
import {
  MachinePreferencesPatch,
  PROVIDER_SECRET_FIELDS,
  PROVIDER_SECTION_KEYS,
  ProvidersPatch,
  offboardRules,
  type ProviderSectionKey,
  type Settings,
} from "./settings";

export const MachineProviders = Schema.Struct({
  machine: Schema.String,
  enabledSources: Schema.Array(NativeUsageProvider),
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
 * A machine's cache windows: its own, and each harness's that differs, and
 * its cache mode. A still seat's session is cut on its own machine once it has
 * been still this long (shared/seat-offboard.ts), so each machine keeps and
 * answers its own.
 */
export const MachineCacheWindows = Schema.Struct({
  machine: Schema.String,
  cacheWindowMinutes: Schema.Number,
  /** Harness id to minutes, for each harness with a window of its own. */
  harness: Schema.Record(Schema.String, Schema.Number),
  /** Absent: a linked machine on a build from before the cache mode. */
  cacheMode: Schema.optionalKey(CacheMode),
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

/** Why a machine did not answer, as a page reads it: data in the answer, not a failure of the call. */
export const MachineSettingsUnavailable = Schema.Struct({
  _tag: Schema.Literal("MachineSettingsUnavailableError"),
  machine: Schema.String,
  reason: Schema.Literals(["unreachable", "failed"]),
  message: Schema.String,
  /** The typed failure behind the reason, e.g. LinkUnavailable or SettingsNoSeatHere. */
  failure: Schema.optionalKey(Schema.String),
  /** The operation both machines logged the request under. */
  operationId: Schema.optionalKey(Schema.String),
});
export type MachineSettingsUnavailable = typeof MachineSettingsUnavailable.Type;

/** A machine-scoped settings answer, from that machine's own core: its value, or why it gave none. */
export const machineSettingsResult = <A extends Schema.Top>(value: A) =>
  Schema.Union([
    Schema.Struct({ ok: Schema.Literal(true), value }),
    Schema.Struct({ ok: Schema.Literal(false), error: MachineSettingsUnavailable }),
  ]);

/** The answer that a machine gave no value. */
export type MachineSettingsNoAnswer = { readonly ok: false; readonly error: MachineSettingsUnavailable };

export const noMachineAnswer = (
  machine: string,
  reason: MachineSettingsUnavailable["reason"],
  message: string,
): MachineSettingsNoAnswer => ({ ok: false, error: { _tag: "MachineSettingsUnavailableError", machine, reason, message } });

/** A machine-scoped write as main hands it to the core: the machine by name, and the change. */
export const MachineProvidersWrite = Schema.Struct({ machine: Schema.NonEmptyString, patch: ProvidersPatch });
export type MachineProvidersWrite = typeof MachineProvidersWrite.Type;
export const MachineRecordWrite = Schema.Struct({ machine: Schema.NonEmptyString, patch: MachinePreferencesPatch });
export type MachineRecordWrite = typeof MachineRecordWrite.Type;
export const MachineCacheWindowsWrite = Schema.Struct({ machine: Schema.NonEmptyString, patch: OffboardRulesPatch });
export type MachineCacheWindowsWrite = typeof MachineCacheWindowsWrite.Type;

export const MACHINE_PROVIDERS_WRITE_WHY = "a providers write needs a machine and a patch";
export const MACHINE_RECORD_WRITE_WHY = "a record write needs a machine and a patch";
export const MACHINE_CACHE_WINDOWS_WHY =
  "A cache windows change sets the machine's window or a harness's, in whole minutes from 1 to 10080, or the cache mode: off, manual, auto or hybrid";

const NAMES_NO_MACHINE = "A machine-scoped settings request names its machine";

const namedMachine = (raw: unknown): string | undefined => {
  if (raw === null || typeof raw !== "object" || !("machine" in raw)) return undefined;
  const machine = raw.machine;
  return typeof machine === "string" && machine.length > 0 ? machine : undefined;
};

/** The machine a page asked about, at main's edge, or the answer that it named none. */
export const machineFromWindow = (raw: unknown): Result.Result<string, MachineSettingsNoAnswer> =>
  typeof raw === "string" && raw.length > 0
    ? Result.succeed(raw)
    : Result.fail(noMachineAnswer("", "unreachable", NAMES_NO_MACHINE));

/**
 * A machine-scoped write from the window, decoded closed at main's edge. One
 * that names no machine is refused as a read is; one whose change this build
 * does not read is refused for that machine, and neither reaches the core.
 */
const writeFromWindow = <W>(decode: (raw: unknown) => Result.Result<W, Schema.SchemaError>, why: string) =>
  (raw: unknown): Result.Result<W, MachineSettingsNoAnswer> => {
    const machine = namedMachine(raw);
    if (machine === undefined) return Result.fail(noMachineAnswer("", "unreachable", NAMES_NO_MACHINE));
    return decode(raw).pipe(Result.mapError(() => noMachineAnswer(machine, "failed", why)));
  };

export const machineProvidersWriteFromWindow = writeFromWindow(
  (raw) => Schema.decodeUnknownResult(MachineProvidersWrite)(raw, { onExcessProperty: "error" }),
  MACHINE_PROVIDERS_WRITE_WHY,
);
export const machineRecordWriteFromWindow = writeFromWindow(
  (raw) => Schema.decodeUnknownResult(MachineRecordWrite)(raw, { onExcessProperty: "error" }),
  MACHINE_RECORD_WRITE_WHY,
);
export const machineCacheWindowsWriteFromWindow = writeFromWindow(
  (raw) => Schema.decodeUnknownResult(MachineCacheWindowsWrite)(raw, { onExcessProperty: "error" }),
  MACHINE_CACHE_WINDOWS_WHY,
);

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
    cacheMode: rules.cacheMode ?? DEFAULT_CACHE_MODE,
  };
};
