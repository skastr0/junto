export const FEATURE_CATALOG = {
  cron: {
    env: "VELLUM_CRON",
    define: "__VELLUM_CRON_ENABLED__",
  },
  relay: {
    env: "VELLUM_RELAY",
    define: "__VELLUM_RELAY_ENABLED__",
  },
  browser: {
    env: "VELLUM_BROWSER",
    define: "__VELLUM_BROWSER_ENABLED__",
  },
  fleetUi: {
    env: "VELLUM_FLEET_UI",
    define: "__VELLUM_FLEET_UI_ENABLED__",
  },
  usage: {
    env: "VELLUM_USAGE",
    define: "__VELLUM_USAGE_ENABLED__",
  },
  helpMap: {
    env: "VELLUM_HELP_MAP",
    define: "__VELLUM_HELP_MAP_ENABLED__",
  },
  audio: {
    env: "VELLUM_AUDIO",
    define: "__VELLUM_AUDIO_ENABLED__",
  },
  hermesIntegration: {
    env: "VELLUM_HERMES",
    define: "__VELLUM_HERMES_INTEGRATION_ENABLED__",
  },
  herdr: {
    env: "VELLUM_HERDR",
    define: "__VELLUM_HERDR_ENABLED__",
  },
} as const;

export type FeatureKey = keyof typeof FEATURE_CATALOG;

export type FeatureSet = Readonly<Record<FeatureKey, boolean>>;

/** Public release baseline. Every non-core product surface is opt-in. */
export const SHIP_FEATURES: FeatureSet = {
  cron: false,
  relay: false,
  browser: false,
  fleetUi: false,
  usage: false,
  helpMap: false,
  audio: false,
  hermesIntegration: false,
  herdr: false,
};

export const ALL_FEATURES: FeatureSet = {
  cron: true,
  relay: true,
  browser: true,
  fleetUi: true,
  usage: true,
  helpMap: true,
  audio: true,
  hermesIntegration: true,
  herdr: true,
};
