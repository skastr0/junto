import { Schema } from "effect";
import {
  BROWSER_MAX_VISIBLE_SURFACES_HARD,
  BROWSER_MAX_WARM_SESSIONS_HARD,
} from "./browser-limits";
import { CANVAS_NAME_INPUT_PATTERN, CANVAS_NAME_MAX_LENGTH } from "./canvas-name";
import { DEFAULT_STATION_HOST_ID, STATION_ROLES } from "./station";

// Settings plane: one schema-validated aggregate in the app-owned SQLite
// database. Mutable user prefs are not Effect Config (boot/env) and not
// runtime kernel state.
//
// Aggregate: the preference row and normalized station_configuration state
// assemble into this single public value.
//
// Mental model:
// - **prefs** — appearance/canvas/kernel/browser/audio/advanced/fleet.
//   Generic settingsPatch mutates only their canonical row.
// - **topology** — derived from station_configuration. Local Settings may
//   establish a Command Center; Remote identity arrives only through pairing
//   and the Station API. Generic settingsPatch cannot write topology.
//
// Invariants:
// - Never store secrets here (full document is IPC-broadcast to all windows).
// - BrowserPrefs (maxVisible/maxWarm) is the sole durable SoT for those limits;
//   BrowserProfileService keeps profile identity/dirs/wipe only.
// - Kernel arming has normalized runtime-state rows — not a preference.

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
  Schema.maxLength(CANVAS_NAME_MAX_LENGTH),
  Schema.pattern(new RegExp(`^$|${CANVAS_NAME_INPUT_PATTERN.source}`)),
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

export const FleetDitherLevel = Schema.Literal(
  "fine",
  "balanced",
  "coarse",
);
export type FleetDitherLevel = typeof FleetDitherLevel.Type;

/**
 * Fleet operator prefs (not secrets). Kill-switch for remote package + plugin
 * installs; UI shows disabled buttons when false. Main re-gates every invoke.
 */
export const FleetSettings = Schema.Struct({
  /** Ordered-dither density for the Fleet map. */
  ditherLevel: FleetDitherLevel,
  /**
   * When false (default), remote T2 deploy and remote T3 plugin install refuse
   * even if the release line enables them. Local plugin install is unaffected.
   */
  remoteManagedInstalls: Schema.Boolean,
});
export type FleetSettings = typeof FleetSettings.Type;

// Station role: user-selected Command Center or Remote. Empty role means
// onboarding has not completed — UI must not guess.
export const StationRoleSetting = Schema.Literal(...STATION_ROLES, "");
export type StationRoleSetting = typeof StationRoleSetting.Type;

export const StationHostIdSetting = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(64),
  Schema.pattern(/^(?!-)[A-Za-z0-9][A-Za-z0-9._-]*$/),
);
export type StationHostIdSetting = typeof StationHostIdSetting.Type;

const WithoutRetiredTopologyIntegrity = Schema.Unknown.pipe(
  Schema.filter(
    (value) =>
      !(
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Object.prototype.hasOwnProperty.call(value, "topologyIntegrity")
      ),
    {
      message: () =>
        "topologyIntegrity is retired and must not be supplied",
    },
  ),
);

const StationSettingsValue = Schema.Struct({
  /** "" until the human picks a role at onboarding. */
  role: StationRoleSetting,
  /** This machine's host id in the fleet registry (usually "local" on first box). */
  hostId: StationHostIdSetting,
  /**
   * Canonical Hermes host prefix for agents running on this physical station.
   * Remote configure stamps the effective `hermesKeyFor(host)` so a distinct
   * registry hermesId remains the sole fleet transport identity.
   */
  agentHostId: Schema.optionalWith(StationHostIdSetting, { exact: true }),
  /** Prefer LaunchAgent supervised run (especially Remote). */
  supervisedPreferred: Schema.Boolean,
});
export const StationSettings = WithoutRetiredTopologyIntegrity.pipe(
  Schema.compose(StationSettingsValue, { strict: false }),
);
export type StationSettings = typeof StationSettings.Type;

// RTS UI SFX — per-clip enable + volume under a master mute/gain.
// Clip keys are camelCase; renderer maps alert ids (herdr-done → herdrDone).
const unitInterval = Schema.Number.pipe(Schema.between(0, 1));

export const SfxClipPrefs = Schema.Struct({
  enabled: Schema.Boolean,
  volume: unitInterval,
});
export type SfxClipPrefs = typeof SfxClipPrefs.Type;

export const SfxClipsSettings = Schema.Struct({
  blocked: SfxClipPrefs,
  permission: SfxClipPrefs,
  herdrDone: SfxClipPrefs,
  orphan: SfxClipPrefs,
  cycle: SfxClipPrefs,
});
export type SfxClipsSettings = typeof SfxClipsSettings.Type;

export const AudioSettings = Schema.Struct({
  muted: Schema.Boolean,
  masterVolume: unitInterval,
  clips: SfxClipsSettings,
});
export type AudioSettings = typeof AudioSettings.Type;

