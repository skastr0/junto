import { Context, Effect, Either, Layer } from "effect";
import type { ServiceCheck } from "@shared/contracts";
import {
  SETTINGS_MAX_FILE_BYTES,
  SettingsError,
  defaultSection,
  defaultSettings,
  type Settings,
  type SettingsSectionKey,
} from "@shared/settings";
import { assessSupervisedRuntime } from "@shared/station";
import {
  StateEngine,
  StateEngineError,
  type StateOutputValue,
  type StateReader,
  type StateWriter,
} from "../state/service";
import {
  applyAndValidatePatch,
  decodePatchInput,
  decodeStationTopologyPatch,
} from "./migrate";
import {
  decodeStoredSettings,
  preferencesFromSettings,
} from "./state-schema";
import {
  probeSupervisedRuntime,
  type SupervisedProbe,
} from "./supervised-probe";

/**
 * Settings are a two-row aggregate in the sole app-owned SQLite database:
 * ordinary preferences and protected station topology. The split makes the
 * authorization boundary structural while preserving the existing aggregate
 * API for renderer consumers.
 */
export class SettingsService extends Context.Tag("@vellum/SettingsService")<
  SettingsService,
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
    readonly databasePath: () => string;
    readonly subscribe: (listener: (settings: Settings) => void) => () => void;
  }
>() {}

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
  readonly databasePath: () => string;
  readonly subscribe: (listener: (settings: Settings) => void) => () => void;
}

export type SettingsServiceOptions = {
  /** Override supervisor probe in tests. */
  readonly probeSupervised?: SupervisedProbe;
};

