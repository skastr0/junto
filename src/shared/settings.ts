import { Schema } from "effect";
import {
  BROWSER_MAX_VISIBLE_SURFACES_HARD,
  BROWSER_MAX_WARM_SESSIONS_HARD,
} from "./browser-limits";
import { CANVAS_NAME_INPUT_PATTERN, CANVAS_NAME_MAX_LENGTH } from "./canvas-name";
import { DEFAULT_STATION_HOST_ID, STATION_ROLES } from "./station";
import { NATIVE_USAGE_PROVIDERS, NativeUsageProvider } from "./usage";

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
//   Provider secret values live in the OS-adjacent credential vault; this
//   document only carries MASKED_SECRET / non-secret metadata.
// - BrowserPrefs (maxVisible/maxWarm) is the sole durable SoT for those limits;
//   BrowserProfileService keeps profile identity/dirs/wipe only.
// - Kernel arming has normalized runtime-state rows — not a preference.

export const SETTINGS_VERSION = 1 as const;

export const SettingsTheme = Schema.Literals(["dark", "bright", "system"]);
export type SettingsTheme = typeof SettingsTheme.Type;

export const SettingsDensity = Schema.Literals(["comfortable", "compact"]);
export type SettingsDensity = typeof SettingsDensity.Type;

const positiveInt = (min: number, max: number) =>
  Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isBetween({ minimum: min, maximum: max })));

/**
 * Managed-agent appearance policy:
 * - `follow` — leverage Junto's xterm theme + live appearance
 *   protocol (recommended).
 * - `agent` — do not re-paint mid-session over agent colours.
 *
 * Neither policy changes how a harness is started. A seat Junto starts must
 * present the same experience as the same harness started by hand, so spawn
 * argv never carries an appearance flag under either policy.
 */
export const AgentAppearancePolicy = Schema.Literals(["follow", "agent"]);
export type AgentAppearancePolicy = typeof AgentAppearancePolicy.Type;

export const AppearanceSettings = Schema.Struct({
  theme: SettingsTheme,
  density: SettingsDensity,
  reduceMotion: Schema.Boolean,
  /**
   * Optional so installed rows written before this field still decode.
   * Absent ≡ `follow` (recommended default).
   */
  agentAppearance: Schema.optionalKey(AgentAppearancePolicy),
});
export type AppearanceSettings = typeof AppearanceSettings.Type;

// Canvas document names: empty (no preference) or the same charset canvases
// accept — bounded so a patch cannot bloat the durable document.
export const DefaultCanvasName = Schema.String.pipe(
  Schema.check(Schema.isMaxLength(CANVAS_NAME_MAX_LENGTH)),
  Schema.check(Schema.isPattern(new RegExp(`^$|${CANVAS_NAME_INPUT_PATTERN.source}`))),
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
  // Retired Region Pulse product field. Optional so installed preference rows
  // that still carry the key decode under onExcessProperty:error; product
  // ignores the value. Not on KernelPatch / not in defaultKernel.
  pulseLogRetention: Schema.optionalKey(positiveInt(5, 500)),
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

const ToolDirectory = Schema.String.pipe(
  Schema.check(Schema.isMaxLength(1024)),
);
export const TOOL_DIRECTORIES_MAX = 32;

/** Bounded so a hand-edited row cannot grow without limit. */
const EXPERIMENTAL_OPT_INS_MAX = 64;
export const ExperimentalOptIns = Schema.Record(
  Schema.String.pipe(Schema.check(Schema.isMaxLength(64))),
  Schema.Boolean,
).pipe(
  Schema.check(
    Schema.makeFilter(
      (record: Readonly<Record<string, boolean>>) =>
        Object.keys(record).length <= EXPERIMENTAL_OPT_INS_MAX,
      { message: `at most ${EXPERIMENTAL_OPT_INS_MAX} experimental toggles` },
    ),
  ),
);

export const AdvancedSettings = Schema.Struct({
  openLastCanvas: Schema.Boolean,
  /**
   * Developer logs explorer — TopBar control + live ring over Effect logs /
   * main + renderer console. Off by default; process ring still captures so
   * enabling later has history. Optional on the wire so installed preference
   * rows without the key still decode (default false).
   */
  logsExplorer: Schema.optionalKey(Schema.Boolean),
  /**
   * Extra directories for detecting and launching agent CLIs. Optional so
   * rows written before this field still decode. Absent ≡ none. These rank
   * after the operator's login-shell PATH and ahead of the static floor.
   */
  toolDirectories: Schema.optionalKey(
    Schema.Array(ToolDirectory).pipe(
      Schema.check(Schema.isMaxLength(TOOL_DIRECTORIES_MAX)),
    ),
  ),
  /**
   * RETIRED: the old seat-awareness opt-out, from when Jev was on by default.
   * Seat awareness is now an experimental feature whose toggle is
   * `experimental.seatAwareness`. Kept so installed rows still decode; never
   * read.
   */
  seatAwareness: Schema.optionalKey(Schema.Boolean),
  /**
   * Experimental features the operator turned on, keyed by feature key
   * (`FeatureKey`). Only a feature this build compiled in as experimental
   * reads its entry; absent or false is off, which is the experimental
   * default. Optional so rows written before the Experimental tab decode.
   */
  experimental: Schema.optionalKey(ExperimentalOptIns),
  /**
   * The first-run introduction has been finished or skipped. Optional so rows
   * written before the introduction existed still decode; absent means not
   * seen, so an upgrade shows it once too.
   */
  onboardingSeen: Schema.optionalKey(Schema.Boolean),
});
export type AdvancedSettings = typeof AdvancedSettings.Type;

const harnessPrefString = (max: number) =>
  Schema.String.pipe(Schema.check(Schema.isMaxLength(max)));

/**
 * Per-harness spawn defaults (Settings → Agents when harnessSettings is on).
 * Absent fields mean "use product / cascade defaults".
 * `enabled: false` hides the harness from the palette even when the build flag
 * allows it (user opt-out). Absent or true = offer when installed.
 */
/** How many recently picked models the picker keeps per harness. */
export const RECENT_MODELS_MAX = 5;

/** Model ids, newest first: what the model picker shows above the full list. */
const RecentModels = Schema.Array(harnessPrefString(200)).pipe(
  Schema.check(Schema.isMaxLength(RECENT_MODELS_MAX * 4)),
);

export const HarnessInstancePrefs = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  model: Schema.optionalKey(harnessPrefString(200)),
  effort: Schema.optionalKey(harnessPrefString(64)),
  permissionMode: Schema.optionalKey(harnessPrefString(64)),
  recentModels: Schema.optionalKey(RecentModels),
});
export type HarnessInstancePrefs = typeof HarnessInstancePrefs.Type;

/**
 * Operator fine-config for managed harness instantiation.
 * Keys are HarnessId strings; unknown keys are ignored at apply time.
 * Optional on stored rows written before this section existed.
 */
export const HarnessesSettings = Schema.Struct({
  byHarness: Schema.Record(Schema.String, HarnessInstancePrefs),
});
export type HarnessesSettings = typeof HarnessesSettings.Type;

