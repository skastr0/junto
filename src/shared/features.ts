/**
 * Compile-time product feature gates.
 *
 * Values are injected by electron-vite / bun build `define`. When the define
 * is absent (tsc, vitest without define), the env fallback applies so unit
 * tests and unbundled scripts stay deterministic.
 *
 * Product surfaces default OFF. Each may be enabled for a build with its
 * dedicated `VELLUM_COMMAND_*` environment variable. Official builders always inject
 * every define; the environment fallback exists only for source-run tooling.
 */

declare const __VELLUM_COMMAND_CRON_ENABLED__: boolean | undefined;
declare const __VELLUM_COMMAND_RELAY_ENABLED__: boolean | undefined;
declare const __VELLUM_COMMAND_BROWSER_ENABLED__: boolean | undefined;
declare const __VELLUM_COMMAND_FLEET_UI_ENABLED__: boolean | undefined;
declare const __VELLUM_COMMAND_USAGE_ENABLED__: boolean | undefined;
declare const __VELLUM_COMMAND_HELP_MAP_ENABLED__: boolean | undefined;
declare const __VELLUM_COMMAND_AUDIO_ENABLED__: boolean | undefined;
declare const __VELLUM_COMMAND_HERMES_INTEGRATION_ENABLED__: boolean | undefined;
declare const __VELLUM_COMMAND_DEV_TOOLS_ENABLED__: boolean | undefined;
declare const __VELLUM_COMMAND_HARNESS_KIMI_ENABLED__: boolean | undefined;
declare const __VELLUM_COMMAND_HARNESS_MUSE_ENABLED__: boolean | undefined;
declare const __VELLUM_COMMAND_HARNESS_FX_ENABLED__: boolean | undefined;
declare const __VELLUM_COMMAND_HARNESS_AMP_ENABLED__: boolean | undefined;
declare const __VELLUM_COMMAND_HARNESS_OMP_ENABLED__: boolean | undefined;
declare const __VELLUM_COMMAND_HARNESS_PRIME_AGENT_ENABLED__: boolean | undefined;
declare const __VELLUM_COMMAND_HARNESS_SETTINGS_ENABLED__: boolean | undefined;

const envEnabled = (key: string): boolean => {
  try {
    return process.env[key] === "1";
  } catch {
    return false;
  }
};

export const CRON_ENABLED: boolean =
  typeof __VELLUM_COMMAND_CRON_ENABLED__ === "boolean"
    ? __VELLUM_COMMAND_CRON_ENABLED__
    : envEnabled("VELLUM_COMMAND_CRON");

export const RELAY_ENABLED: boolean =
  typeof __VELLUM_COMMAND_RELAY_ENABLED__ === "boolean"
    ? __VELLUM_COMMAND_RELAY_ENABLED__
    : envEnabled("VELLUM_COMMAND_RELAY");

export const BROWSER_ENABLED: boolean =
  typeof __VELLUM_COMMAND_BROWSER_ENABLED__ === "boolean"
    ? __VELLUM_COMMAND_BROWSER_ENABLED__
    : envEnabled("VELLUM_COMMAND_BROWSER");

export const FLEET_UI_ENABLED: boolean =
  typeof __VELLUM_COMMAND_FLEET_UI_ENABLED__ === "boolean"
    ? __VELLUM_COMMAND_FLEET_UI_ENABLED__
    : envEnabled("VELLUM_COMMAND_FLEET_UI");

export const USAGE_ENABLED: boolean =
  typeof __VELLUM_COMMAND_USAGE_ENABLED__ === "boolean"
    ? __VELLUM_COMMAND_USAGE_ENABLED__
    : envEnabled("VELLUM_COMMAND_USAGE");

export const HELP_MAP_ENABLED: boolean =
  typeof __VELLUM_COMMAND_HELP_MAP_ENABLED__ === "boolean"
    ? __VELLUM_COMMAND_HELP_MAP_ENABLED__
    : envEnabled("VELLUM_COMMAND_HELP_MAP");