export const Settings = Schema.Struct({
  version: Schema.Literal(SETTINGS_VERSION),
  appearance: AppearanceSettings,
  canvas: CanvasSettings,
  kernel: KernelSettings,
  browser: BrowserPrefs,
  advanced: AdvancedSettings,
  audio: AudioSettings,
  station: StationSettings,
  fleet: FleetSettings,
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

export const FleetPatch = Schema.Struct({
  ditherLevel: Schema.optionalWith(FleetDitherLevel, { exact: true }),
  remoteManagedInstalls: Schema.optionalWith(Schema.Boolean, { exact: true }),
});
export type FleetPatch = typeof FleetPatch.Type;

const StationPatchValue = Schema.Struct({
  role: Schema.optionalWith(StationRoleSetting, { exact: true }),
  hostId: Schema.optionalWith(StationHostIdSetting, { exact: true }),
  agentHostId: Schema.optionalWith(StationHostIdSetting, { exact: true }),
  supervisedPreferred: Schema.optionalWith(Schema.Boolean, { exact: true }),
});
export const StationPatch = WithoutRetiredTopologyIntegrity.pipe(
  Schema.compose(StationPatchValue, { strict: false }),
);
export type StationPatch = typeof StationPatch.Type;

export const SfxClipPatch = Schema.Struct({
  enabled: Schema.optionalWith(Schema.Boolean, { exact: true }),
  volume: Schema.optionalWith(unitInterval, { exact: true }),
});
export type SfxClipPatch = typeof SfxClipPatch.Type;

export const SfxClipsPatch = Schema.Struct({
  blocked: Schema.optionalWith(SfxClipPatch, { exact: true }),
  permission: Schema.optionalWith(SfxClipPatch, { exact: true }),
  herdrDone: Schema.optionalWith(SfxClipPatch, { exact: true }),
  orphan: Schema.optionalWith(SfxClipPatch, { exact: true }),
  cycle: Schema.optionalWith(SfxClipPatch, { exact: true }),
});
export type SfxClipsPatch = typeof SfxClipsPatch.Type;

export const AudioPatch = Schema.Struct({
  muted: Schema.optionalWith(Schema.Boolean, { exact: true }),
  masterVolume: Schema.optionalWith(unitInterval, { exact: true }),
  clips: Schema.optionalWith(SfxClipsPatch, { exact: true }),
});
export type AudioPatch = typeof AudioPatch.Type;

export const SettingsPatch = Schema.Struct({
  appearance: Schema.optionalWith(AppearancePatch, { exact: true }),
  canvas: Schema.optionalWith(CanvasPatch, { exact: true }),
  kernel: Schema.optionalWith(KernelPatch, { exact: true }),
  browser: Schema.optionalWith(BrowserPatch, { exact: true }),
  advanced: Schema.optionalWith(AdvancedPatch, { exact: true }),
  audio: Schema.optionalWith(AudioPatch, { exact: true }),
  station: Schema.optionalWith(StationPatch, { exact: true }),
  fleet: Schema.optionalWith(FleetPatch, { exact: true }),
});
export type SettingsPatch = typeof SettingsPatch.Type;

export const SettingsSectionKey = Schema.Literal(
  "appearance",
  "canvas",
  "kernel",
  "browser",
  "advanced",
  "audio",
  "station",
  "fleet",
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

/** Fail-closed: remote package/plugin installs require explicit operator opt-in. */
export const defaultFleet = (): FleetSettings => ({
  ditherLevel: "fine",
  remoteManagedInstalls: false,
});

export const defaultStation = (): StationSettings => ({
  role: "",
  hostId: DEFAULT_STATION_HOST_ID,
  supervisedPreferred: false,
});

const defaultClip = (volume: number): SfxClipPrefs => ({ enabled: true, volume });

export const defaultSfxClips = (): SfxClipsSettings => ({
  blocked: defaultClip(0.55),
  permission: defaultClip(0.55),
  herdrDone: defaultClip(0.5),
  orphan: defaultClip(0.5),
  // Cycle is navigation chrome — keep quiet by default.
  cycle: defaultClip(0.18),
});

export const defaultAudio = (): AudioSettings => ({
  muted: false,
  masterVolume: 0.7,
  clips: defaultSfxClips(),
});

export const defaultSettings = (): Settings => ({
  version: SETTINGS_VERSION,
  appearance: defaultAppearance(),
  canvas: defaultCanvas(),
  kernel: defaultKernel(),
  browser: defaultBrowser(),
  advanced: defaultAdvanced(),
  audio: defaultAudio(),
  station: defaultStation(),
  fleet: defaultFleet(),
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
    case "audio":
      return defaultAudio();
    case "station":
      return defaultStation();
    case "fleet":
      return defaultFleet();
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
  if (patch.fleet) {
    next = { ...next, fleet: mergeSection(next.fleet, patch.fleet) };
  }
  if (patch.station) {
    next = { ...next, station: mergeSection(next.station, patch.station) };
  }
  if (patch.audio) {
    const audioPatch = patch.audio;
    let audio = next.audio;
    if (audioPatch.muted !== undefined || audioPatch.masterVolume !== undefined) {
      audio = mergeSection(audio, {
        muted: audioPatch.muted,
        masterVolume: audioPatch.masterVolume,
      });
    }
    if (audioPatch.clips) {
      let clips = audio.clips;
      for (const key of Object.keys(audioPatch.clips) as Array<keyof SfxClipsSettings>) {
        const clipPatch = audioPatch.clips[key];
        if (!clipPatch) continue;
        clips = { ...clips, [key]: mergeSection(clips[key], clipPatch) };
      }
      audio = { ...audio, clips };
    }
    next = { ...next, audio };
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

/** Hard ceiling for the serialized settings payload (prefs stay small). */
export const SETTINGS_MAX_SERIALIZED_BYTES = 64 * 1024;

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