/**
 * DEPRECATED, frozen: per-seat portrait overrides as the settings row held
 * them before state migration 4 -> 5 copied them into junto.db
 * `portrait_overrides`. Never written or read by the app any more; the stored
 * copy passes through settings writes untouched (expand, preserve, deprecate)
 * until a later consolidate step retires it. Plain bounded strings so an old
 * row always decodes.
 */
const portraitTrait = Schema.String.pipe(Schema.check(Schema.isMaxLength(24)));
export const PortraitPrefs = Schema.Struct({
  bodyHue: Schema.optionalKey(portraitTrait),
  accentHue: Schema.optionalKey(portraitTrait),
  shape: Schema.optionalKey(portraitTrait),
  topper: Schema.optionalKey(portraitTrait),
  eyes: Schema.optionalKey(portraitTrait),
  mouth: Schema.optionalKey(portraitTrait),
  brows: Schema.optionalKey(portraitTrait),
  marking: Schema.optionalKey(portraitTrait),
  blush: Schema.optionalKey(Schema.Boolean),
  temperament: Schema.optionalKey(Schema.Number.pipe(Schema.check(Schema.isBetween({ minimum: -1, maximum: 1 })))),
});
export type PortraitPrefs = typeof PortraitPrefs.Type;

export const PortraitsSettings = Schema.Struct({
  bySeat: Schema.Record(Schema.String, PortraitPrefs),
});
export type PortraitsSettings = typeof PortraitsSettings.Type;

export const FleetDitherLevel = Schema.Literals(["fine", "balanced",
"coarse",]);
export type FleetDitherLevel = typeof FleetDitherLevel.Type;

/**
 * Fleet operator prefs (not secrets). Remote deployment kill switch; the UI
 * shows disabled controls when false and main re-gates every invoke.
 */
export const FleetSettings = Schema.Struct({
  /** Ordered-dither density for the Fleet map. */
  ditherLevel: FleetDitherLevel,
  /**
   * When false, managed Remote deployment refuses even if the release line
   * enables it. Fresh Command Centers require an explicit operator opt-in.
   * A stored `true` without `remoteManagedInstallsConsented` is the old
   * default, not affirmative consent, and decode treats it as off.
   */
  remoteManagedInstalls: Schema.Boolean,
  /**
   * Set only when the operator explicitly enables managed Remote installs
   * through Settings. Absent on rows written before this field.
   */
  remoteManagedInstallsConsented: Schema.optionalKey(Schema.Boolean),
});
export type FleetSettings = typeof FleetSettings.Type;

// Station role: Command Center (v1 default) or Remote (Station-API pairing only).
// Empty role is a transient pre-configuration state; SettingsService auto-establishes
// Command Center on first boot when unpaired.
export const StationRoleSetting = Schema.Literals([...STATION_ROLES, ""]);
export type StationRoleSetting = typeof StationRoleSetting.Type;

export const StationHostIdSetting = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(64)),
  Schema.check(Schema.isPattern(/^(?!-)[A-Za-z0-9][A-Za-z0-9._-]*$/)),
);
export type StationHostIdSetting = typeof StationHostIdSetting.Type;

const WithoutRetiredTopologyIntegrity = Schema.Unknown.pipe(
  Schema.check(Schema.makeFilter((value) =>
    !(
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.prototype.hasOwnProperty.call(value, "topologyIntegrity")
    ),
  {
    message: "topologyIntegrity is retired and must not be supplied",
  },)),
);

const StationSettingsValue = Schema.Struct({
  /** "" only before auto Command Center establish (or paired Remote). */
  role: StationRoleSetting,
  /** This machine's host id in the fleet registry (usually "local" on first box). */
  hostId: StationHostIdSetting,
  /**
   * Canonical Hermes host prefix for agents running on this physical station.
   * Remote configure stamps the effective `hermesKeyFor(host)` so a distinct
   * registry hermesId remains the sole fleet transport identity.
   */
  agentHostId: Schema.optionalKey(StationHostIdSetting),
  /** Prefer LaunchAgent supervised run (especially Remote). */
  supervisedPreferred: Schema.Boolean,
});
// V4: former compose(..., { strict: false }) + topologyIntegrity filter was a
// v3 parseOptions pattern. Use the value schema directly; excess keys rejected
// at decodeUnknownResult call sites via onExcessProperty where needed.
export const StationSettings = StationSettingsValue;
export type StationSettings = typeof StationSettings.Type;

// Sound: master mute and volume, then one enable + volume per sound family
// (`sounds`). `clips` is the retired sample pack's per-clip prefs: a frozen
// copy kept so rows that hold it still decode; nothing reads it.
const unitInterval = Schema.Number.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 1 })));

export const SfxClipPrefs = Schema.Struct({
  enabled: Schema.Boolean,
  volume: unitInterval,
});
export type SfxClipPrefs = typeof SfxClipPrefs.Type;

export const SfxClipsSettings = Schema.Struct({
  blocked: SfxClipPrefs,
  permission: SfxClipPrefs,
  orphan: SfxClipPrefs,
  cycle: SfxClipPrefs,
});
export type SfxClipsSettings = typeof SfxClipsSettings.Type;

/**
 * Sound families, most urgent first. Each cue belongs to exactly one; the
 * operator levels or silences a family, never a single cue.
 */
export const SOUND_CATEGORIES = ["attention", "review", "activity", "traffic", "interface"] as const;
export type SoundCategory = (typeof SOUND_CATEGORIES)[number];

export const SoundCategoriesSettings = Schema.Struct({
  attention: SfxClipPrefs,
  review: SfxClipPrefs,
  activity: SfxClipPrefs,
  traffic: SfxClipPrefs,
  interface: SfxClipPrefs,
});
export type SoundCategoriesSettings = typeof SoundCategoriesSettings.Type;

export const AudioSettings = Schema.Struct({
  muted: Schema.Boolean,
  masterVolume: unitInterval,
  /** DEPRECATED frozen copy of the retired sample pack's prefs. */
  clips: SfxClipsSettings,
  /** Absent on rows written before the sound engine; absent means the defaults. */
  sounds: Schema.optionalKey(SoundCategoriesSettings),
});
export type AudioSettings = typeof AudioSettings.Type;

// --- Terminal -------------------------------------------------------------
//
// Durable terminal preferences. Before this fragment the surface hardcoded
// every one of these, so each default below reproduces today's terminal
// exactly: an operator who never opens the tab sees no change.
//
// Panel grouping is presentation, not persistence. The fragment is flat:
// - Preference    scrollSensitivity, fontSize, fontFamily, cursorStyle, scrollback
// - Accessibility cursorBlink, minimumContrastRatio, lineHeight, letterSpacing,
//                 screenReaderMode, bell
//
// Every numeric field is range-checked, never merely typed. A preference row is
// durable and IPC-broadcast to every window, so an out-of-range value would
// follow the operator across restarts and wreck terminal geometry with no way
// back except a reset. `scrollback: 0` and `fontSize: 2000` must be
// unpersistable, not merely discouraged.
//
// Adding a field here later: give the new field Schema.optionalKey (the
// appearance.agentAppearance pattern) or installed rows that predate it stop
// decoding under onExcessProperty:error.