export const AUDIO_ENABLED: boolean =
  typeof __VELLUM_COMMAND_AUDIO_ENABLED__ === "boolean"
    ? __VELLUM_COMMAND_AUDIO_ENABLED__
    : envEnabled("VELLUM_COMMAND_AUDIO");

export const HERMES_INTEGRATION_ENABLED: boolean =
  typeof __VELLUM_COMMAND_HERMES_INTEGRATION_ENABLED__ === "boolean"
    ? __VELLUM_COMMAND_HERMES_INTEGRATION_ENABLED__
    : envEnabled("VELLUM_COMMAND_HERMES");

/**
 * Developer diagnostics in Advanced settings + logs explorer chrome.
 * Compile-time only: ship profile injects false; prod never shows install
 * feed URLs, build/updater provenance, data paths, or logs explorer.
 */
export const DEV_TOOLS_ENABLED: boolean =
  typeof __VELLUM_COMMAND_DEV_TOOLS_ENABLED__ === "boolean"
    ? __VELLUM_COMMAND_DEV_TOOLS_ENABLED__
    : envEnabled("VELLUM_COMMAND_DEV_TOOLS");

/** Experimental Kimi Code managed seat — ship/prod off. */
export const HARNESS_KIMI_ENABLED: boolean =
  typeof __VELLUM_COMMAND_HARNESS_KIMI_ENABLED__ === "boolean"
    ? __VELLUM_COMMAND_HARNESS_KIMI_ENABLED__
    : envEnabled("VELLUM_COMMAND_HARNESS_KIMI");

/** Experimental Muse Code managed seat — ship/prod off. */
export const HARNESS_MUSE_ENABLED: boolean =
  typeof __VELLUM_COMMAND_HARNESS_MUSE_ENABLED__ === "boolean"
    ? __VELLUM_COMMAND_HARNESS_MUSE_ENABLED__
    : envEnabled("VELLUM_COMMAND_HARNESS_MUSE");

/**
 * fx managed seat — ON, with the gate kept for a fast way back off.
 *
 * fx is the lightweight end of the harness range: a small native binary rather
 * than a runtime and a dependency tree, which is what makes a lot of seats at
 * once affordable. It is on so it can actually be run at that scale.
 *
 * Residual, unchanged by the flag: fx's approval dialog has never been captured,
 * so its attention rule is written from literals in the shipped binary rather
 * than from a rendered frame. A seat sitting on a permission prompt may read
 * idle until that capture exists.
 */
export const HARNESS_FX_ENABLED: boolean =
  typeof __VELLUM_COMMAND_HARNESS_FX_ENABLED__ === "boolean"
    ? __VELLUM_COMMAND_HARNESS_FX_ENABLED__
    : envEnabled("VELLUM_COMMAND_HARNESS_FX");

/**
 * Amp managed seat — ship/prod off until its seat rules are proven at ship
 * grade. All-on and the explicit env override keep it exercised in dev.
 */
export const HARNESS_AMP_ENABLED: boolean =
  typeof __VELLUM_COMMAND_HARNESS_AMP_ENABLED__ === "boolean"
    ? __VELLUM_COMMAND_HARNESS_AMP_ENABLED__
    : envEnabled("VELLUM_COMMAND_HARNESS_AMP");

/**
 * Oh My Pi managed seat — ship/prod off until an approval dialog is captured.
 *
 * Everything else about the seat is proven against 18.0.9 (Tier-A doctrine on
 * argv, title state machine, capture and same-session resume), but its
 * attention rule matches literals taken from the shipped binary rather than a
 * rendered frame, so a seat sitting on a permission prompt may read idle.
 */
export const HARNESS_OMP_ENABLED: boolean =
  typeof __VELLUM_COMMAND_HARNESS_OMP_ENABLED__ === "boolean"
    ? __VELLUM_COMMAND_HARNESS_OMP_ENABLED__
    : envEnabled("VELLUM_COMMAND_HARNESS_OMP");

