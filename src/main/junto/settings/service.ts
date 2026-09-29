import { Context, Effect, Result, Layer, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import type { ServiceCheck } from "@shared/contracts";
import {
  CommandCenterConfiguration,
  StationHostId,
} from "@shared/station-api";
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
import {
  assessSupervisedRuntime,
  DEFAULT_STATION_HOST_ID,
} from "@shared/station";
import {
  StateEngine,
  StateTransactionOperation,
} from "../state/service";
import { withSqlRead } from "../state/sql-read";
import {
  applyAndValidatePatch,
  decodePatchInput,
  decodeStationTopologyPatch,
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
  StationConfigurationRepository,
  stationSettingsFromConfiguration,
  type StoredStationConfiguration,
} from "../station/configuration-state";
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

/**
 * Settings preserves the renderer-facing aggregate while storing only ordinary
 * preferences. Its station section is a projection of station_configuration,
 * the sole normalized topology authority.
 */
/**
 * effect-foundation **S4-rest-main** (staged, not half-migrated):
 * - Canonical id: `@junto/SettingsService` — single definition; no dual path.
 * - Service id: Context.Service (Effect V4 live).
 * - Shape:
 *   `class SettingsService extends Context.Service<SettingsService, SettingsService>()("@junto/SettingsService") {}`
 * - Layer today: SettingsLive / makeSettingsLive — V4 rename candidate SettingsService.layer
 *   Do not dual-export Live + `.layer` names.
 */
export class SettingsService extends Context.Service<SettingsService,
  {
    readonly doctor: Effect.Effect<ServiceCheck>;
    readonly get: Effect.Effect<Settings, SettingsError>;
    readonly patch: (input: unknown) => Effect.Effect<Settings, SettingsError>;
    readonly setStationTopology: (
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
  readonly setStationTopology: (
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
  /**
   * When false, skip v1 auto-Command-Center (tests and Remote/headless
   * enrollment). GUI Command Center boots still default this on.
   */
  readonly ensureDefaultCommandCenter?: boolean;
  /** Override credential vault in tests. */
  readonly credentials?: CredentialStore;
};

/** Headless enrollment must not infer Command Center. Role is never inferred. */
export const shouldEnsureDefaultCommandCenter = (
  argv: readonly string[] = process.argv,
): boolean => !argv.includes("--junto-headless");

type StationConfigurationService = typeof StationConfigurationRepository.Service;
type CredentialBindings = typeof CredentialBindingRepository.Service;
type SettingsRows = {
  readonly preferences:
    | {
        readonly version: number;
        readonly body: string;
      }
    | undefined;
  readonly station: StoredStationConfiguration | undefined;
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
  configuration: StationConfigurationService,
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
  const station = yield* configuration.read.pipe(Effect.mapError((error) =>
    new SettingsError({
      code: "corrupt",
      message:
        `canonical station configuration is invalid: ${
          error instanceof Error ? error.message : String(error)
        }`,
    }),
  ));
  return {
    preferences:
      preferences._tag === "None"
        ? undefined
        : preferences.value,
    station,
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
      stationSettingsFromConfiguration(rows.station),
    ),
    initialization: rows.initialization,
  };
};

const readStoredState = Effect.fn("settings.read-stored")(function* (
  sql: SqlClient.SqlClient,
  configuration: StationConfigurationService,
) {
  const rows = yield* readRows(sql, configuration);
  return yield* Effect.try({ try: () => decodeRows(rows), catch: stateFailure("decode") });
});

const readSettings = (sql: SqlClient.SqlClient, configuration: StationConfigurationService) =>
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

/**
 * Old default-on Remote package mutation is not affirmative consent. Rewrite
 * the stored fleet row once when it still carries that inherited `true`.
 */
const repairFleetConsent = (
  sql: SqlClient.SqlClient,
  configuration: StationConfigurationService,
): Effect.Effect<void, SettingsError> =>
  transaction(
    sql,
    "settings.repair-fleet-consent",
    Effect.gen(function* () {
      const rows = yield* readRows(sql, configuration);
      if (rows.preferences === undefined) return;
      const body = yield* Effect.try({ try: () => parseBody(
        "stored settings preferences",
        rows.preferences!.body,
      ), catch: stateFailure("decode") });
      const fleet =
        typeof body === "object" && body !== null && "fleet" in body
          ? (body as { fleet?: { remoteManagedInstalls?: unknown; remoteManagedInstallsConsented?: unknown } }).fleet
          : undefined;
      if (
        fleet?.remoteManagedInstalls !== true
        || fleet.remoteManagedInstallsConsented === true
      ) {
        return;
      }
      const stored = yield* Effect.try({ try: () => decodeRows(rows), catch: stateFailure("decode") });
      if (stored === undefined) return;
      yield* writePreferences(
        sql,
        stored.settings,
        new Date().toISOString(),
      );
    }),
  );

const initializeSettings = (
  sql: SqlClient.SqlClient,
  configuration: StationConfigurationService,
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

const readPairing = (sql: SqlClient.SqlClient) => SqlSchema.findOneOption({
  Request: Schema.Void,
  Result: Schema.Struct({ paired: Schema.Number }),
  execute: () => sql`SELECT 1 AS paired FROM station_pairing WHERE singleton = 1`,
})(undefined);

/**
 * v1 is single-machine: every unset, unpaired installation becomes the local
 * Command Center. Remote pairing remains possible only via Station API (not
 * a first-run product path). Idempotent.
 */
const ensureDefaultCommandCenter = (
  sql: SqlClient.SqlClient,
  configuration: StationConfigurationService,
): Effect.Effect<void, SettingsError> =>
  transaction(sql, "settings.ensure-command-center", Effect.gen(function* () {
      if ((yield* readPairing(sql))._tag === "Some") return;
      if ((yield* configuration.read) !== undefined) return;
      const hostId = yield* Schema.decodeUnknownEffect(StationHostId)(DEFAULT_STATION_HOST_ID);
      yield* configuration.write(
        {
          role: "command-center",
          hostId,
          supervisedPreferred: false,
        },
        new Date().toISOString(),
      );
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
): Effect.Effect<SettingsServiceApi, SettingsError, SqlClient.SqlClient | CredentialBindingRepository | StationConfigurationRepository> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const bindings = yield* CredentialBindingRepository;
    const stationConfiguration = yield* StationConfigurationRepository;
    const probeSupervised =
      options.probeSupervised ?? probeSupervisedRuntime;
    const credentials =
      options.credentials ??
      openFileCredentialStore(join(dirname(databasePath), "credentials"));
    yield* initializeSettings(sql, stationConfiguration);
    yield* repairFleetConsent(sql, stationConfiguration);
    const migrated = yield* Effect.result(
      transaction(sql, "settings.migrate-provider-secrets", Effect.gen(function* () {
        yield* reconcileCredentialVault(bindings, credentials);
        const current = yield* readSettings(sql, stationConfiguration);
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
    if (
      options.ensureDefaultCommandCenter !== false &&
      shouldEnsureDefaultCommandCenter()
    ) {
      yield* ensureDefaultCommandCenter(sql, stationConfiguration);
    }

    const listeners = new Set<(settings: Settings) => void>();
    const readResolved = Effect.gen(function* () {
      const settings = yield* readSettings(sql, stationConfiguration);
      if (settings === undefined) return {};
      return yield* resolveProviderSecrets(bindings, credentials, settings);
    });
    let resolvedProviders: ProvidersSettings = yield* read(
      sql,
      "settings.prime-providers",
      readResolved,
    );

    const get = read(sql, "settings.get", Effect.gen(function* () {
      const settings = yield* readSettings(sql, stationConfiguration);
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
      if (decoded.success.station !== undefined) {
        return yield* new SettingsError({
          message:
            "the machine role is protected — use settingsSetStationTopology to establish or update the local Command Center",
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
              const current = yield* readSettings(sql, stationConfiguration);
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

    const setStationTopology = Effect.fn(
      "SettingsService.setStationTopology",
    )(function* (input: unknown) {
      const decoded = decodeStationTopologyPatch(input);
      if (Result.isFailure(decoded)) return yield* decoded.failure;
      const result: MutationResult = yield* transaction(
        sql,
        "settings.setStationTopology",
        Effect.gen(function* () {
          const current = yield* readSettings(sql, stationConfiguration);
          if (current === undefined) {
            return yield* new SettingsError({
              code: "corrupt",
              message: "canonical settings rows are missing",
            });
          }
          const requested = decoded.success;
          const validated = applyAndValidatePatch(current, {
            station: requested,
          });
          if (Result.isFailure(validated)) return yield* validated.failure;
          if (sameSettings(current, validated.success)) {
            return {
              settings: yield* presentSettings(bindings, current),
              changed: false,
            };
          }

          if (current.station.role === "remote") {
            return yield* new SettingsError({
              message:
                "Remote topology is configured only by the paired Command Center through the Station API",
              code: "validation",
            });
          }

          const previousRole = current.station.role;
          const nextRole = validated.success.station.role;
          if (nextRole === "remote") {
            return yield* new SettingsError({
              message:
                "Remote topology requires Command Center pairing and Station API configuration",
              code: "validation",
            });
          }

          const established =
            current.station.role === "command-center";
          if (established) {
            const frozen: ReadonlyArray<{
              readonly key: string;
              readonly next: string | undefined;
              readonly previous: string | undefined;
            }> = [
              {
                key: "role",
                next: requested.role,
                previous: current.station.role,
              },
              {
                key: "hostId",
                next: requested.hostId,
                previous: current.station.hostId,
              },
              {
                key: "agentHostId",
                next: requested.agentHostId,
                previous: current.station.agentHostId,
              },
            ];
            for (const field of frozen) {
              if (
                field.next !== undefined &&
                field.next !== field.previous
              ) {
                return yield* new SettingsError({
                  message:
                    `Established Command Center topology freezes ${field.key} — only supervisedPreferred may change`,
                  code: "validation",
                });
              }
            }
          }

          if (previousRole === "command-center" && nextRole !== previousRole) {
            return yield* new SettingsError({
              message:
                "Command Center role cannot be cleared or changed from Settings",
              code: "validation",
            });
          }
          if (nextRole === "") {
            return yield* new SettingsError({
              message:
                "An unset station is represented by no configuration; choose Command Center locally or configure Remote from a Command Center",
              code: "validation",
            });
          }
          if (validated.success.station.agentHostId !== undefined) {
            return yield* new SettingsError({
              message:
                "Command Center topology cannot carry Remote-only identity fields",
              code: "validation",
            });
          }
          const configuration = Schema.decodeUnknownResult(
            CommandCenterConfiguration,
            { onExcessProperty: "error" },
          )({
            role: "command-center",
            hostId: validated.success.station.hostId,
            supervisedPreferred:
              validated.success.station.supervisedPreferred,
          });
          if (Result.isFailure(configuration)) {
            return yield* new SettingsError({
              message: "Command Center topology is invalid",
              code: "validation",
            });
          }
          const pairing = yield* readPairing(sql);
          if (pairing._tag === "Some") {
            return yield* new SettingsError({
              message:
                "A paired installation cannot become Command Center; pairing is immutable Remote intent",
              code: "validation",
            });
          }
          yield* stationConfiguration.write(
            configuration.success,
            new Date().toISOString(),
          );
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
      if (section === "station") {
        return yield* new SettingsError({
          message:
            "This machine's role can't be changed from Settings.",
          code: "validation",
        });
      }
      const result: MutationResult = yield* transaction(
        sql,
        "settings.reset",
        Effect.gen(function* () {
          const current = yield* readSettings(sql, stationConfiguration);
          if (current === undefined) {
            return yield* new SettingsError({
              code: "corrupt",
              message: "canonical settings rows are missing",
            });
          }
          const next: Settings =
            section === undefined
              ? { ...defaultSettings(), station: current.station }
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
        role: settings.station.role,
        hostId: settings.station.hostId,
        supervisedPreferred: settings.station.supervisedPreferred,
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
      setStationTopology,
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
    StationConfigurationRepository.layer,
  ]));

/** Requires the app's single StateEngine instance. */
export const SettingsLive = makeSettingsLive();