/** xterm cursor shapes. Mirrors xterm's `cursorStyle` option exactly. */
export const TerminalCursorStyle = Schema.Literals(["block", "bar", "underline"]);
export type TerminalCursorStyle = typeof TerminalCursorStyle.Type;

/**
 * Bell response. xterm 6 exposes no bell option at all -- only an `onBell`
 * event -- so this is a Junto behaviour the surface wires itself.
 * "off" is today's behaviour: nothing subscribes to onBell.
 */
export const TerminalBell = Schema.Literals(["off", "visual", "sound"]);
export type TerminalBell = typeof TerminalBell.Type;

/**
 * Fractional-friendly bound. isBetween alone also rejects NaN and Infinity
 * (both comparisons are false), so no separate finiteness check is needed.
 */
const boundedNumber = (min: number, max: number) =>
  Schema.Number.pipe(Schema.check(Schema.isBetween({ minimum: min, maximum: max })));

/**
 * The bounds the schema enforces, exported so a control surface clamps to the
 * same numbers rather than keeping a second, drifting copy.
 */
export const TERMINAL_BOUNDS = {
  /**
   * Lines per wheel notch. 1 is xterm's own default; 0 would kill the wheel
   * outright, and past ~20 a single notch throws away a screen of context.
   */
  scrollSensitivity: { min: 1, max: 20 },
  /**
   * Cell font size in px. Under 6px the measured advance width rounds toward
   * zero and poisons xterm's cell metrics for the life of the terminal; over
   * 48px an agent TUI's ~140-column layout no longer fits any laptop display.
   */
  fontSize: { min: 6, max: 48 },
  /**
   * Retained scrollback lines. 0 disables scrollback entirely, which removes
   * the normal-buffer wheel path the surface depends on. xterm stores roughly
   * 12 bytes per cell, so the ceiling is already ~120MB for one 200-column
   * terminal -- and a canvas holds many at once.
   */
  scrollback: { min: 100, max: 50_000 },
  /**
   * WCAG contrast ratio xterm enforces per cell. 1 is xterm's "no
   * enforcement"; 21 is the maximum ratio that exists (pure black on white).
   */
  minimumContrastRatio: { min: 1, max: 21 },
  /**
   * Multiple of font size. Under 1 the row clips ascenders and desyncs the
   * cell measure; over 2 half the viewport is empty leading.
   */
  lineHeight: { min: 1, max: 2 },
  /**
   * Extra px per cell. Negative spacing overlaps glyphs and breaks the
   * monospace grid the PTY column count is measured from; past 5px the line
   * stops reading as connected text.
   */
  letterSpacing: { min: 0, max: 5 },
  /** Font stack string. A preference row stays small and is broadcast over IPC. */
  fontFamily: { minLength: 1, maxLength: 200 },
} as const;

const TerminalFontFamily = Schema.String.pipe(
  Schema.check(Schema.isMinLength(TERMINAL_BOUNDS.fontFamily.minLength)),
  Schema.check(Schema.isMaxLength(TERMINAL_BOUNDS.fontFamily.maxLength)),
);

export const TerminalSettings = Schema.Struct({
  scrollSensitivity: positiveInt(
    TERMINAL_BOUNDS.scrollSensitivity.min,
    TERMINAL_BOUNDS.scrollSensitivity.max,
  ),
  fontSize: positiveInt(TERMINAL_BOUNDS.fontSize.min, TERMINAL_BOUNDS.fontSize.max),
  fontFamily: TerminalFontFamily,
  cursorStyle: TerminalCursorStyle,
  scrollback: positiveInt(TERMINAL_BOUNDS.scrollback.min, TERMINAL_BOUNDS.scrollback.max),
  /**
   * Gates blinking; it does not own it. The surface already drives
   * `cursorBlink` from surface visibility so a hidden terminal stops forcing
   * repaints. The effective value is this preference AND that visibility --
   * false here means never blink, true means blink exactly as today.
   */
  cursorBlink: Schema.Boolean,
  minimumContrastRatio: boundedNumber(
    TERMINAL_BOUNDS.minimumContrastRatio.min,
    TERMINAL_BOUNDS.minimumContrastRatio.max,
  ),
  lineHeight: boundedNumber(TERMINAL_BOUNDS.lineHeight.min, TERMINAL_BOUNDS.lineHeight.max),
  letterSpacing: boundedNumber(
    TERMINAL_BOUNDS.letterSpacing.min,
    TERMINAL_BOUNDS.letterSpacing.max,
  ),
  screenReaderMode: Schema.Boolean,
  bell: TerminalBell,
  /** Optional so installed settings rows keep decoding; absent means off. */
  copyOnSelect: Schema.optionalKey(Schema.Boolean),
});
export type TerminalSettings = typeof TerminalSettings.Type;

/** GPT-Live voice and its delegated reasoning model have independent identities. */
export const LIVE_VOICE_USD_PER_MINUTE = 0.05;
export const LIVE_INITIAL_BILLING_SECONDS = 15;
export const LIVE_SETTINGS_BOUNDS = {
  maxCallMinutes: { min: 1, max: 120 },
  maxVoiceCostUsd: { min: 0.05, max: 100 },
} as const;

const LiveBackendModel = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(200)),
  Schema.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/)),
);
const LiveMaxCallMinutes = positiveInt(
  LIVE_SETTINGS_BOUNDS.maxCallMinutes.min,
  LIVE_SETTINGS_BOUNDS.maxCallMinutes.max,
);
const LiveMaxVoiceCostUsd = boundedNumber(
  LIVE_SETTINGS_BOUNDS.maxVoiceCostUsd.min,
  LIVE_SETTINGS_BOUNDS.maxVoiceCostUsd.max,
);

export const LiveSettings = Schema.Struct({
  backendModel: LiveBackendModel,
  maxCallMinutes: LiveMaxCallMinutes,
  /** Per-call voice estimate only; backend token charges are separate. */
  maxVoiceCostUsd: LiveMaxVoiceCostUsd,
});
export type LiveSettings = typeof LiveSettings.Type;

export const LivePatch = Schema.Struct({
  backendModel: Schema.optionalKey(LiveBackendModel),
  maxCallMinutes: Schema.optionalKey(LiveMaxCallMinutes),
  maxVoiceCostUsd: Schema.optionalKey(LiveMaxVoiceCostUsd),
});
export type LivePatch = typeof LivePatch.Type;

/**
 * Quick replies: the one-click answers offered on every open agent signal
 * (feed cards and the seat sidebar). Each is sent through the same answer
 * path as a typed reply, so it lands as operator mail. Short single lines;
 * the list is tiny by construction.
 */
export const QUICK_REPLY_BOUNDS = { maxCount: 12, maxChars: 80 } as const;

export const QuickReplyText = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(QUICK_REPLY_BOUNDS.maxChars)),
  Schema.check(Schema.isPattern(/^\S(?:[^\r\n]*\S)?$/)),
);

const QuickReplyList = Schema.Array(QuickReplyText).pipe(
  Schema.check(Schema.isMaxLength(QUICK_REPLY_BOUNDS.maxCount)),
);

