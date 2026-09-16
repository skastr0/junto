import { Context, Effect, Result, Layer, Schema } from "effect";
import type { ServiceCheck } from "@shared/contracts";
import {
  CommandCenterConfiguration,
  StationHostId,
} from "@shared/station-api";
import {
  SETTINGS_MAX_SERIALIZED_BYTES,
  SettingsError,
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
  StateEngineError,
  type StateOutputValue,
  type StateReader,
  type StateRow,
  type StateWriter,
} from "../state/service";
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
  selectStationConfiguration,
  stationSettingsFromConfiguration,
  writeStationConfiguration,
  type StoredStationConfiguration,
} from "../station/configuration-state";
import { listCredentialBindings } from "../credentials/bindings";
import {
  clearAllProviderSecretOps,
  commitProviderSecretOps,
  discardStagedSecrets,
  migrateHistoricalProviderSecrets,
  reconcileCredentialVault,
  resolveProviderSecrets,
  retireVaultSecrets,
  stageSecretValues,
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
 * - Canonical id: `@vellum/SettingsService` — single definition; no dual path.
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
): boolean => !argv.includes("--vellum-headless");

type StateService = Context.Service.Shape<typeof StateEngine>;
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
type PreferencesRow = Record<string, StateOutputValue> & {
  readonly version: number;
  readonly body: string;
};
type InitializationRow = Record<string, StateOutputValue> & {
  readonly initialized_at: string;
};

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

const stateFailure = (error: StateEngineError): SettingsError => {
  if (error.cause instanceof SettingsError) return error.cause;
  return new SettingsError({
    code: "io",
    message: `settings ${error.operation} failed: ${error.message}`,
  });
};

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

const readRows = (reader: StateReader): SettingsRows => {
  const preferences = reader.get<PreferencesRow>(SELECT_PREFERENCES_SQL);
  const initialization = reader.get<InitializationRow>(
    SELECT_INITIALIZATION_SQL,
  );
  let station: StoredStationConfiguration | undefined;
  try {
    station = selectStationConfiguration(reader);
  } catch (error) {
    throw new SettingsError({
      code: "corrupt",
      message:
        `canonical station configuration is invalid: ${
          error instanceof Error ? error.message : String(error)
        }`,
    });
  }
  return {
    preferences:
      preferences === undefined
        ? undefined
        : {
            version: Number(preferences.version),
            body: String(preferences.body),
          },
    station,
    initialization:
      initialization === undefined
        ? undefined
        : {
            initializedAt: String(initialization.initialized_at),
          },
  };
};

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

const readStoredState = (
  reader: StateReader,
): StoredSettingsState | undefined =>
  decodeRows(readRows(reader));

const readSettings = (reader: StateReader): Settings | undefined =>
  readStoredState(reader)?.settings;

const presentSettings = (reader: StateReader, settings: Settings): Settings =>
  projectSettingsForRead(settings, listCredentialBindings(reader));

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

const writePreferences = (
  writer: StateWriter,
  settings: Settings,
  updatedAt: string,
  options: {
    readonly retainHistorical?: Settings["providers"];
    readonly migratedSlots?: ReadonlySet<string>;
  } = {},
): void => {
  ensureBounded(settings);
  writer.run(UPSERT_PREFERENCES_SQL, [
    settings.version,
    encodedPreferences(settings, options),
    updatedAt,
  ]);
};

const writeInitialSettings = (
  writer: StateWriter,
  settings: Settings,
): void => {
  const updatedAt = new Date().toISOString();
  writePreferences(writer, settings, updatedAt);
  writer.run(INSERT_INITIALIZATION_SQL, [updatedAt]);
};

/**
 * Old default-on Remote package mutation is not affirmative consent. Rewrite
 * the stored fleet row once when it still carries that inherited `true`.
 */
const repairFleetConsent = (
  state: StateService,
): Effect.Effect<void, SettingsError> =>
  state.transaction(
    "settings.repair-fleet-consent",
    (writer) => {
      const rows = readRows(writer);
      if (rows.preferences === undefined) return;
      const body = parseBody(
        "stored settings preferences",
        rows.preferences.body,
      );
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
      const stored = decodeRows(rows);
      if (stored === undefined) return;
      writePreferences(
        writer,
        stored.settings,
        new Date().toISOString(),
      );
    },
  ).pipe(
    Effect.mapError(stateFailure),
    Effect.withSpan("settings.repair-fleet-consent"),
  );

const initializeSettings = (
  state: StateService,
): Effect.Effect<StoredSettingsState, SettingsError> =>
  state.transaction(
    "settings.initialize",
    (writer) => {
      const raced = readStoredState(writer);
      if (raced !== undefined) return raced;
      writeInitialSettings(writer, defaultSettings());
      const stored = readStoredState(writer);
      if (stored === undefined) {
        throw new SettingsError({
          code: "corrupt",
          message: "canonical settings initialization did not persist",
        });
      }
      return stored;
    },
  ).pipe(
    Effect.mapError(stateFailure),
    Effect.withSpan("settings.initialize"),
  );

