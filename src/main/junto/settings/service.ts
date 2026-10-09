import { Context, Effect, Result, Layer, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import type { ServiceCheck } from "@shared/contracts";
import {
  SETTINGS_MAX_SERIALIZED_BYTES,
  SettingsError,
  defaultAdvanced,
  defaultSection,
  defaultSettings,
  type ProvidersSettings,
  type Settings,
  type SettingsSectionKey,
} from "@shared/settings";
import { assessSupervisedRuntime } from "@shared/supervised-runtime";
import { defaultMachineName } from "@shared/machine-name";
import { MachineName } from "@shared/machine-control";
import {
  StateEngine,
  StateTransactionOperation,
} from "../state/service";
import { withSqlRead } from "../state/sql-read";
import {
  applyAndValidatePatch,
  decodePatchInput,
  decodeMachinePreferencesPatch,
} from "./patch";
import {
  decodeStoredSettings,
  preferencesFromSettings,
} from "./state-schema";
import {
  probeSupervisedRuntime,
  type SupervisedProbe,
} from "./supervised-probe";
import {
  MachineConfigurationRepository,
  machineSettingsFromConfiguration,
  type StoredMachineConfiguration,
} from "../machines/configuration";
import { CredentialBindingRepository } from "../credentials/bindings";
import {
  clearAllProviderSecretOps,
  commitProviderSecretOps,
  discardStagedSecrets,
  migrateHistoricalProviderSecrets,
  reconcileCredentialVault,
  resolveProviderSecrets,
  retireVaultSecrets,
  stageSecretValues,
  type StagedSecret,
} from "../credentials/coordinator";
import { persistableProviders } from "../credentials/redact";
import { projectSettingsForRead } from "../credentials/project";
import { providerSecretOpsFromPatch } from "../credentials/slots";
import {
  openFileCredentialStore,
  type CredentialStore,
} from "../credentials/store";
import { dirname, join } from "node:path";

/** Machine configuration joins preferences in the public settings value. */
export class SettingsService extends Context.Service<SettingsService,
  {
    readonly doctor: Effect.Effect<ServiceCheck>;
    readonly get: Effect.Effect<Settings, SettingsError>;
    readonly patch: (input: unknown) => Effect.Effect<Settings, SettingsError>;
    readonly setMachinePreferences: (
      input: unknown,
    ) => Effect.Effect<Settings, SettingsError>;
    readonly reset: (
      section?: SettingsSectionKey,
    ) => Effect.Effect<Settings, SettingsError>;
    readonly resolveProviders: Effect.Effect<
      ProvidersSettings,
      SettingsError
    >;
    readonly subscribe: (listener: (settings: Settings) => void) => () => void;
  }>()("@junto/SettingsService") {}

export interface SettingsServiceApi {
  readonly doctor: Effect.Effect<ServiceCheck>;
  readonly get: Effect.Effect<Settings, SettingsError>;
  readonly patch: (input: unknown) => Effect.Effect<Settings, SettingsError>;
  readonly setMachinePreferences: (
    input: unknown,
  ) => Effect.Effect<Settings, SettingsError>;
  readonly reset: (
    section?: SettingsSectionKey,
  ) => Effect.Effect<Settings, SettingsError>;
  readonly resolveProviders: Effect.Effect<
    ProvidersSettings,
    SettingsError
  >;
  readonly subscribe: (listener: (settings: Settings) => void) => () => void;
}

export type SettingsServiceOptions = {
  /** Override supervisor probe in tests. */
  readonly probeSupervised?: SupervisedProbe;
  /** Override credential vault in tests. */
  readonly credentials?: CredentialStore;
};

type MachineConfigurationService = typeof MachineConfigurationRepository.Service;
type CredentialBindings = typeof CredentialBindingRepository.Service;
type SettingsRows = {
  readonly preferences:
    | {
        readonly version: number;
        readonly body: string;
      }
    | undefined;
  readonly machine: StoredMachineConfiguration | undefined;
  readonly initialization:
    | {
        readonly initializedAt: string;
      }
    | undefined;
};
const PreferencesRow = Schema.Struct({ version: Schema.Number, body: Schema.String });
const InitializationRow = Schema.Struct({ initialized_at: Schema.String });

const SELECT_PREFERENCES_SQL = `
  SELECT version, body
  FROM settings_preferences
  WHERE singleton = 1
`;
const SELECT_INITIALIZATION_SQL = `
  SELECT initialized_at
  FROM settings_initialization
  WHERE singleton = 1
`;
const UPSERT_PREFERENCES_SQL = `
  INSERT INTO settings_preferences(singleton, version, body, updated_at)
  VALUES (1, ?, ?, ?)
  ON CONFLICT(singleton) DO UPDATE SET
    version = excluded.version,
    body = excluded.body,
    updated_at = excluded.updated_at
`;
const INSERT_INITIALIZATION_SQL = `
  INSERT INTO settings_initialization(singleton, initialized_at)
  VALUES (1, ?)
`;

const stateFailure = (operation: string) => (error: unknown): SettingsError => {
  if (error instanceof SettingsError) return error;
  return new SettingsError({
    code: Schema.isSchemaError(error) ? "corrupt" : "io",
    message: `settings ${operation} failed: ${error instanceof Error ? error.message : String(error)}`,
  });
};

const transaction = <A, E>(sql: SqlClient.SqlClient, operation: string, body: Effect.Effect<A, E>) =>
  sql.withTransaction(body).pipe(
    Effect.provideService(StateTransactionOperation, operation),
    Effect.mapError(stateFailure(operation)),
    Effect.withSpan(operation),
  );

const read = <A, E>(sql: SqlClient.SqlClient, operation: string, body: Effect.Effect<A, E>) =>
  withSqlRead(sql, body).pipe(
    Effect.mapError(stateFailure(operation)),
    Effect.withSpan(operation),
  );

const parseBody = (label: string, raw: string): unknown => {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new SettingsError({
      code: "corrupt",
      message:
        `${label} JSON is invalid: ${
          error instanceof Error ? error.message : String(error)
        }`,
    });
  }
};