export const FeedSettings = Schema.Struct({
  quickReplies: QuickReplyList,
});
export type FeedSettings = typeof FeedSettings.Type;

export const FeedPatch = Schema.Struct({
  quickReplies: Schema.optionalKey(QuickReplyList),
});
export type FeedPatch = typeof FeedPatch.Type;

export const DEFAULT_QUICK_REPLIES: ReadonlyArray<string> = [
  "Yes",
  "No",
  "Continue",
  "Go on",
  "Stop doing this",
];

export const defaultFeed = (): FeedSettings => ({ quickReplies: [...DEFAULT_QUICK_REPLIES] });

export const feedSettings = (settings: Settings | undefined): FeedSettings =>
  settings?.feed ?? defaultFeed();

/**
 * Desktop notifications: native banners while Junto is in the background,
 * one switch per kind of need, the Dock badge, and a Dock bounce for a
 * blocked seat. `enabled` is the master switch for banners; the badge has
 * its own.
 */
export const NotificationSettings = Schema.Struct({
  enabled: Schema.Boolean,
  blocked: Schema.Boolean,
  needsYou: Schema.Boolean,
  done: Schema.Boolean,
  failed: Schema.Boolean,
  badge: Schema.Boolean,
  bounce: Schema.Boolean,
});
export type NotificationSettings = typeof NotificationSettings.Type;

export const NotificationPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  blocked: Schema.optionalKey(Schema.Boolean),
  needsYou: Schema.optionalKey(Schema.Boolean),
  done: Schema.optionalKey(Schema.Boolean),
  failed: Schema.optionalKey(Schema.Boolean),
  badge: Schema.optionalKey(Schema.Boolean),
  bounce: Schema.optionalKey(Schema.Boolean),
});
export type NotificationPatch = typeof NotificationPatch.Type;

export const defaultNotifications = (): NotificationSettings => ({
  enabled: true,
  blocked: true,
  needsYou: true,
  done: true,
  failed: true,
  badge: true,
  bounce: true,
});

export const notificationSettings = (settings: Settings | undefined): NotificationSettings =>
  settings?.notifications ?? defaultNotifications();

/**
 * Typed lines -> the list to store: trimmed, inner whitespace collapsed,
 * empties and repeats (case-insensitive) dropped, clipped to the bounds.
 */
export const sanitizeQuickReplies = (replies: ReadonlyArray<string>): string[] => {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const raw of replies) {
    const text = raw.replace(/\s+/g, " ").trim().slice(0, QUICK_REPLY_BOUNDS.maxChars).trim();
    const key = text.toLowerCase();
    if (text.length === 0 || seen.has(key)) continue;
    seen.add(key);
    next.push(text);
    if (next.length >= QUICK_REPLY_BOUNDS.maxCount) break;
  }
  return next;
};

export const defaultLive = (): LiveSettings => ({
  backendModel: "gpt-5.4",
  maxCallMinutes: 30,
  maxVoiceCostUsd: 1.5,
});

export const liveSettings = (settings: Settings | undefined): LiveSettings =>
  settings?.live ?? defaultLive();

/** Main ends a call at the first of its duration or voice-estimate limits. */
export const liveCallLimitSeconds = (settings: LiveSettings): number =>
  Math.floor(Math.min(
    settings.maxCallMinutes * 60,
    settings.maxVoiceCostUsd / LIVE_VOICE_USD_PER_MINUTE * 60,
  ));

// --- Providers (usage credentials) ----------------------------------------
//
// Operator-configured credentials for usage sources that need an API key /
// token / cookie. One optional record per configurable provider; every field
// is an optional secret so installed rows written before this section still
// decode (absent ≡ not configured - env vars and conventional credential
// files keep working unchanged).
//
// Secrets never leave main in clear text: every renderer-facing copy of the
// aggregate goes through redactProvidersForIpc first, and a patch field whose
// value equals MASKED_SECRET is treated as "unchanged" so an echoed masked
// row can never overwrite the stored secret.

/** Placeholder shown wherever a configured provider secret would appear. */
export const MASKED_SECRET = "********";

/** Upper bound for one provider credential value (Cookie headers run long). */
const providerSecretString = Schema.String.pipe(
  Schema.check(Schema.isMaxLength(8192)),
);

const OpenAIProviderCredentials = Schema.Struct({
  /** Write-only on IPC; resolveProviders supplies the raw value only in main. */
  apiKey: Schema.optionalKey(providerSecretString),
  /** Derived from active vault bindings; never accepted in a settings patch. */
  apiKeyConfigured: Schema.optionalKey(Schema.Boolean),
});
export type OpenAIProviderCredentials = typeof OpenAIProviderCredentials.Type;

const OpenAIProviderCredentialsPatch = Schema.Struct({
  apiKey: Schema.optionalKey(providerSecretString),
});

const OpenRouterProviderCredentials = Schema.Struct({
  apiKey: Schema.optionalKey(providerSecretString),
  managementApiKey: Schema.optionalKey(providerSecretString),
});
export type OpenRouterProviderCredentials = typeof OpenRouterProviderCredentials.Type;

const SyntheticProviderCredentials = Schema.Struct({
  apiKey: Schema.optionalKey(providerSecretString),
});
export type SyntheticProviderCredentials = typeof SyntheticProviderCredentials.Type;

const KimiProviderCredentials = Schema.Struct({
  authToken: Schema.optionalKey(providerSecretString),
  apiKey: Schema.optionalKey(providerSecretString),
});
export type KimiProviderCredentials = typeof KimiProviderCredentials.Type;

const DevinProviderCredentials = Schema.Struct({
  bearerToken: Schema.optionalKey(providerSecretString),
  /** Not a secret - it selects the billing organization to read. */
  organizationId: Schema.optionalKey(
    Schema.String.pipe(Schema.check(Schema.isMaxLength(256))),
  ),
});
export type DevinProviderCredentials = typeof DevinProviderCredentials.Type;

const OpencodeGoProviderCredentials = Schema.Struct({
  apiKey: Schema.optionalKey(providerSecretString),
});
export type OpencodeGoProviderCredentials = typeof OpencodeGoProviderCredentials.Type;

const CopilotProviderCredentials = Schema.Struct({
  token: Schema.optionalKey(providerSecretString),
});
export type CopilotProviderCredentials = typeof CopilotProviderCredentials.Type;

const OllamaProviderCredentials = Schema.Struct({
  sessionCookie: Schema.optionalKey(providerSecretString),
  apiKey: Schema.optionalKey(providerSecretString),
});
export type OllamaProviderCredentials = typeof OllamaProviderCredentials.Type;

const CursorProviderCredentials = Schema.Struct({
  cookieHeader: Schema.optionalKey(providerSecretString),
});
export type CursorProviderCredentials = typeof CursorProviderCredentials.Type;

/**
 * The configurable usage-provider ids. Claude / Codex / Hermes / Grok /
 * Antigravity are intentionally absent - their credentials come from OAuth or
 * harness sessions, never from this page.
 */
