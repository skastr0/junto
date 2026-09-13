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
  liveOverseer: {
    env: "VELLUM_COMMAND_LIVE_OVERSEER",
    define: "__VELLUM_COMMAND_LIVE_OVERSEER_ENABLED__",
  },
  audio: {
    env: "VELLUM_COMMAND_AUDIO",
    define: "__VELLUM_COMMAND_AUDIO_ENABLED__",
  },
  hermesIntegration: {
    env: "VELLUM_COMMAND_HERMES",
    define: "__VELLUM_COMMAND_HERMES_INTEGRATION_ENABLED__",
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
   * Managed harness authoring gates. Ship now enables all of them — each gate
   * remains the way back off for a single harness without a rebuild of the
   * whole surface. Durable HarnessId decode still admits historical canvas
   * rows in every profile.
   */
  harnessKimi: {
    env: "VELLUM_COMMAND_HARNESS_KIMI",
    define: "__VELLUM_COMMAND_HARNESS_KIMI_ENABLED__",
  },
  harnessMuse: {
    env: "VELLUM_COMMAND_HARNESS_MUSE",
    define: "__VELLUM_COMMAND_HARNESS_MUSE_ENABLED__",
  },
  harnessFx: {
    env: "VELLUM_COMMAND_HARNESS_FX",
    define: "__VELLUM_COMMAND_HARNESS_FX_ENABLED__",
  },
  harnessAmp: {
    env: "VELLUM_COMMAND_HARNESS_AMP",
    define: "__VELLUM_COMMAND_HARNESS_AMP_ENABLED__",
  },
  harnessOmp: {
    env: "VELLUM_COMMAND_HARNESS_OMP",
    define: "__VELLUM_COMMAND_HARNESS_OMP_ENABLED__",
  },
  /**
   * Shipped stock Prime Agent managed seat. The ship baseline enables authoring;
   * an explicit build override may still disable it. HarnessId decode remains
   * independent of the authoring gate in every profile.
   */
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

/** Public release baseline. Host-local Browser ships; Fleet UI and remote/host management stay off. */
export const SHIP_FEATURES: FeatureSet = {
  cron: false,
  relay: false,
  browser: true,
  fleetUi: false,
  usage: false,
  helpMap: false,
  audio: false,
  liveOverseer: false,
  hermesIntegration: false,
  devTools: false,
  harnessKimi: true,
  harnessMuse: true,
  harnessFx: true,
  harnessAmp: true,
  harnessOmp: true,
  harnessPrimeAgent: true,
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
  liveOverseer: true,
  hermesIntegration: true,
  devTools: true,
  harnessKimi: true,
  harnessMuse: true,
  harnessFx: true,
  harnessAmp: true,
  harnessOmp: true,
  harnessPrimeAgent: true,
  harnessSettings: true,
};