const readRows = Effect.fn("settings.read-rows")(function* (
  sql: SqlClient.SqlClient,
  configuration: MachineConfigurationService,
) {
  const preferences = yield* SqlSchema.findOneOption({
    Request: Schema.Void,
    Result: PreferencesRow,
    execute: () => sql.unsafe(SELECT_PREFERENCES_SQL),
  })(undefined);
  const initialization = yield* SqlSchema.findOneOption({
    Request: Schema.Void,
    Result: InitializationRow,
    execute: () => sql.unsafe(SELECT_INITIALIZATION_SQL),
  })(undefined);
  const machine = yield* configuration.read.pipe(Effect.mapError((error) =>
    new SettingsError({
      code: "corrupt",
      message:
        `canonical machine configuration is invalid: ${
          error instanceof Error ? error.message : String(error)
        }`,
    }),
  ));
  return {
    preferences:
      preferences._tag === "None"
        ? undefined
        : preferences.value,
    machine,
    initialization:
      initialization._tag === "None"
        ? undefined
        : {
            initializedAt: initialization.value.initialized_at,
          },
  };
});

type StoredSettingsState = {
  readonly settings: Settings;
  readonly initialization: NonNullable<SettingsRows["initialization"]>;
};

const decodeRows = (
  rows: SettingsRows,
): StoredSettingsState | undefined => {
  if (
    rows.preferences === undefined &&
    rows.initialization === undefined
  ) {
    return undefined;
  }
  if (
    rows.preferences === undefined ||
    rows.initialization === undefined
  ) {
    throw new SettingsError({
      code: "corrupt",
      message: "canonical settings aggregate is incomplete",
    });
  }
  return {
    settings: decodeStoredSettings(
      rows.preferences.version,
      parseBody("stored settings preferences", rows.preferences.body),
      machineSettingsFromConfiguration(rows.machine),
    ),
    initialization: rows.initialization,
  };
};

const readStoredState = Effect.fn("settings.read-stored")(function* (
  sql: SqlClient.SqlClient,
  configuration: MachineConfigurationService,
) {
  const rows = yield* readRows(sql, configuration);
  return yield* Effect.try({ try: () => decodeRows(rows), catch: stateFailure("decode") });
});

const readSettings = (sql: SqlClient.SqlClient, configuration: MachineConfigurationService) =>
  readStoredState(sql, configuration).pipe(Effect.map((stored) => stored?.settings));

const presentSettings = (bindings: CredentialBindings, settings: Settings) =>
  bindings.list.pipe(Effect.map((rows) => projectSettingsForRead(settings, rows)));

const encodedPreferences = (
  settings: Settings,
  options: {
    readonly retainHistorical?: Settings["providers"];
    readonly migratedSlots?: ReadonlySet<string>;
  } = {},
): string => JSON.stringify(preferencesFromSettings(settings, options));