export const PROVIDER_SECTION_KEYS = [
  "openai",
  "openrouter",
  "synthetic",
  "kimi",
  "devin",
  "opencodeGo",
  "copilot",
  "ollama",
  "cursor",
] as const;
export type ProviderSectionKey = (typeof PROVIDER_SECTION_KEYS)[number];

export const ProvidersSettings = Schema.Struct({
  /**
   * Default empty: no provider source may inspect credentials, browser data,
   * session history, process state, or the network until explicitly enabled.
   */
  enabledSources: Schema.optionalKey(Schema.Array(NativeUsageProvider)),
  /**
   * Separate from usage-source `hermes`: local and enrolled-host SSH Hermes
   * profile listing for the snapshot plane. Absent ≡ off.
   */
  hermesHostSnapshots: Schema.optionalKey(Schema.Boolean),
  openai: Schema.optionalKey(OpenAIProviderCredentials),
  openrouter: Schema.optionalKey(OpenRouterProviderCredentials),
  synthetic: Schema.optionalKey(SyntheticProviderCredentials),
  kimi: Schema.optionalKey(KimiProviderCredentials),
  devin: Schema.optionalKey(DevinProviderCredentials),
  opencodeGo: Schema.optionalKey(OpencodeGoProviderCredentials),
  copilot: Schema.optionalKey(CopilotProviderCredentials),
  ollama: Schema.optionalKey(OllamaProviderCredentials),
  cursor: Schema.optionalKey(CursorProviderCredentials),
});
export type ProvidersSettings = typeof ProvidersSettings.Type;

/** Which fields of each provider record are secrets (masked over IPC). */
export const PROVIDER_SECRET_FIELDS: Readonly<
  Record<ProviderSectionKey, ReadonlyArray<string>>
> = {
  openai: ["apiKey"],
  openrouter: ["apiKey", "managementApiKey"],
  synthetic: ["apiKey"],
  kimi: ["authToken", "apiKey"],
  devin: ["bearerToken"],
  opencodeGo: ["apiKey"],
  copilot: ["token"],
  ollama: ["sessionCookie", "apiKey"],
  cursor: ["cookieHeader"],
};

export const defaultProviders = (): ProvidersSettings => ({ enabledSources: [] });

/**
 * Copy of the aggregate safe for renderers: every configured provider secret
 * is replaced by MASKED_SECRET. Non-secret fields (devin.organizationId)
 * pass through. Main-process consumers read raw values from the service.
 */
export const redactProvidersForIpc = (settings: Settings): Settings => {
  const providers = settings.providers;
  if (providers === undefined) return settings;
  const entries: Array<[ProviderSectionKey, Record<string, string | boolean | undefined>]> = [];
  for (const key of PROVIDER_SECTION_KEYS) {
    const section = providers[key];
    if (section === undefined) continue;
    if (key === "openai") {
      entries.push([key, {
        apiKeyConfigured: providers.openai?.apiKeyConfigured === true
          || (typeof providers.openai?.apiKey === "string" && providers.openai.apiKey.length > 0),
      }]);
      continue;
    }
    const secretFields = PROVIDER_SECRET_FIELDS[key];
    const nextSection: Record<string, string | boolean | undefined> = { ...section };
    for (const [field, value] of Object.entries(section)) {
      if (
        secretFields.includes(field) &&
        typeof value === "string" &&
        value !== MASKED_SECRET
      ) {
        nextSection[field] = MASKED_SECRET;
      }
    }
    entries.push([key, nextSection]);
  }
  if (entries.length === 0) return settings;
  return {
    ...settings,
    providers: {
      enabledSources: [...(providers.enabledSources ?? [])],
      ...(providers.hermesHostSnapshots === true
        ? { hermesHostSnapshots: true }
        : {}),
      ...Object.fromEntries(entries),
    } as ProvidersSettings,
  };
};

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
  /**
   * Optional so rows written before the Agents settings surface still decode.
   * Absent ≡ empty byHarness (product defaults for every seat).
   */
  harnesses: Schema.optionalKey(HarnessesSettings),
  /**
   * Optional so rows written before the Terminal settings surface still
   * decode. Absent ≡ defaultTerminal() — today's terminal, unchanged.
   * Read it through terminalSettings() rather than reaching for the key.
   */
  terminal: Schema.optionalKey(TerminalSettings),
  /** Absent on older rows; defaults never establish a call or microphone. */
  live: Schema.optionalKey(LiveSettings),
  /** Absent on rows written before quick replies; absent means the defaults. */
  feed: Schema.optionalKey(FeedSettings),
  /** Absent on rows written before desktop notifications; absent means the defaults. */
  notifications: Schema.optionalKey(NotificationSettings),
  /**
   * Optional so rows written before the Providers settings surface still
   * decode. Absent ≡ nothing operator-configured; consumers fall back to env
   * vars and conventional credential files. Read it through the aggregate -
   * the renderer only ever sees the redacted projection.
   */
  providers: Schema.optionalKey(ProvidersSettings),
  /** DEPRECATED frozen copy (see PortraitsSettings); present only on rows that had it. */
  portraits: Schema.optionalKey(PortraitsSettings),
});
export type Settings = typeof Settings.Type;

// Partial patches: missing top-level keys leave the section unchanged;
// provided section objects deep-merge field-by-field (undefined fields keep
// current). Full section objects are still validated after merge.
export const AppearancePatch = Schema.Struct({
  theme: Schema.optionalKey(SettingsTheme),
  density: Schema.optionalKey(SettingsDensity),
  reduceMotion: Schema.optionalKey(Schema.Boolean),
  agentAppearance: Schema.optionalKey(AgentAppearancePolicy),
});
export type AppearancePatch = typeof AppearancePatch.Type;

export const CanvasPatch = Schema.Struct({
  defaultCanvas: Schema.optionalKey(DefaultCanvasName),
  showMinimap: Schema.optionalKey(Schema.Boolean),
  fitOnOpen: Schema.optionalKey(Schema.Boolean),
});
export type CanvasPatch = typeof CanvasPatch.Type;

export const KernelPatch = Schema.Struct({
  debugVerbose: Schema.optionalKey(Schema.Boolean),
});
export type KernelPatch = typeof KernelPatch.Type;

export const BrowserPatch = Schema.Struct({
  maxVisibleSurfaces: Schema.optionalKey(positiveInt(1, BROWSER_MAX_VISIBLE_SURFACES_HARD)),
  maxWarmSessions: Schema.optionalKey(positiveInt(1, BROWSER_MAX_WARM_SESSIONS_HARD)),
});
export type BrowserPatch = typeof BrowserPatch.Type;

export const AdvancedPatch = Schema.Struct({
  openLastCanvas: Schema.optionalKey(Schema.Boolean),
  logsExplorer: Schema.optionalKey(Schema.Boolean),
  toolDirectories: Schema.optionalKey(
    Schema.Array(ToolDirectory).pipe(
      Schema.check(Schema.isMaxLength(TOOL_DIRECTORIES_MAX)),
    ),
  ),
  seatAwareness: Schema.optionalKey(Schema.Boolean),
  /** Merged key by key: one toggle never clears another. */
  experimental: Schema.optionalKey(ExperimentalOptIns),
  onboardingSeen: Schema.optionalKey(Schema.Boolean),
});
export type AdvancedPatch = typeof AdvancedPatch.Type;

