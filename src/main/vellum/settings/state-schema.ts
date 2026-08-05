import { Schema } from "effect";
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
 * Settings owns preferences only. Station topology is normalized separately
 * in station_configuration and is joined into the public aggregate on read.
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

const decodePreferences = Schema.decodeUnknownResult(
  StoredSettingsPreferences,
  { onExcessProperty: "error" },
);
const decodeTopology = Schema.decodeUnknownResult(StationSettings, {
  onExcessProperty: "error",
});

const formatParse = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

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

// Decode-admits-history: rows written before the theme rename may carry the
// retired mode value; it is today's "dark". The rename is value-level, so the
// stored document version and table DDL stay untouched; the next persist
// rewrites the value.
const migrateLegacyPreferences = (preferences: unknown): unknown => {
  if (typeof preferences !== "object" || preferences === null) {
    return preferences;
  }
  const appearance = (
    preferences as { appearance?: { theme?: unknown } }
  ).appearance;
  if (appearance?.theme !== "deep-field") {
    return preferences;
  }
  return {
    ...preferences,
    appearance: { ...appearance, theme: "dark" },
  };
};

export const decodeStoredSettings = (
  version: unknown,
  preferences: unknown,
  station: unknown,
): Settings => {
  if (version !== SETTINGS_VERSION) {
    throw new SettingsError({
      code: "corrupt",
      message: `stored settings version is invalid: ${String(version)}`,
    });
  }
  const decodedPreferences = decodePreferences(
    migrateLegacyPreferences(preferences),
  );
  if (decodedPreferences._tag === "Failure") {
    throw new SettingsError({
      code: "corrupt",
      message:
        `stored settings preferences are invalid: ${
          formatParse(decodedPreferences.failure)
        }`,
    });
  }
  const decodedTopology = decodeTopology(station);
  if (decodedTopology._tag === "Failure") {
    throw new SettingsError({
      code: "corrupt",
      message:
        `canonical station configuration projects invalid settings: ${
          formatParse(decodedTopology.failure)
        }`,
    });
  }
  return {
    version: SETTINGS_VERSION,
    ...decodedPreferences.success,
    station: decodedTopology.success,
  };
};