/** Stock Prime Agent 0.7.1 managed seat; separately installed CLI required. */
export const HARNESS_PRIME_AGENT_ENABLED: boolean =
  typeof __VELLUM_COMMAND_HARNESS_PRIME_AGENT_ENABLED__ === "boolean"
    ? __VELLUM_COMMAND_HARNESS_PRIME_AGENT_ENABLED__
    : envEnabled("VELLUM_COMMAND_HARNESS_PRIME_AGENT");

/**
 * Settings → Agents surface: scan harness CLIs/options and persist per-harness
 * spawn defaults. Ship/prod off.
 */
export const HARNESS_SETTINGS_ENABLED: boolean =
  typeof __VELLUM_COMMAND_HARNESS_SETTINGS_ENABLED__ === "boolean"
    ? __VELLUM_COMMAND_HARNESS_SETTINGS_ENABLED__
    : envEnabled("VELLUM_COMMAND_HARNESS_SETTINGS");

export const BUILD_FEATURES = {
  cron: CRON_ENABLED,
  relay: RELAY_ENABLED,
  browser: BROWSER_ENABLED,
  fleetUi: FLEET_UI_ENABLED,
  usage: USAGE_ENABLED,
  helpMap: HELP_MAP_ENABLED,
  audio: AUDIO_ENABLED,
  hermesIntegration: HERMES_INTEGRATION_ENABLED,
  devTools: DEV_TOOLS_ENABLED,
  harnessKimi: HARNESS_KIMI_ENABLED,
  harnessMuse: HARNESS_MUSE_ENABLED,
  harnessFx: HARNESS_FX_ENABLED,
  harnessAmp: HARNESS_AMP_ENABLED,
  harnessOmp: HARNESS_OMP_ENABLED,
  harnessPrimeAgent: HARNESS_PRIME_AGENT_ENABLED,
  harnessSettings: HARNESS_SETTINGS_ENABLED,
} as const;

/** Whether an authored scheduler kind has a live product surface in this build. */
export const schedulerFeatureEnabled = (
  kind: "cron" | "relay" | "gauge",
): boolean => kind === "cron" ? CRON_ENABLED : RELAY_ENABLED;

/** Historical hidden kinds remain decodable, but cannot regain authoring controls. */
export const productNodeKindEnabled = (kind: string | undefined): boolean => {
  if (kind === "cron" || kind === "timer") return CRON_ENABLED;
  if (kind === "relay" || kind === "watcher" || kind === "gauge") return RELAY_ENABLED;
  if (kind === "page") return BROWSER_ENABLED;
  return true;
};

/**
 * Whether a harness may be authored / spawned in this build.
 * Durable HarnessId still decodes historical canvas rows; this only gates
 * palette, seat factory, and terminal create IPC.
 */
export const managedHarnessEnabled = (harness: string): boolean => {
  if (harness === "hermes") return HERMES_INTEGRATION_ENABLED;
  if (harness === "kimi") return HARNESS_KIMI_ENABLED;
  if (harness === "muse") return HARNESS_MUSE_ENABLED;
  if (harness === "fx") return HARNESS_FX_ENABLED;
  if (harness === "amp") return HARNESS_AMP_ENABLED;
  if (harness === "omp") return HARNESS_OMP_ENABLED;
  if (harness === "prime-agent") return HARNESS_PRIME_AGENT_ENABLED;
  return true;
};

/** Strip product-hidden capabilities from a host capability list for UI. */
export const productHostCapabilities = <T extends string>(
  capabilities: ReadonlyArray<T>,
): ReadonlyArray<T> => capabilities.filter((capability) => {
  if (!BROWSER_ENABLED && capability === "browser") return false;
  if (!HERMES_INTEGRATION_ENABLED && capability === "hermes") return false;
  return true;
});