/** Partial terminal update: omitted fields keep their current value. */
export const TerminalPatch = Schema.Struct({
  scrollSensitivity: Schema.optionalKey(
    positiveInt(TERMINAL_BOUNDS.scrollSensitivity.min, TERMINAL_BOUNDS.scrollSensitivity.max),
  ),
  fontSize: Schema.optionalKey(
    positiveInt(TERMINAL_BOUNDS.fontSize.min, TERMINAL_BOUNDS.fontSize.max),
  ),
  fontFamily: Schema.optionalKey(TerminalFontFamily),
  cursorStyle: Schema.optionalKey(TerminalCursorStyle),
  scrollback: Schema.optionalKey(
    positiveInt(TERMINAL_BOUNDS.scrollback.min, TERMINAL_BOUNDS.scrollback.max),
  ),
  cursorBlink: Schema.optionalKey(Schema.Boolean),
  minimumContrastRatio: Schema.optionalKey(
    boundedNumber(
      TERMINAL_BOUNDS.minimumContrastRatio.min,
      TERMINAL_BOUNDS.minimumContrastRatio.max,
    ),
  ),
  lineHeight: Schema.optionalKey(
    boundedNumber(TERMINAL_BOUNDS.lineHeight.min, TERMINAL_BOUNDS.lineHeight.max),
  ),
  letterSpacing: Schema.optionalKey(
    boundedNumber(TERMINAL_BOUNDS.letterSpacing.min, TERMINAL_BOUNDS.letterSpacing.max),
  ),
  screenReaderMode: Schema.optionalKey(Schema.Boolean),
  bell: Schema.optionalKey(TerminalBell),
  copyOnSelect: Schema.optionalKey(Schema.Boolean),
});
export type TerminalPatch = typeof TerminalPatch.Type;

/**
 * Partial provider update: omitted provider sections are untouched; within a
 * section, omitted fields keep their stored value. "" clears a field;
 * MASKED_SECRET is a no-op so an echoed masked row cannot clobber the secret.
 */
export const ProviderSourceAccessPatch = Schema.Struct({
  source: NativeUsageProvider,
  enabled: Schema.Boolean,
});
export type ProviderSourceAccessPatch = typeof ProviderSourceAccessPatch.Type;

export const ProvidersPatch = Schema.Struct({
  /**
   * Whole-list replacement. Use only for intentional bulk operations.
   * Individual toggles must use `sourceAccess` so concurrent disables cannot
   * reconstruct a revoked source from a stale renderer allowlist.
   */
  enabledSources: Schema.optionalKey(Schema.Array(NativeUsageProvider)),
  /** One source, applied atomically against the current durable allowlist. */
  sourceAccess: Schema.optionalKey(ProviderSourceAccessPatch),
  hermesHostSnapshots: Schema.optionalKey(Schema.Boolean),
  openai: Schema.optionalKey(OpenAIProviderCredentialsPatch),
  openrouter: Schema.optionalKey(OpenRouterProviderCredentials),
  synthetic: Schema.optionalKey(SyntheticProviderCredentials),
  kimi: Schema.optionalKey(KimiProviderCredentials),
  devin: Schema.optionalKey(DevinProviderCredentials),
  opencodeGo: Schema.optionalKey(OpencodeGoProviderCredentials),
  copilot: Schema.optionalKey(CopilotProviderCredentials),
  ollama: Schema.optionalKey(OllamaProviderCredentials),
  cursor: Schema.optionalKey(CursorProviderCredentials),
});
export type ProvidersPatch = typeof ProvidersPatch.Type;

export const HarnessInstancePrefsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  model: Schema.optionalKey(harnessPrefString(200)),
  effort: Schema.optionalKey(harnessPrefString(64)),
  permissionMode: Schema.optionalKey(harnessPrefString(64)),
  /** Replaces the list; [] clears it. */
  recentModels: Schema.optionalKey(RecentModels),
});
export type HarnessInstancePrefsPatch = typeof HarnessInstancePrefsPatch.Type;

export const HarnessesPatch = Schema.Struct({
  /**
   * Per-harness shallow merge. Pass `null` values are not supported — omit a
   * field to leave it; set model/effort/permissionMode to "" to clear.
   */
  byHarness: Schema.optionalKey(
    Schema.Record(Schema.String, HarnessInstancePrefsPatch),
  ),
});
export type HarnessesPatch = typeof HarnessesPatch.Type;

export const FleetPatch = Schema.Struct({
  ditherLevel: Schema.optionalKey(FleetDitherLevel),
  remoteManagedInstalls: Schema.optionalKey(Schema.Boolean),
});
export type FleetPatch = typeof FleetPatch.Type;

const StationPatchValue = Schema.Struct({
  role: Schema.optionalKey(StationRoleSetting),
  hostId: Schema.optionalKey(StationHostIdSetting),
  agentHostId: Schema.optionalKey(StationHostIdSetting),
  supervisedPreferred: Schema.optionalKey(Schema.Boolean),
});
export const StationPatch = StationPatchValue;
export type StationPatch = typeof StationPatch.Type;

export const SfxClipPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  volume: Schema.optionalKey(unitInterval),
});
export type SfxClipPatch = typeof SfxClipPatch.Type;

export const SfxClipsPatch = Schema.Struct({
  blocked: Schema.optionalKey(SfxClipPatch),
  permission: Schema.optionalKey(SfxClipPatch),
  orphan: Schema.optionalKey(SfxClipPatch),
  cycle: Schema.optionalKey(SfxClipPatch),
});
export type SfxClipsPatch = typeof SfxClipsPatch.Type;

export const SoundCategoriesPatch = Schema.Struct({
  attention: Schema.optionalKey(SfxClipPatch),
  review: Schema.optionalKey(SfxClipPatch),
  activity: Schema.optionalKey(SfxClipPatch),
  traffic: Schema.optionalKey(SfxClipPatch),
  interface: Schema.optionalKey(SfxClipPatch),
});
export type SoundCategoriesPatch = typeof SoundCategoriesPatch.Type;

export const AudioPatch = Schema.Struct({
  muted: Schema.optionalKey(Schema.Boolean),
  masterVolume: Schema.optionalKey(unitInterval),
  clips: Schema.optionalKey(SfxClipsPatch),
  sounds: Schema.optionalKey(SoundCategoriesPatch),
});
export type AudioPatch = typeof AudioPatch.Type;

export const SettingsPatch = Schema.Struct({
  appearance: Schema.optionalKey(AppearancePatch),
  canvas: Schema.optionalKey(CanvasPatch),
  kernel: Schema.optionalKey(KernelPatch),
  browser: Schema.optionalKey(BrowserPatch),
  advanced: Schema.optionalKey(AdvancedPatch),
  audio: Schema.optionalKey(AudioPatch),
  station: Schema.optionalKey(StationPatch),
  fleet: Schema.optionalKey(FleetPatch),
  harnesses: Schema.optionalKey(HarnessesPatch),
  terminal: Schema.optionalKey(TerminalPatch),
  live: Schema.optionalKey(LivePatch),
  feed: Schema.optionalKey(FeedPatch),
  notifications: Schema.optionalKey(NotificationPatch),
  providers: Schema.optionalKey(ProvidersPatch),
});
export type SettingsPatch = typeof SettingsPatch.Type;