/**
 * v1 is single-machine: every unset, unpaired installation becomes the local
 * Command Center. Remote pairing remains possible only via Station API (not
 * a first-run product path). Idempotent.
 */
const ensureDefaultCommandCenter = (
  state: StateService,
): Effect.Effect<void, SettingsError> =>
  state
    .transaction("settings.ensure-command-center", (writer) => {
      const pairing = writer.get<StateRow>(
        `SELECT 1 AS paired
           FROM station_pairing
          WHERE singleton = 1`,
      );
      if (pairing !== undefined) return;
      if (selectStationConfiguration(writer) !== undefined) return;
      writeStationConfiguration(
        writer,
        {
          role: "command-center",
          hostId: Schema.decodeUnknownSync(StationHostId)(
            DEFAULT_STATION_HOST_ID,
          ),
          supervisedPreferred: false,
        },
        new Date().toISOString(),
      );
    })
    .pipe(
      Effect.mapError(stateFailure),
      Effect.withSpan("settings.ensure-command-center"),
    );

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
      console.warn("[vellum-command:settings] subscriber failed");
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
  state: StateService,
  options: SettingsServiceOptions = {},
): Effect.Effect<SettingsServiceApi, SettingsError> =>
  Effect.gen(function* () {
    const probeSupervised =
      options.probeSupervised ?? probeSupervisedRuntime;
    const credentials =
      options.credentials ??
      openFileCredentialStore(join(dirname(state.info.path), "credentials"));
    yield* initializeSettings(state);
    yield* repairFleetConsent(state);
    const migrated = yield* Effect.result(
      state.transaction("settings.migrate-provider-secrets", (writer) => {
        reconcileCredentialVault(writer, credentials);
        const current = readSettings(writer);
        if (current === undefined) {
          return { retired: [] as ReadonlyArray<string> };
        }
        const next = migrateHistoricalProviderSecrets(
          writer,
          credentials,
          current,
        );
        if (!sameSettings(current, next.settings)) {
          writePreferences(writer, next.settings, new Date().toISOString());
        }
        return { retired: next.retired };
      }).pipe(Effect.mapError(stateFailure)),
    );
    if (Result.isSuccess(migrated) && migrated.success.retired.length > 0) {
      yield* state.transaction("settings.retire-migrated-secrets", (writer) => {
        retireVaultSecrets(writer, credentials, migrated.success.retired);
      }).pipe(Effect.mapError(stateFailure), Effect.result);
    }
    if (
      options.ensureDefaultCommandCenter !== false &&
      shouldEnsureDefaultCommandCenter()
    ) {
      yield* ensureDefaultCommandCenter(state);
    }

    const listeners = new Set<(settings: Settings) => void>();
    const readResolved = (reader: StateReader): ProvidersSettings => {
      const settings = readSettings(reader);
      if (settings === undefined) return {};
      return resolveProviderSecrets(reader, credentials, settings);
    };
    let resolvedProviders: ProvidersSettings = yield* state.read(
      "settings.prime-providers",
      readResolved,
    ).pipe(Effect.mapError(stateFailure));

    const get = state.read("settings.get", (reader) => {
      const settings = readSettings(reader);
      if (settings === undefined) {
        throw new SettingsError({
          code: "corrupt",
          message: "canonical settings rows disappeared after initialization",
        });
      }
      return presentSettings(reader, settings);
    }).pipe(
      Effect.mapError(stateFailure),
      Effect.withSpan("settings.get"),
    );

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
      let staged: ReturnType<typeof stageSecretValues> = [];
      const outcome = yield* Effect.result(
        Effect.gen(function* () {
          staged = stageSecretValues(credentials, secretOps);
          return yield* state.transaction(
            "settings.patch",
            (writer): MutationResult => {
              const current = readSettings(writer);
              if (current === undefined) {
                throw new SettingsError({
                  code: "corrupt",
                  message: "canonical settings rows are missing",
                });
              }
              const presented = presentSettings(writer, current);
              const validated = applyAndValidatePatch(presented, decoded.success);
              if (Result.isFailure(validated)) throw validated.failure;
              const retired = commitProviderSecretOps(writer, secretOps, staged);
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
                  settings: presentSettings(writer, current),
                  changed: false,
                };
              }
              writePreferences(writer, durable, new Date().toISOString(), {
                retainHistorical: current.providers,
                migratedSlots,
              });
              return {
                settings: presentSettings(writer, durable),
                changed: true,
                retired,
              };
            },
          ).pipe(Effect.mapError(stateFailure));
        }),
      );
      if (Result.isFailure(outcome)) {
        discardStagedSecrets(credentials, staged);
        return yield* outcome.failure;
      }
      const result = outcome.success;
      if ((result.retired ?? []).length > 0) {
        yield* state.transaction("settings.retire-secrets", (writer) => {
          retireVaultSecrets(writer, credentials, result.retired ?? []);
        }).pipe(Effect.mapError(stateFailure), Effect.result);
      }
      if (result.changed) {
        resolvedProviders = yield* state.read(
          "settings.refresh-providers",
          readResolved,
        ).pipe(Effect.mapError(stateFailure));
      }
      return publishAfterCommit(result, listeners);
    });

    const setStationTopology = Effect.fn(
      "SettingsService.setStationTopology",
    )(function* (input: unknown) {
      const decoded = decodeStationTopologyPatch(input);
      if (Result.isFailure(decoded)) return yield* decoded.failure;
      const result = yield* state.transaction(
        "settings.setStationTopology",
        (writer): MutationResult => {
          const current = readSettings(writer);
          if (current === undefined) {
            throw new SettingsError({
              code: "corrupt",
              message: "canonical settings rows are missing",
            });
          }
          const requested = decoded.success;
          const validated = applyAndValidatePatch(current, {
            station: requested,
          });
          if (Result.isFailure(validated)) throw validated.failure;
          if (sameSettings(current, validated.success)) {
            return {
              settings: presentSettings(writer, current),
              changed: false,
            };
          }

          if (current.station.role === "remote") {
            throw new SettingsError({
              message:
                "Remote topology is configured only by the paired Command Center through the Station API",
              code: "validation",
            });
          }

          const previousRole = current.station.role;
          const nextRole = validated.success.station.role;
          if (nextRole === "remote") {
            throw new SettingsError({
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
                throw new SettingsError({
                  message:
                    `Established Command Center topology freezes ${field.key} — only supervisedPreferred may change`,
                  code: "validation",
                });
              }
            }
          }

          if (previousRole === "command-center" && nextRole !== previousRole) {
            throw new SettingsError({
              message:
                "Command Center role cannot be cleared or changed from Settings",
              code: "validation",
            });
          }
          if (nextRole === "") {
            throw new SettingsError({
              message:
                "An unset station is represented by no configuration; choose Command Center locally or configure Remote from a Command Center",
              code: "validation",
            });
          }
          if (validated.success.station.agentHostId !== undefined) {
            throw new SettingsError({
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
            throw new SettingsError({
              message: "Command Center topology is invalid",
              code: "validation",
            });
          }
          const pairing = writer.get<StateRow>(
            `SELECT 1 AS paired
               FROM station_pairing
              WHERE singleton = 1`,
          );
          if (pairing !== undefined) {
            throw new SettingsError({
              message:
                "A paired installation cannot become Command Center; pairing is immutable Remote intent",
              code: "validation",
            });
          }
          writeStationConfiguration(
            writer,
            configuration.success,
            new Date().toISOString(),
          );
          return {
            settings: presentSettings(writer, validated.success),
            changed: true,
          };
        },
      ).pipe(Effect.mapError(stateFailure));
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
      const result = yield* state.transaction(
        "settings.reset",
        (writer): MutationResult => {
          const current = readSettings(writer);
          if (current === undefined) {
            throw new SettingsError({
              code: "corrupt",
              message: "canonical settings rows are missing",
            });
          }
          const next: Settings =
            section === undefined
              ? { ...defaultSettings(), station: current.station }
              : { ...current, [section]: defaultSection(section) };
          const retired =
            section === undefined || section === "providers"
              ? commitProviderSecretOps(
                  writer,
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
              settings: presentSettings(writer, current),
              changed: false,
            };
          }
          writePreferences(writer, durable, new Date().toISOString(), {
            retainHistorical:
              section === undefined || section === "providers"
                ? undefined
                : current.providers,
          });
          return {
            settings: presentSettings(writer, durable),
            changed: true,
            retired,
          };
        },
      ).pipe(Effect.mapError(stateFailure));
      if ((result.retired ?? []).length > 0) {
        yield* state.transaction("settings.retire-reset-secrets", (writer) => {
          retireVaultSecrets(writer, credentials, result.retired ?? []);
        }).pipe(Effect.mapError(stateFailure), Effect.result);
      }
      if (result.changed) {
        resolvedProviders = yield* state.read(
          "settings.refresh-providers",
          readResolved,
        ).pipe(Effect.mapError(stateFailure));
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
        detail: `vellum-command.db - settings v${settings.version} - ${supervised.detail}`,
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
): Layer.Layer<SettingsService, SettingsError, StateEngine> =>
  Layer.effect(
    SettingsService,
    Effect.gen(function* () {
      const state = yield* StateEngine;
      const service = yield* makeSettingsService(state, options);
      return SettingsService.of(service);
    }),
  );

/** Requires the app's single StateEngine instance. */
export const SettingsLive = makeSettingsLive();
