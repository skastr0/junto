/**
 * Compile-time product feature gates.
 *
 * Values are injected by electron-vite / bun build `define`. When the define
 * is absent (tsc, vitest without define), the env fallback applies so unit
 * tests and unbundled scripts stay deterministic.
 *
 * Product surfaces default OFF. Each may be enabled for a build with its
 * dedicated `VELLUM_*` environment variable. Official builders always inject
 * every define; the environment fallback exists only for source-run tooling.
 */

declare const __VELLUM_CRON_ENABLED__: boolean | undefined;
declare const __VELLUM_RELAY_ENABLED__: boolean | undefined;
declare const __VELLUM_BROWSER_ENABLED__: boolean | undefined;
declare const __VELLUM_FLEET_UI_ENABLED__: boolean | undefined;
declare const __VELLUM_USAGE_ENABLED__: boolean | undefined;
declare const __VELLUM_HELP_MAP_ENABLED__: boolean | undefined;
declare const __VELLUM_AUDIO_ENABLED__: boolean | undefined;
declare const __VELLUM_HERMES_INTEGRATION_ENABLED__: boolean | undefined;
declare const __VELLUM_HERDR_ENABLED__: boolean | undefined;

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
  typeof __VELLUM_HERDR_ENABLED__ === "boolean"
    ? __VELLUM_HERDR_ENABLED__
    : envEnabled("VELLUM_HERDR");

export const CRON_ENABLED: boolean =
  typeof __VELLUM_CRON_ENABLED__ === "boolean"
    ? __VELLUM_CRON_ENABLED__
    : envEnabled("VELLUM_CRON");

export const RELAY_ENABLED: boolean =
  typeof __VELLUM_RELAY_ENABLED__ === "boolean"
    ? __VELLUM_RELAY_ENABLED__
    : envEnabled("VELLUM_RELAY");

export const BROWSER_ENABLED: boolean =
  typeof __VELLUM_BROWSER_ENABLED__ === "boolean"
    ? __VELLUM_BROWSER_ENABLED__
    : envEnabled("VELLUM_BROWSER");

export const FLEET_UI_ENABLED: boolean =
  typeof __VELLUM_FLEET_UI_ENABLED__ === "boolean"
    ? __VELLUM_FLEET_UI_ENABLED__
    : envEnabled("VELLUM_FLEET_UI");

export const USAGE_ENABLED: boolean =
  typeof __VELLUM_USAGE_ENABLED__ === "boolean"
    ? __VELLUM_USAGE_ENABLED__
    : envEnabled("VELLUM_USAGE");

export const HELP_MAP_ENABLED: boolean =
  typeof __VELLUM_HELP_MAP_ENABLED__ === "boolean"
    ? __VELLUM_HELP_MAP_ENABLED__
    : envEnabled("VELLUM_HELP_MAP");

export const AUDIO_ENABLED: boolean =
  typeof __VELLUM_AUDIO_ENABLED__ === "boolean"
    ? __VELLUM_AUDIO_ENABLED__
    : envEnabled("VELLUM_AUDIO");

export const HERMES_INTEGRATION_ENABLED: boolean =
  typeof __VELLUM_HERMES_INTEGRATION_ENABLED__ === "boolean"
    ? __VELLUM_HERMES_INTEGRATION_ENABLED__
    : envEnabled("VELLUM_HERMES");

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

/** Durable HarnessId still admits Hermes rows; new product actions do not. */
export const managedHarnessEnabled = (harness: string): boolean =>
  harness !== "hermes" || HERMES_INTEGRATION_ENABLED;

/** Strip product-hidden capabilities from a host capability list for UI. */
export const productHostCapabilities = <T extends string>(
  capabilities: ReadonlyArray<T>,
): ReadonlyArray<T> => capabilities.filter((capability) => {
  if (!HERDR_ENABLED && capability === "herdr") return false;
  if (!BROWSER_ENABLED && capability === "browser") return false;
  if (!HERMES_INTEGRATION_ENABLED && capability === "hermes") return false;
  return true;
});