export const SettingsSectionKey = Schema.Literals(["appearance", "canvas",
"kernel",
"browser",
"advanced",
"audio",
"station",
"fleet",
"harnesses",
"terminal",
"live",
"feed",
"notifications",
"providers",]);
export type SettingsSectionKey = typeof SettingsSectionKey.Type;

export const defaultAppearance = (): AppearanceSettings => ({
  theme: "system",
  density: "comfortable",
  reduceMotion: false,
  agentAppearance: "follow",
});

export const defaultCanvas = (): CanvasSettings => ({
  defaultCanvas: "",
  showMinimap: false,
  fitOnOpen: true,
});

export const defaultKernel = (): KernelSettings => ({
  debugVerbose: false,
});

export const defaultBrowser = (): BrowserPrefs => ({
  maxVisibleSurfaces: 2,
  maxWarmSessions: 3,
});

export const defaultAdvanced = (): AdvancedSettings => ({
  openLastCanvas: true,
  logsExplorer: false,
  toolDirectories: [],
  seatAwareness: true,
});

export const defaultHarnesses = (): HarnessesSettings => ({
  byHarness: {},
});

/**
 * Today's terminal, field for field. These are not taste picks — they mirror
 * what the surface already builds with, so the fragment landing changes
 * nothing for an operator who never opens the tab:
 * - fontSize / fontFamily / lineHeight — the house mono cell (MONO_CELL.fontSizePx,
 *   JUNTO_XTERM_FONT_FAMILY, and the hardcoded 1.2 in TerminalSurface)
 * - scrollSensitivity / scrollback — the SCROLL_SENSITIVITY and scrollback
 *   constants the surface passed to xterm
 * - cursorStyle / letterSpacing / screenReaderMode —
 *   xterm's own effective defaults, which the surface never overrode
 * - minimumContrastRatio — default 4.5 (WCAG AA) so TrueColor and ANSI text auto-adjust contrast
 * - cursorBlink — true, because the surface blinks whenever the terminal is
 *   visible; the preference gates that, it does not replace it
 * - bell — "off", because nothing subscribes to xterm's onBell today
 * - copyOnSelect — off, because selection must not replace the system
 *   clipboard without explicit operator opt-in
 *
 * tests/settings.test.ts pins the first bullet against the renderer constants
 * so the two copies cannot drift apart silently.
 */
export const defaultTerminal = (): TerminalSettings => ({
  scrollSensitivity: 3,
  fontSize: 13,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, monospace",
  cursorStyle: "block",
  scrollback: 10_000,
  cursorBlink: true,
  minimumContrastRatio: 4.5,
  lineHeight: 1.2,
  letterSpacing: 0,
  screenReaderMode: false,
  bell: "off",
  copyOnSelect: false,
});

/** Remote package mutation is disabled until the operator explicitly allows it. */
export const defaultFleet = (): FleetSettings => ({
  ditherLevel: "fine",
  remoteManagedInstalls: false,
});

/**
 * Old default-on rows are not affirmative consent. Only a stored `true` that
 * also carries `remoteManagedInstallsConsented` remains on.
 */
export const effectiveRemoteManagedInstalls = (
  fleet: FleetSettings,
): boolean =>
  fleet.remoteManagedInstalls === true
  && fleet.remoteManagedInstallsConsented === true;

export const sanitizeFleetConsent = (fleet: FleetSettings): FleetSettings => {
  if (effectiveRemoteManagedInstalls(fleet)) {
    return {
      ...fleet,
      remoteManagedInstalls: true,
      remoteManagedInstallsConsented: true,
    };
  }
  const { remoteManagedInstallsConsented: _retired, ...rest } = fleet;
  return { ...rest, remoteManagedInstalls: false };
};

export const sanitizeToolDirectories = (
  directories: ReadonlyArray<string>,
): string[] => {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const raw of directories) {
    const dir = raw.trim();
    if (dir.length === 0 || seen.has(dir)) continue;
    seen.add(dir);
    next.push(dir);
    if (next.length >= TOOL_DIRECTORIES_MAX) break;
  }
  return next;
};

export const applySourceAccess = (
  providers: ProvidersSettings,
  change: ProviderSourceAccessPatch,
): ProvidersSettings => {
  const enabled = new Set(providers.enabledSources ?? []);
  if (change.enabled) enabled.add(change.source);
  else enabled.delete(change.source);
  return {
    ...providers,
    enabledSources: NATIVE_USAGE_PROVIDERS.filter((candidate) => enabled.has(candidate)),
  };
};

export const defaultStation = (): StationSettings => ({
  role: "",
  hostId: DEFAULT_STATION_HOST_ID,
  supervisedPreferred: false,
});

const defaultClip = (volume: number): SfxClipPrefs => ({ enabled: true, volume });

export const defaultSfxClips = (): SfxClipsSettings => ({
  blocked: defaultClip(0.55),
  permission: defaultClip(0.55),
  orphan: defaultClip(0.5),
  // Cycle is navigation chrome — keep quiet by default.
  cycle: defaultClip(0.18),
});

/**
 * Family levels on top of each cue's own urgency level: the families that
 * mean "you are needed" stay near full, the ones that say "things are
 * moving" sit back.
 */
export const defaultSoundCategories = (): SoundCategoriesSettings => ({
  attention: defaultClip(1),
  review: defaultClip(0.85),
  activity: defaultClip(0.7),
  traffic: defaultClip(0.6),
  interface: defaultClip(0.7),
});

/** The family's prefs, falling back to the defaults on older rows. */
export const soundCategoryPrefs = (audio: AudioSettings, category: SoundCategory): SfxClipPrefs =>
  audio.sounds?.[category] ?? defaultSoundCategories()[category];

export const defaultAudio = (): AudioSettings => ({
  muted: false,
  // Gentle by default: the loudest cue at this level sits well under a
  // system alert sound.
  masterVolume: 0.6,
  clips: defaultSfxClips(),
  sounds: defaultSoundCategories(),
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
  harnesses: defaultHarnesses(),
  terminal: defaultTerminal(),
  live: defaultLive(),
  feed: defaultFeed(),
  notifications: defaultNotifications(),
  providers: defaultProviders(),
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
    case "harnesses":
      return defaultHarnesses();
    case "terminal":
      return defaultTerminal();
    case "live":
      return defaultLive();
    case "feed":
      return defaultFeed();
    case "notifications":
      return defaultNotifications();
    case "providers":
      return defaultProviders();
  }
};

/** Trimmed, deduplicated, newest first, at most RECENT_MODELS_MAX. */
export const sanitizeRecentModels = (ids: ReadonlyArray<string>): string[] => {
  const kept: string[] = [];
  for (const id of ids) {
    const trimmed = id.trim();
    if (trimmed.length === 0 || kept.includes(trimmed)) continue;
    kept.push(trimmed);
    if (kept.length === RECENT_MODELS_MAX) break;
  }
  return kept;
};