const ensureBounded = (settings: Settings): void => {
  const bytes = Buffer.byteLength(JSON.stringify(settings), "utf8");
  if (bytes > SETTINGS_MAX_SERIALIZED_BYTES) {
    throw new SettingsError({
      code: "validation",
      message:
        `settings document exceeds ${SETTINGS_MAX_SERIALIZED_BYTES} byte ceiling`,
    });
  }
};

const writePreferences = Effect.fn("settings.write-preferences")(function* (
  sql: SqlClient.SqlClient,
  settings: Settings,
  updatedAt: string,
  options: {
    readonly retainHistorical?: Settings["providers"];
    readonly migratedSlots?: ReadonlySet<string>;
  } = {},
) {
  const body = yield* Effect.try({
    try: () => {
      ensureBounded(settings);
      return encodedPreferences(settings, options);
    },
    catch: stateFailure("encode"),
  });
  yield* sql.unsafe(UPSERT_PREFERENCES_SQL, [
    settings.version,
    body,
    updatedAt,
  ]);
});

const writeInitialSettings = Effect.fn("settings.write-initial")(function* (
  sql: SqlClient.SqlClient,
  settings: Settings,
) {
  const updatedAt = new Date().toISOString();
  yield* writePreferences(sql, settings, updatedAt);
  yield* sql.unsafe(INSERT_INITIALIZATION_SQL, [updatedAt]);
});

const initializeSettings = (
  sql: SqlClient.SqlClient,
  configuration: MachineConfigurationService,
): Effect.Effect<StoredSettingsState, SettingsError> =>
  transaction(
    sql,
    "settings.initialize",
    Effect.gen(function* () {
      const raced = yield* readStoredState(sql, configuration);
      if (raced !== undefined) return raced;
      yield* writeInitialSettings(sql, defaultSettings());
      const stored = yield* readStoredState(sql, configuration);
      if (stored === undefined) {
        return yield* new SettingsError({
          code: "corrupt",
          message: "canonical settings initialization did not persist",
        });
      }
      return stored;
    }),
  );

const ensureMachineConfiguration = (
  sql: SqlClient.SqlClient,
  configuration: MachineConfigurationService,
): Effect.Effect<void, SettingsError> =>
  transaction(sql, "settings.ensure-machine", Effect.gen(function* () {
    if ((yield* configuration.read) !== undefined) return;
    const name = yield* Schema.decodeUnknownEffect(MachineName)(defaultMachineName());
    yield* configuration.write({ name, supervisedPreferred: false }, new Date().toISOString());
  }));

type MutationResult = {
  readonly settings: Settings;
  readonly changed: boolean;
  readonly retired?: ReadonlyArray<string>;
};

const sameSettings = (left: Settings, right: Settings): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const publishAfterCommit = (
  result: MutationResult,
  listeners: ReadonlySet<(settings: Settings) => void>,
  onPublish?: (settings: Settings) => void,
): Settings => {
  if (!result.changed) return result.settings;
  onPublish?.(result.settings);
  for (const listener of listeners) {
    try {
      listener(result.settings);
    } catch {
      console.warn("[junto:settings] subscriber failed");
    }
  }
  return result.settings;
};

/**
 * Build one service instance over the already-open StateEngine.
 *
 * Initialization is eager so IPC and control surfaces cannot observe an
 * uninitialized or half-present settings aggregate.
 */
