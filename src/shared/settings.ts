import { Schema } from "effect";
import {
  BROWSER_MAX_VISIBLE_SURFACES_HARD,
  BROWSER_MAX_WARM_SESSIONS_HARD,
} from "./browser-limits";

// Settings plane: one schema-validated durable document under
// ~/.vellum/settings.json. Mutable user prefs — not Effect Config (boot/env)
// and not StoreService (opaque runtime state like kernel arming).
//
// Aggregate: whole-file consistency. Sections are value objects; version
// ladders live in main/vellum/settings/migrate.ts.
//
// Invariants:
// - Never store secrets here (full document is IPC-broadcast to all windows).
// - BrowserPrefs (maxVisible/maxWarm) is the sole durable SoT for those limits;
//   BrowserProfileService keeps profile identity/dirs/wipe only.
// - Kernel arming stays in StoreService — not a preference.

export const SETTINGS_VERSION = 1 as const;

export const SettingsTheme = Schema.Literal("deep-field", "system");
export type SettingsTheme = typeof SettingsTheme.Type;

export const SettingsDensity = Schema.Literal("comfortable", "compact");
export type SettingsDensity = typeof SettingsDensity.Type;

const positiveInt = (min: number, max: number) =>
  Schema.Int.pipe(Schema.between(min, max));

export const AppearanceSettings = Schema.Struct({
  theme: SettingsTheme,
  density: SettingsDensity,
  reduceMotion: Schema.Boolean,
});
export type AppearanceSettings = typeof AppearanceSettings.Type;

// Canvas document names: empty (no preference) or the same charset canvases
// accept — bounded so a patch cannot bloat the durable document.
export const DefaultCanvasName = Schema.String.pipe(
  Schema.maxLength(64),
  Schema.pattern(/^$|^[a-z0-9][a-z0-9_-]*$/i),
);
export type DefaultCanvasName = typeof DefaultCanvasName.Type;

export const CanvasSettings = Schema.Struct({
  // Empty string = no preference (open seed / last-used via advanced).
  defaultCanvas: DefaultCanvasName,
  showMinimap: Schema.Boolean,
  fitOnOpen: Schema.Boolean,
});
export type CanvasSettings = typeof CanvasSettings.Type;

export const KernelSettings = Schema.Struct({
  // How many pulse log entries to retain in kernel snapshots / debug dump.
  pulseLogRetention: positiveInt(5, 500),
  debugVerbose: Schema.Boolean,
});
export type KernelSettings = typeof KernelSettings.Type;

// User-facing browser limits only. Profile registry (identity, dirs, wipe)
// stays in BrowserProfileService.
export const BrowserPrefs = Schema.Struct({
  maxVisibleSurfaces: positiveInt(1, BROWSER_MAX_VISIBLE_SURFACES_HARD),
  maxWarmSessions: positiveInt(1, BROWSER_MAX_WARM_SESSIONS_HARD),
});
export type BrowserPrefs = typeof BrowserPrefs.Type;

export const AdvancedSettings = Schema.Struct({
  openLastCanvas: Schema.Boolean,
});
export type AdvancedSettings = typeof AdvancedSettings.Type;

export const Settings = Schema.Struct({
  version: Schema.Literal(SETTINGS_VERSION),
  appearance: AppearanceSettings,
  canvas: CanvasSettings,
  kernel: KernelSettings,
  browser: BrowserPrefs,
  advanced: AdvancedSettings,
});
export type Settings = typeof Settings.Type;

// Partial patches: missing top-level keys leave the section unchanged;
// provided section objects deep-merge field-by-field (undefined fields keep
// current). Full section objects are still validated after merge.
export const AppearancePatch = Schema.Struct({
  theme: Schema.optionalWith(SettingsTheme, { exact: true }),
  density: Schema.optionalWith(SettingsDensity, { exact: true }),
  reduceMotion: Schema.optionalWith(Schema.Boolean, { exact: true }),
});
export type AppearancePatch = typeof AppearancePatch.Type;

export const CanvasPatch = Schema.Struct({
  defaultCanvas: Schema.optionalWith(DefaultCanvasName, { exact: true }),
  showMinimap: Schema.optionalWith(Schema.Boolean, { exact: true }),
  fitOnOpen: Schema.optionalWith(Schema.Boolean, { exact: true }),
});
export type CanvasPatch = typeof CanvasPatch.Type;

export const KernelPatch = Schema.Struct({
  pulseLogRetention: Schema.optionalWith(positiveInt(5, 500), { exact: true }),
  debugVerbose: Schema.optionalWith(Schema.Boolean, { exact: true }),
});
export type KernelPatch = typeof KernelPatch.Type;