/** The recents list after picking `model`: it moves to the front. */
export const rememberRecentModel = (recent: ReadonlyArray<string> | undefined, model: string): string[] =>
  sanitizeRecentModels([model, ...(recent ?? [])]);

/** Read prefs for one harness; empty when unset. */
export const harnessPrefsFor = (
  settings: Settings | undefined,
  harness: string,
): HarnessInstancePrefs => {
  const row = settings?.harnesses?.byHarness?.[harness];
  return row ?? {};
};

/**
 * Whether the operator has opted a feature-enabled harness out of the palette.
 * Feature flags still own build-level presence; this is user fine-control only.
 */
export const harnessUserEnabled = (
  settings: Settings | undefined,
  harness: string,
): boolean => harnessPrefsFor(settings, harness).enabled !== false;

/**
 * Terminal prefs with the fragment's absence resolved to defaults. Consumers
 * read through this, never `settings.terminal` directly — an installed row
 * written before the fragment existed has no key, and absence means "today's
 * terminal", not "no terminal".
 */
export const terminalSettings = (
  settings: Settings | undefined,
): TerminalSettings => settings?.terminal ?? defaultTerminal();

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
    const merged = mergeSection(next.advanced, patch.advanced);
    const advanced = patch.advanced.experimental === undefined
      ? merged
      : { ...merged, experimental: { ...next.advanced.experimental, ...patch.advanced.experimental } };
    next = {
      ...next,
      advanced: patch.advanced.toolDirectories === undefined
        ? advanced
        : { ...advanced, toolDirectories: sanitizeToolDirectories(patch.advanced.toolDirectories) },
    };
  }
  if (patch.fleet) {
    const fleet = mergeSection(next.fleet, patch.fleet);
    next = {
      ...next,
      fleet: patch.fleet.remoteManagedInstalls === undefined
        ? fleet
        : patch.fleet.remoteManagedInstalls
          ? { ...fleet, remoteManagedInstalls: true, remoteManagedInstallsConsented: true }
          : (() => {
              const { remoteManagedInstallsConsented: _retired, ...rest } = fleet;
              return { ...rest, remoteManagedInstalls: false };
            })(),
    };
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
    if (audioPatch.sounds) {
      let sounds = audio.sounds ?? defaultSoundCategories();
      for (const key of SOUND_CATEGORIES) {
        const familyPatch = audioPatch.sounds[key];
        if (!familyPatch) continue;
        sounds = { ...sounds, [key]: mergeSection(sounds[key], familyPatch) };
      }
      audio = { ...audio, sounds };
    }
    next = { ...next, audio };
  }
  if (patch.terminal) {
    next = {
      ...next,
      terminal: mergeSection(next.terminal ?? defaultTerminal(), patch.terminal),
    };
  }
  if (patch.live) {
    next = {
      ...next,
      live: mergeSection(liveSettings(next), patch.live),
    };
  }
  if (patch.notifications) {
    next = {
      ...next,
      notifications: mergeSection(notificationSettings(next), patch.notifications),
    };
  }
  if (patch.feed?.quickReplies !== undefined) {
    next = { ...next, feed: { quickReplies: sanitizeQuickReplies(patch.feed.quickReplies) } };
  }
  if (patch.harnesses?.byHarness) {
    const current = next.harnesses ?? defaultHarnesses();
    const byHarness: Record<string, HarnessInstancePrefs> = {
      ...current.byHarness,
    };
    for (const [id, prefsPatch] of Object.entries(patch.harnesses.byHarness)) {
      if (!prefsPatch || id.trim().length === 0) continue;
      const prior = byHarness[id] ?? {};
      // Build a fresh prefs object — Schema.Type fields are readonly.
      let enabled = prior.enabled;
      let model = prior.model;
      let effort = prior.effort;
      let permissionMode = prior.permissionMode;
      let recentModels = prior.recentModels;
      if (prefsPatch.enabled !== undefined) enabled = prefsPatch.enabled;
      if (prefsPatch.recentModels !== undefined) {
        const kept = sanitizeRecentModels(prefsPatch.recentModels);
        recentModels = kept.length === 0 ? undefined : kept;
      }
      if (prefsPatch.model !== undefined) {
        const trimmed = prefsPatch.model.trim();
        model = trimmed.length === 0 ? undefined : trimmed;
      }
      if (prefsPatch.effort !== undefined) {
        const trimmed = prefsPatch.effort.trim();
        effort = trimmed.length === 0 ? undefined : trimmed;
      }
      if (prefsPatch.permissionMode !== undefined) {
        const trimmed = prefsPatch.permissionMode.trim();
        permissionMode = trimmed.length === 0 ? undefined : trimmed;
      }
      byHarness[id] = {
        ...(enabled !== undefined ? { enabled } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(effort !== undefined ? { effort } : {}),
        ...(permissionMode !== undefined ? { permissionMode } : {}),
        ...(recentModels !== undefined ? { recentModels } : {}),
      };
    }
    next = { ...next, harnesses: { byHarness } };
  }
  if (patch.providers) {
    const current = next.providers ?? defaultProviders();
    let providers: ProvidersSettings = current;
    if (patch.providers.enabledSources !== undefined) {
      providers = {
        ...providers,
        enabledSources: [...new Set(patch.providers.enabledSources)],
      };
    }
    if (patch.providers.sourceAccess !== undefined) {
      providers = applySourceAccess(providers, patch.providers.sourceAccess);
    }
    if (patch.providers.hermesHostSnapshots !== undefined) {
      providers = patch.providers.hermesHostSnapshots
        ? { ...providers, hermesHostSnapshots: true }
        : (() => {
            const { hermesHostSnapshots: _retired, ...rest } = providers;
            return rest;
          })();
    }
    for (const key of PROVIDER_SECTION_KEYS) {
      const sectionPatch: Record<string, string | undefined> | undefined =
        patch.providers[key];
      if (!sectionPatch) continue;
      const prior: Record<string, string | boolean | undefined> = {
        ...(providers[key] ?? {}),
      };
      for (const [field, value] of Object.entries(sectionPatch)) {
        if (value === undefined) continue;
        const trimmed = value.trim();
        // An echoed masked row means "unchanged" - never overwrite the secret.
        if (trimmed === MASKED_SECRET) continue;
        if (trimmed.length === 0) delete prior[field];
        else prior[field] = trimmed;
      }
      providers = {
        ...providers,
        [key]: Object.fromEntries(
          Object.entries(prior).filter(([, v]) => v !== undefined),
        ),
      };
    }
    next = { ...next, providers };
  }
  return next;
};

export const SettingsErrorCode = Schema.Literals(["validation", "io", "corrupt", "unsupported"]);
export type SettingsErrorCode = typeof SettingsErrorCode.Type;

export class SettingsError extends Schema.TaggedError<SettingsError>()("SettingsError", {
  message: Schema.String,
  code: SettingsErrorCode,
}) {}

// Wire result for IPC. Same ok/code/message shape as browser ops, with a
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