export const makeSettingsService = (
  databasePath: string,
  options: SettingsServiceOptions = {},
): Effect.Effect<SettingsServiceApi, SettingsError, SqlClient.SqlClient | CredentialBindingRepository | MachineConfigurationRepository> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const bindings = yield* CredentialBindingRepository;
    const machineConfiguration = yield* MachineConfigurationRepository;
    const probeSupervised =
      options.probeSupervised ?? probeSupervisedRuntime;
    const credentials =
      options.credentials ??
      openFileCredentialStore(join(dirname(databasePath), "credentials"));
    yield* ensureMachineConfiguration(sql, machineConfiguration);
    yield* initializeSettings(sql, machineConfiguration);
    const migrated = yield* Effect.result(
      transaction(sql, "settings.migrate-provider-secrets", Effect.gen(function* () {
        yield* reconcileCredentialVault(bindings, credentials);
        const current = yield* readSettings(sql, machineConfiguration);
        if (current === undefined) {
          return { retired: [] as ReadonlyArray<string> };
        }
        const next = yield* migrateHistoricalProviderSecrets(
          bindings,
          credentials,
          current,
        );
        if (!sameSettings(current, next.settings)) {
          yield* writePreferences(sql, next.settings, new Date().toISOString());
        }
        return { retired: next.retired };
      })),
    );
    if (Result.isSuccess(migrated) && migrated.success.retired.length > 0) {
      yield* transaction(sql, "settings.retire-migrated-secrets",
        retireVaultSecrets(bindings, credentials, migrated.success.retired),
      ).pipe(Effect.result);
    }
    const listeners = new Set<(settings: Settings) => void>();
    const readResolved = Effect.gen(function* () {
      const settings = yield* readSettings(sql, machineConfiguration);
      if (settings === undefined) return {};
      return yield* resolveProviderSecrets(bindings, credentials, settings);
    });
    let resolvedProviders: ProvidersSettings = yield* read(
      sql,
      "settings.prime-providers",
      readResolved,
    );

    const get = read(sql, "settings.get", Effect.gen(function* () {
      const settings = yield* readSettings(sql, machineConfiguration);
      if (settings === undefined) {
        return yield* new SettingsError({
          code: "corrupt",
          message: "canonical settings rows disappeared after initialization",
        });
      }
      return yield* presentSettings(bindings, settings);
    }));

    const resolveProviders = Effect.sync(() => resolvedProviders).pipe(
      Effect.withSpan("settings.resolve-providers"),
    );

    const patch = Effect.fn("SettingsService.patch")(function* (
      input: unknown,
    ) {
      const decoded = decodePatchInput(input);
      if (Result.isFailure(decoded)) return yield* decoded.failure;
      if (decoded.success.machine !== undefined) {
        return yield* new SettingsError({
          message:
            "Machine settings are protected; use settingsSetMachinePreferences for supervision or machine.configure for its name.",
          code: "validation",
        });
      }
      const secretOps = decoded.success.providers === undefined
        ? []
        : providerSecretOpsFromPatch(decoded.success.providers);
      if (secretOps.some((op) => op.op.kind === "set") && !credentials.available) {
        return yield* new SettingsError({
          code: "io",
          message: "credential vault is unavailable",
        });
      }
      let staged: ReadonlyArray<StagedSecret> = [];
      const outcome = yield* Effect.result(
        Effect.gen(function* () {
          staged = yield* stageSecretValues(credentials, secretOps).pipe(Effect.mapError(stateFailure("stage-secrets")));
          const result: MutationResult = yield* transaction(
            sql,
            "settings.patch",
            Effect.gen(function* () {
              const current = yield* readSettings(sql, machineConfiguration);
              if (current === undefined) {
                return yield* new SettingsError({
                  code: "corrupt",
                  message: "canonical settings rows are missing",
                });
              }
              const presented = yield* presentSettings(bindings, current);
              const validated = applyAndValidatePatch(presented, decoded.success);
              if (Result.isFailure(validated)) return yield* validated.failure;
              const retired = yield* commitProviderSecretOps(bindings, secretOps, staged);
              const migratedSlots = new Set(secretOps.map((op) => op.slot));
              const durable: Settings = {
                ...validated.success,
                providers: persistableProviders(validated.success.providers),
              };
              if (
                sameSettings(current, durable) &&
                secretOps.length === 0
              ) {
                return {
                  settings: yield* presentSettings(bindings, current),
                  changed: false,
                };
              }
              yield* writePreferences(sql, durable, new Date().toISOString(), {
                retainHistorical: current.providers,
                migratedSlots,
              });
              return {
                settings: yield* presentSettings(bindings, durable),
                changed: true,
                retired,
              };
            }),
          );
          return result;
        }),
      );
      if (Result.isFailure(outcome)) {
        discardStagedSecrets(credentials, staged);
        return yield* outcome.failure;
      }
      const result = outcome.success;
      if ((result.retired ?? []).length > 0) {
        yield* transaction(sql, "settings.retire-secrets",
          retireVaultSecrets(bindings, credentials, result.retired ?? []),
        ).pipe(Effect.result);
      }
      if (result.changed) {
        resolvedProviders = yield* read(
          sql,
          "settings.refresh-providers",
          readResolved,
        );
      }
      return publishAfterCommit(result, listeners);
    });

    const setMachinePreferences = Effect.fn(
      "SettingsService.setMachinePreferences",
    )(function* (input: unknown) {
      const decoded = decodeMachinePreferencesPatch(input);
      if (Result.isFailure(decoded)) return yield* decoded.failure;
      const result: MutationResult = yield* transaction(
        sql,
        "settings.setMachinePreferences",
        Effect.gen(function* () {
          const current = yield* readSettings(sql, machineConfiguration);
          if (current === undefined) {
            return yield* new SettingsError({
              code: "corrupt",
              message: "canonical settings rows are missing",
            });
          }
          const requested = decoded.success;
          const validated = applyAndValidatePatch(current, { machine: requested });
          if (Result.isFailure(validated)) return yield* validated.failure;
          if (sameSettings(current, validated.success)) {
            return { settings: yield* presentSettings(bindings, current), changed: false };
          }
          yield* machineConfiguration.write(validated.success.machine, new Date().toISOString());
          return {
            settings: yield* presentSettings(bindings, validated.success),
            changed: true,
          };
        }),
      );
      return publishAfterCommit(result, listeners);
    });

    const reset = Effect.fn("SettingsService.reset")(function* (
      section?: SettingsSectionKey,
    ) {
      if (section === "machine") {
        return yield* new SettingsError({
          message:
            "Reset keeps this machine's name and supervision preference.",
          code: "validation",
        });
      }
      const result: MutationResult = yield* transaction(
        sql,
        "settings.reset",
        Effect.gen(function* () {
          const current = yield* readSettings(sql, machineConfiguration);
          if (current === undefined) {
            return yield* new SettingsError({
              code: "corrupt",
              message: "canonical settings rows are missing",
            });
          }
          const next: Settings =
            section === undefined
              ? { ...defaultSettings(), machine: current.machine }
              : section === "advanced" && current.advanced.experimental !== undefined
                // Experimental toggles live on their own tab; resetting
                // Advanced must not quietly turn those features off.
                ? {
                    ...current,
                    advanced: { ...defaultAdvanced(), experimental: current.advanced.experimental },
                  }
                : { ...current, [section]: defaultSection(section) };
          const retired =
            section === undefined || section === "providers"
              ? yield* commitProviderSecretOps(
                  bindings,
                  clearAllProviderSecretOps(),
                  [],
                )
              : [];
          const durable: Settings = {
            ...next,
            providers: persistableProviders(next.providers),
          };
          if (sameSettings(current, durable) && retired.length === 0) {
            return {
              settings: yield* presentSettings(bindings, current),
              changed: false,
            };
          }
          yield* writePreferences(sql, durable, new Date().toISOString(), {
            retainHistorical:
              section === undefined || section === "providers"
                ? undefined
                : current.providers,
          });
          return {
            settings: yield* presentSettings(bindings, durable),
            changed: true,
            retired,
          };
        }),
      );
      if ((result.retired ?? []).length > 0) {
        yield* transaction(sql, "settings.retire-reset-secrets",
          retireVaultSecrets(bindings, credentials, result.retired ?? []),
        ).pipe(Effect.result);
      }
      if (result.changed) {
        resolvedProviders = yield* read(
          sql,
          "settings.refresh-providers",
          readResolved,
        );
      }
      return publishAfterCommit(result, listeners);
    });

    const doctor = Effect.gen(function* () {
      const settings = yield* get;
      const supervisedInstalled = yield* Effect.tryPromise({
        try: () => probeSupervised(),
        catch: (error) =>
          new SettingsError({
            code: "io",
            message:
              `supervisor probe failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
          }),
      });
      const supervised = assessSupervisedRuntime({
        machineName: settings.machine.name,
        supervisedPreferred: settings.machine.supervisedPreferred,
        supervisedInstalled,
      });
      return {
        id: "settings",
        label: "User Settings",
        status:
          supervised.status === "warning"
            ? ("warning" as const)
            : ("ok" as const),
        detail: `junto.db - settings v${settings.version} - ${supervised.detail}`,
        metadata: {
          version: String(settings.version),
          ...supervised.metadata,
        },
      };
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed({
          id: "settings",
          label: "User Settings",
          status: "error" as const,
          detail: error.message,
        }),
      ),
      Effect.withSpan("settings.doctor"),
    );

    return {
      doctor,
      get,
      patch,
      setMachinePreferences,
      reset,
      resolveProviders,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    };
  });

export const makeSettingsLive = (
  options: SettingsServiceOptions = {},
): Layer.Layer<SettingsService, SettingsError, StateEngine | SqlClient.SqlClient> =>
  Layer.effect(
    SettingsService,
    Effect.gen(function* () {
      const state = yield* StateEngine;
      const service = yield* makeSettingsService(state.info.path, options);
      return SettingsService.of(service);
    }),
  ).pipe(Layer.provide([
    CredentialBindingRepository.layer,
    MachineConfigurationRepository.layer,
  ]));

/** Requires the app's single StateEngine instance. */
export const SettingsLive = makeSettingsLive();
