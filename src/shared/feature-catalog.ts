export const FEATURE_CATALOG = {
  cron: {
    env: "VELLUM_COMMAND_CRON",
    define: "__VELLUM_COMMAND_CRON_ENABLED__",
  },
  relay: {
    env: "VELLUM_COMMAND_RELAY",
    define: "__VELLUM_COMMAND_RELAY_ENABLED__",
  },
  browser: {
    env: "VELLUM_COMMAND_BROWSER",
    define: "__VELLUM_COMMAND_BROWSER_ENABLED__",
  },
  fleetUi: {
    env: "VELLUM_COMMAND_FLEET_UI",
    define: "__VELLUM_COMMAND_FLEET_UI_ENABLED__",
  },
  usage: {
    env: "VELLUM_COMMAND_USAGE",
    define: "__VELLUM_COMMAND_USAGE_ENABLED__",
  },
  helpMap: {
    env: "VELLUM_COMMAND_HELP_MAP",
    define: "__VELLUM_COMMAND_HELP_MAP_ENABLED__",
  },
  audio: {
    env: "VELLUM_COMMAND_AUDIO",
    define: "__VELLUM_COMMAND_AUDIO_ENABLED__",
  },
  hermesIntegration: {
    env: "VELLUM_COMMAND_HERMES",
    define: "__VELLUM_COMMAND_HERMES_INTEGRATION_ENABLED__",
  },
  herdr: {
    env: "VELLUM_COMMAND_HERDR",
    define: "__VELLUM_COMMAND_HERDR_ENABLED__",
  },
  /**
   * Advanced diagnostics for developers: install provenance (build/updater,
   * update feed URL, host id, data path), logs explorer chrome. Never on
   * ship/prod — only all-on and explicit dev overrides.
   */
  devTools: {
    env: "VELLUM_COMMAND_DEV_TOOLS",
    define: "__VELLUM_COMMAND_DEV_TOOLS_ENABLED__",
  },
  /**
   * Experimental managed harnesses — seat rules / process-bind still unfinished.
   * Ship/prod keeps them off; all-on and explicit env overrides re-enable.
   * Durable HarnessId decode still admits historical canvas rows.
   */
  harnessKimi: {
    env: "VELLUM_COMMAND_HARNESS_KIMI",
    define: "__VELLUM_COMMAND_HARNESS_KIMI_ENABLED__",
  },
  harnessMuse: {
    env: "VELLUM_COMMAND_HARNESS_MUSE",
    define: "__VELLUM_COMMAND_HARNESS_MUSE_ENABLED__",
  },
  harnessPrimeAgent: {
    env: "VELLUM_COMMAND_HARNESS_PRIME_AGENT",
    define: "__VELLUM_COMMAND_HARNESS_PRIME_AGENT_ENABLED__",
  },
  /**
   * Settings → Agents: scan install/options and set per-harness spawn defaults
   * (model, effort, permission). Ship/prod off until the surface is ready.
   */
  harnessSettings: {
    env: "VELLUM_COMMAND_HARNESS_SETTINGS",
    define: "__VELLUM_COMMAND_HARNESS_SETTINGS_ENABLED__",
  },
} as const;

export type FeatureKey = keyof typeof FEATURE_CATALOG;

export type FeatureSet = Readonly<Record<FeatureKey, boolean>>;

/** Public release baseline. Fleet and its host-local Browser plane ship together. */
export const SHIP_FEATURES: FeatureSet = {
  cron: false,
  relay: false,
  browser: true,
  fleetUi: true,
  usage: false,
  helpMap: false,
  audio: false,
  hermesIntegration: false,
  herdr: false,
  devTools: false,
  harnessKimi: false,
  harnessMuse: false,
  harnessPrimeAgent: false,
  harnessSettings: false,
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
  devTools: true,
  harnessKimi: true,
  harnessMuse: true,
  harnessPrimeAgent: true,
  harnessSettings: true,
};
