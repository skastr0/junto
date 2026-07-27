import { ParseResult, Schema } from "effect";
import {
  AdvancedSettings,
  AppearanceSettings,
  AudioSettings,
  BrowserPrefs,
  CanvasSettings,
  FleetSettings,
  KernelSettings,
  SETTINGS_VERSION,
  SettingsError,
  StationSettings,
  type Settings,
} from "@shared/settings";

/**
 * Preferences and protected station topology deliberately occupy separate
 * rows. This is more than organization: generic preference transactions never
 * need write authority over station identity.
 */
export const SETTINGS_STATE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS settings_preferences (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    version INTEGER NOT NULL CHECK (version = ${SETTINGS_VERSION}),
    body TEXT NOT NULL
      CHECK (
        json_valid(body)
        AND json_type(body) = 'object'
        AND length(CAST(body AS BLOB)) <= 65536
      ),
    updated_at TEXT NOT NULL CHECK (length(updated_at) > 0)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS settings_station_topology (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    body TEXT NOT NULL
      CHECK (
        json_valid(body)
        AND json_type(body) = 'object'
        AND length(CAST(body AS BLOB)) <= 4096
      ),
    updated_at TEXT NOT NULL CHECK (length(updated_at) > 0)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS settings_initialization (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    initialized_at TEXT NOT NULL CHECK (length(initialized_at) > 0)
  ) STRICT;
`;

export const StoredSettingsPreferences = Schema.Struct({
  appearance: AppearanceSettings,
  canvas: CanvasSettings,
  kernel: KernelSettings,
  browser: BrowserPrefs,
  advanced: AdvancedSettings,
  audio: AudioSettings,
  fleet: FleetSettings,
});
export type StoredSettingsPreferences =
  typeof StoredSettingsPreferences.Type;

const decodePreferences = Schema.decodeUnknownEither(
  StoredSettingsPreferences,
);
const decodeTopology = Schema.decodeUnknownEither(StationSettings);

const formatParse = (error: ParseResult.ParseError): string =>
  ParseResult.TreeFormatter.formatErrorSync(error);

export const preferencesFromSettings = (
  settings: Settings,
): StoredSettingsPreferences => ({
  appearance: settings.appearance,
  canvas: settings.canvas,
  kernel: settings.kernel,
  browser: settings.browser,
  advanced: settings.advanced,
  audio: settings.audio,
  fleet: settings.fleet,
});

export const decodeStoredSettings = (
  version: unknown,
  preferences: unknown,
  topology: unknown,
): Settings => {
  if (version !== SETTINGS_VERSION) {
    throw new SettingsError({
      code: "corrupt",
      message: `stored settings version is invalid: ${String(version)}`,
    });
  }
  const decodedPreferences = decodePreferences(preferences);
  if (decodedPreferences._tag === "Left") {
    throw new SettingsError({
      code: "corrupt",
      message:
        `stored settings preferences are invalid: ${
          formatParse(decodedPreferences.left)
        }`,
    });
  }
  const decodedTopology = decodeTopology(topology);
  if (decodedTopology._tag === "Left") {
    throw new SettingsError({
      code: "corrupt",
      message:
        `stored station topology is invalid: ${
          formatParse(decodedTopology.left)
        }`,
    });
  }
  return {
    version: SETTINGS_VERSION,
    ...decodedPreferences.right,
    station: decodedTopology.right,
  };
};