type StateService = Context.Tag.Service<typeof StateEngine>;
type SettingsRows = {
  readonly preferences:
    | {
        readonly version: number;
        readonly body: string;
      }
    | undefined;
  readonly topology:
    | {
        readonly body: string;
      }
    | undefined;
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
type TopologyRow = Record<string, StateOutputValue> & {
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
const SELECT_TOPOLOGY_SQL = `
  SELECT body
  FROM settings_station_topology
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
const UPSERT_TOPOLOGY_SQL = `
  INSERT INTO settings_station_topology(singleton, body, updated_at)
  VALUES (1, ?, ?)
  ON CONFLICT(singleton) DO UPDATE SET
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
  const topology = reader.get<TopologyRow>(SELECT_TOPOLOGY_SQL);
  const initialization = reader.get<InitializationRow>(
    SELECT_INITIALIZATION_SQL,
  );
  return {
    preferences:
      preferences === undefined
        ? undefined
        : {
            version: Number(preferences.version),
            body: String(preferences.body),
          },
    topology:
      topology === undefined
        ? undefined
        : { body: String(topology.body) },
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
    rows.topology === undefined &&
    rows.initialization === undefined
  ) {
    return undefined;
  }
  if (
    rows.preferences === undefined ||
    rows.topology === undefined ||
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
      parseBody("stored station topology", rows.topology.body),
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

const encodedPreferences = (settings: Settings): string =>
  JSON.stringify(preferencesFromSettings(settings));

const encodedTopology = (settings: Settings): string =>
  JSON.stringify(settings.station);

const ensureBounded = (settings: Settings): void => {
  const bytes = Buffer.byteLength(JSON.stringify(settings), "utf8");
  if (bytes > SETTINGS_MAX_FILE_BYTES) {
    throw new SettingsError({
      code: "validation",
      message:
        `settings document exceeds ${SETTINGS_MAX_FILE_BYTES} byte ceiling`,
    });
  }
};

const writePreferences = (
  writer: StateWriter,
  settings: Settings,
  updatedAt: string,
): void => {
  ensureBounded(settings);
  writer.run(UPSERT_PREFERENCES_SQL, [
    settings.version,
    encodedPreferences(settings),
    updatedAt,
  ]);
};

const writeTopology = (
  writer: StateWriter,
  settings: Settings,
  updatedAt: string,
): void => {
  ensureBounded(settings);
  writer.run(UPSERT_TOPOLOGY_SQL, [
    encodedTopology(settings),
    updatedAt,
  ]);
};

const writeInitialSettings = (
  writer: StateWriter,
  settings: Settings,
): void => {
  const updatedAt = new Date().toISOString();
  writePreferences(writer, settings, updatedAt);
  writeTopology(writer, settings, updatedAt);
  writer.run(INSERT_INITIALIZATION_SQL, [updatedAt]);
};

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

type MutationResult = {
  readonly settings: Settings;
  readonly changed: boolean;
};

const sameSettings = (left: Settings, right: Settings): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const publishAfterCommit = (
  result: MutationResult,
  listeners: ReadonlySet<(settings: Settings) => void>,
): Settings => {
  if (!result.changed) return result.settings;
  for (const listener of listeners) {
    try {
      listener(result.settings);
    } catch {
      console.warn("[vellum:settings] subscriber failed");
    }
  }
  return result.settings;
};

/**
 * Build one service instance over the already-open StateEngine.
 *
 * Initialization is eager so IPC and control surfaces cannot observe an
 * unimported or half-present settings aggregate.
 */
export const makeSettingsService = (
  state: StateService,
  options: SettingsServiceOptions = {},
): Effect.Effect<SettingsServiceApi, SettingsError> =>
  Effect.gen(function* () {
    const probeSupervised =
      options.probeSupervised ?? probeSupervisedRuntime;
    yield* initializeSettings(state);

    const listeners = new Set<(settings: Settings) => void>();

    const get = state.read("settings.get", (reader) => {
      const settings = readSettings(reader);
      if (settings === undefined) {
        throw new SettingsError({
          code: "corrupt",
          message: "canonical settings rows disappeared after initialization",
        });
      }
      return settings;
    }).pipe(
      Effect.mapError(stateFailure),
      Effect.withSpan("settings.get"),
    );

    const patch = Effect.fn("SettingsService.patch")(function* (
      input: unknown,
    ) {
      const decoded = decodePatchInput(input);
      if (Either.isLeft(decoded)) return yield* decoded.left;
      if (decoded.right.station !== undefined) {
        return yield* new SettingsError({
          message:
            "station topology is protected — use settingsSetStationTopology for role/host/commandCenterRef/supervisedPreferred",
          code: "validation",
        });
      }
      const result = yield* state.transaction(
        "settings.patch",
        (writer): MutationResult => {
          const current = readSettings(writer);
          if (current === undefined) {
            throw new SettingsError({
              code: "corrupt",
              message: "canonical settings rows are missing",
            });
          }
          const validated = applyAndValidatePatch(current, decoded.right);
          if (Either.isLeft(validated)) throw validated.left;
          if (sameSettings(current, validated.right)) {
            return { settings: current, changed: false };
          }
          writePreferences(writer, validated.right, new Date().toISOString());
          return { settings: validated.right, changed: true };
        },
      ).pipe(Effect.mapError(stateFailure));
      return publishAfterCommit(result, listeners);
    });

    const setStationTopology = Effect.fn(
      "SettingsService.setStationTopology",
    )(function* (input: unknown) {
      const decoded = decodeStationTopologyPatch(input);
      if (Either.isLeft(decoded)) return yield* decoded.left;
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
          const requested = decoded.right;
          const established =
            current.station.role === "command-center" ||
            current.station.role === "remote";
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
              {
                key: "commandCenterRef",
                next: requested.commandCenterRef,
                previous: current.station.commandCenterRef,
              },
            ];
            for (const field of frozen) {
              if (
                field.next !== undefined &&
                field.next !== field.previous
              ) {
                throw new SettingsError({
                  message:
                    `Established station topology freezes ${field.key} — only supervisedPreferred may change; role/host pairing migration requires an explicit Command Center transfer ceremony`,
                  code: "validation",
                });
              }
            }
          }

          const validated = applyAndValidatePatch(current, {
            station: requested,
          });
          if (Either.isLeft(validated)) throw validated.left;
          const previousRole = current.station.role;
          const nextRole = validated.right.station.role;
          if (
            (previousRole === "command-center" ||
              previousRole === "remote") &&
            nextRole !== previousRole
          ) {
            throw new SettingsError({
              message:
                "Station role migration requires an explicit Command Center transfer ceremony — Settings cannot promote, demote, or clear a protected role",
              code: "validation",
            });
          }
          if (sameSettings(current, validated.right)) {
            return { settings: current, changed: false };
          }
          writeTopology(writer, validated.right, new Date().toISOString());
          return { settings: validated.right, changed: true };
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
            "station topology cannot be reset from Settings — role migration requires an explicit Command Center transfer ceremony",
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
          if (sameSettings(current, next)) {
            return { settings: current, changed: false };
          }
          writePreferences(writer, next, new Date().toISOString());
          return { settings: next, changed: true };
        },
      ).pipe(Effect.mapError(stateFailure));
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
        detail: `vellum.db · settings v${settings.version} · ${supervised.detail}`,
        metadata: {
          version: String(settings.version),
          ...supervised.metadata,
        },
      };
    }).pipe(
      Effect.catchAll((error) =>
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
      databasePath: () => state.info.path,
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