export const BrowserPatch = Schema.Struct({
  maxVisibleSurfaces: Schema.optionalWith(
    positiveInt(1, BROWSER_MAX_VISIBLE_SURFACES_HARD),
    { exact: true },
  ),
  maxWarmSessions: Schema.optionalWith(
    positiveInt(1, BROWSER_MAX_WARM_SESSIONS_HARD),
    { exact: true },
  ),
});
export type BrowserPatch = typeof BrowserPatch.Type;

export const AdvancedPatch = Schema.Struct({
  openLastCanvas: Schema.optionalWith(Schema.Boolean, { exact: true }),
});
export type AdvancedPatch = typeof AdvancedPatch.Type;

export const SettingsPatch = Schema.Struct({
  appearance: Schema.optionalWith(AppearancePatch, { exact: true }),
  canvas: Schema.optionalWith(CanvasPatch, { exact: true }),
  kernel: Schema.optionalWith(KernelPatch, { exact: true }),
  browser: Schema.optionalWith(BrowserPatch, { exact: true }),
  advanced: Schema.optionalWith(AdvancedPatch, { exact: true }),
});
export type SettingsPatch = typeof SettingsPatch.Type;

export const SettingsSectionKey = Schema.Literal(
  "appearance",
  "canvas",
  "kernel",
  "browser",
  "advanced",
);
export type SettingsSectionKey = typeof SettingsSectionKey.Type;

export const defaultAppearance = (): AppearanceSettings => ({
  theme: "deep-field",
  density: "comfortable",
  reduceMotion: false,
});

export const defaultCanvas = (): CanvasSettings => ({
  defaultCanvas: "",
  showMinimap: false,
  fitOnOpen: true,
});

export const defaultKernel = (): KernelSettings => ({
  pulseLogRetention: 20,
  debugVerbose: false,
});

export const defaultBrowser = (): BrowserPrefs => ({
  maxVisibleSurfaces: 2,
  maxWarmSessions: 3,
});

export const defaultAdvanced = (): AdvancedSettings => ({
  openLastCanvas: true,
});

export const defaultSettings = (): Settings => ({
  version: SETTINGS_VERSION,
  appearance: defaultAppearance(),
  canvas: defaultCanvas(),
  kernel: defaultKernel(),
  browser: defaultBrowser(),
  advanced: defaultAdvanced(),
});

export const defaultSection = (key: SettingsSectionKey): Settings[SettingsSectionKey] => {
  switch (key) {
    case "appearance":
      return defaultAppearance();
    case "canvas":
      return defaultCanvas();
    case "kernel":
      return defaultKernel();
    case "browser":
      return defaultBrowser();
    case "advanced":
      return defaultAdvanced();
  }
};

/** Shallow field merge: defined patch keys overwrite current. */
export const mergeSection = <S extends Record<string, unknown>>(
  current: S,
  patch: Readonly<Partial<S>>,
): S => {
  const next = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) {
      (next as Record<string, unknown>)[key] = value;
    }
  }
  return next;
};

export const applySettingsPatch = (current: Settings, patch: SettingsPatch): Settings => {
  let next: Settings = current;
  if (patch.appearance) {
    next = { ...next, appearance: mergeSection(next.appearance, patch.appearance) };
  }
  if (patch.canvas) {
    next = { ...next, canvas: mergeSection(next.canvas, patch.canvas) };
  }
  if (patch.kernel) {
    next = { ...next, kernel: mergeSection(next.kernel, patch.kernel) };
  }
  if (patch.browser) {
    next = { ...next, browser: mergeSection(next.browser, patch.browser) };
  }
  if (patch.advanced) {
    next = { ...next, advanced: mergeSection(next.advanced, patch.advanced) };
  }
  return next;
};

export const SettingsErrorCode = Schema.Literal("validation", "io", "corrupt", "unsupported");
export type SettingsErrorCode = typeof SettingsErrorCode.Type;

export class SettingsError extends Schema.TaggedError<SettingsError>()("SettingsError", {
  message: Schema.String,
  code: SettingsErrorCode,
}) {}

// Wire result for IPC. Same ok/code/message shape as browser/herdr ops, with a
// monomorphic `settings` payload (always the full aggregate, never generic data).
export interface SettingsOpResult {
  readonly ok: boolean;
  readonly settings?: Settings;
  readonly code?: SettingsErrorCode;
  readonly message?: string;
}

/** Hard ceiling for the durable settings file (prefs stay small). */
export const SETTINGS_MAX_FILE_BYTES = 64 * 1024;

export const settingsOpOk = (settings: Settings): SettingsOpResult => ({
  ok: true,
  settings,
});

export const settingsOpFail = (
  code: SettingsErrorCode,
  message: string,
): SettingsOpResult => ({
  ok: false,
  code,
  message,
});
