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
declare const __VELLUM_COMMAND_HERDR_ENABLED__: boolean | undefined;
declare const __VELLUM_COMMAND_DEV_TOOLS_ENABLED__: boolean | undefined;
declare const __VELLUM_COMMAND_HARNESS_KIMI_ENABLED__: boolean | undefined;
declare const __VELLUM_COMMAND_HARNESS_MUSE_ENABLED__: boolean | undefined;
declare const __VELLUM_COMMAND_HARNESS_PRIME_AGENT_ENABLED__: boolean | undefined;

const envEnabled = (key: string): boolean => {
  try {
    return process.env[key] === "1";
  } catch {
    return false;
  }
};

/**
 * Product surface for Herdr (legacy pane attach, wizard, host capability,
 * serve-catalog IPC, idle-herdr queue, region herdr defaults, …).
 *
 * When false: no authoring UI, no host-cap chips/checkboxes, no herdr IPC
 * registration, no herdr plane start/warm. Durable schema still decodes
 * historical `herdr` rows; they render as inert furniture.
 */
export const HERDR_ENABLED: boolean =
  typeof __VELLUM_COMMAND_HERDR_ENABLED__ === "boolean"
    ? __VELLUM_COMMAND_HERDR_ENABLED__
    : envEnabled("VELLUM_COMMAND_HERDR");

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

/** Experimental Prime Agent managed seat — ship/prod off. */
export const HARNESS_PRIME_AGENT_ENABLED: boolean =
  typeof __VELLUM_COMMAND_HARNESS_PRIME_AGENT_ENABLED__ === "boolean"
    ? __VELLUM_COMMAND_HARNESS_PRIME_AGENT_ENABLED__
    : envEnabled("VELLUM_COMMAND_HARNESS_PRIME_AGENT");

export const BUILD_FEATURES = {
  cron: CRON_ENABLED,
  relay: RELAY_ENABLED,
  browser: BROWSER_ENABLED,
  fleetUi: FLEET_UI_ENABLED,
  usage: USAGE_ENABLED,
  helpMap: HELP_MAP_ENABLED,
  audio: AUDIO_ENABLED,
  hermesIntegration: HERMES_INTEGRATION_ENABLED,
  herdr: HERDR_ENABLED,
  devTools: DEV_TOOLS_ENABLED,
  harnessKimi: HARNESS_KIMI_ENABLED,
  harnessMuse: HARNESS_MUSE_ENABLED,
  harnessPrimeAgent: HARNESS_PRIME_AGENT_ENABLED,
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
  if (kind === "herdr") return HERDR_ENABLED;
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
  if (harness === "prime-agent") return HARNESS_PRIME_AGENT_ENABLED;
  return true;
};

/** Strip product-hidden capabilities from a host capability list for UI. */
export const productHostCapabilities = <T extends string>(
  capabilities: ReadonlyArray<T>,
): ReadonlyArray<T> => capabilities.filter((capability) => {
  if (!HERDR_ENABLED && capability === "herdr") return false;
  if (!BROWSER_ENABLED && capability === "browser") return false;
  if (!HERMES_INTEGRATION_ENABLED && capability === "hermes") return false;
  return true;
});
