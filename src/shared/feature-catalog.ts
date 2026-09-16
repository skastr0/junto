export const FEATURE_CATALOG = {
  cron: {
    env: "JUNTO_CRON",
    define: "__JUNTO_CRON_ENABLED__",
  },
  relay: {
    env: "JUNTO_RELAY",
    define: "__JUNTO_RELAY_ENABLED__",
  },
  browser: {
    env: "JUNTO_BROWSER",
    define: "__JUNTO_BROWSER_ENABLED__",
  },
  board: {
    env: "JUNTO_BOARD",
    define: "__JUNTO_BOARD_ENABLED__",
  },
  pad: {
    env: "JUNTO_PAD",
    define: "__JUNTO_PAD_ENABLED__",
  },
  sheet: {
    env: "JUNTO_SHEET",
    define: "__JUNTO_SHEET_ENABLED__",
  },
  requests: {
    env: "JUNTO_REQUESTS",
    define: "__JUNTO_REQUESTS_ENABLED__",
  },
  artifacts: {
    env: "JUNTO_ARTIFACTS",
    define: "__JUNTO_ARTIFACTS_ENABLED__",
  },
  /** Tasks node, task CLI, and the task-scoped content access it carries. */
  tasks: {
    env: "JUNTO_TASKS",
    define: "__JUNTO_TASKS_ENABLED__",
  },
  fleetUi: {
    env: "JUNTO_FLEET_UI",
    define: "__JUNTO_FLEET_UI_ENABLED__",
  },
  usage: {
    env: "JUNTO_USAGE",
    define: "__JUNTO_USAGE_ENABLED__",
  },
  helpMap: {
    env: "JUNTO_HELP_MAP",
    define: "__JUNTO_HELP_MAP_ENABLED__",
  },
  liveOverseer: {
    env: "JUNTO_LIVE_OVERSEER",
    define: "__JUNTO_LIVE_OVERSEER_ENABLED__",
  },
  audio: {
    env: "JUNTO_AUDIO",
    define: "__JUNTO_AUDIO_ENABLED__",
  },
  /**
   * Deep Hermes integration: the ACP chat plane, fleet host identity
   * (`hermesId` agent hosts), portfolio snapshots, and the Providers settings
   * card. The managed Hermes TERMINAL seat is `harnessHermes` below and does
   * not depend on this gate.
   */
  hermesIntegration: {
    env: "JUNTO_HERMES",
    define: "__JUNTO_HERMES_INTEGRATION_ENABLED__",
  },
  /**
   * Advanced diagnostics for developers: install provenance (build/updater,
   * update feed URL, host id, data path), logs explorer chrome. Never on
   * ship/prod — only all-on and explicit dev overrides.
   */
  devTools: {
    env: "JUNTO_DEV_TOOLS",
    define: "__JUNTO_DEV_TOOLS_ENABLED__",
  },
  /**
   * Managed harness authoring gates. Ship now enables all of them — each gate
   * remains the way back off for a single harness without a rebuild of the
   * whole surface. Durable HarnessId decode still admits historical canvas
   * rows in every profile.
   */
  /**
   * Hermes as a managed TUI seat (`hermes chat --tui` on a real PTY). Only the
   * terminal template, palette entry, seat factory, and `hermes profile list`
   * picker step ride this gate; the ACP plane stays under `hermesIntegration`.
   */
  harnessHermes: {
    env: "JUNTO_HARNESS_HERMES",
    define: "__JUNTO_HARNESS_HERMES_ENABLED__",
  },
  harnessKimi: {
    env: "JUNTO_HARNESS_KIMI",
    define: "__JUNTO_HARNESS_KIMI_ENABLED__",
  },
  harnessMuse: {
    env: "JUNTO_HARNESS_MUSE",
    define: "__JUNTO_HARNESS_MUSE_ENABLED__",
  },
  harnessFx: {
    env: "JUNTO_HARNESS_FX",
    define: "__JUNTO_HARNESS_FX_ENABLED__",
  },
  harnessAmp: {
    env: "JUNTO_HARNESS_AMP",
    define: "__JUNTO_HARNESS_AMP_ENABLED__",
  },
  harnessOmp: {
    env: "JUNTO_HARNESS_OMP",
    define: "__JUNTO_HARNESS_OMP_ENABLED__",
  },
  /**
   * Shipped stock Prime Agent managed seat. The ship baseline enables authoring;
   * an explicit build override may still disable it. HarnessId decode remains
   * independent of the authoring gate in every profile.
   */
  harnessPrimeAgent: {
    env: "JUNTO_HARNESS_PRIME_AGENT",
    define: "__JUNTO_HARNESS_PRIME_AGENT_ENABLED__",
  },
  /**
   * Settings → Agents: scan install/options and set per-harness spawn defaults
   * (model, effort, permission). Ship/prod off until the surface is ready.
   */
  harnessSettings: {
    env: "JUNTO_HARNESS_SETTINGS",
    define: "__JUNTO_HARNESS_SETTINGS_ENABLED__",
  },
} as const;

export type FeatureKey = keyof typeof FEATURE_CATALOG;

export type FeatureSet = Readonly<Record<FeatureKey, boolean>>;

/**
 * Public release baseline. Work-sink extras and the host-local Browser stay
 * off; Fleet UI and remote/host management stay off. Each gate remains the
 * way back on for a build that needs the surface.
 */
export const SHIP_FEATURES: FeatureSet = {
  cron: false,
  relay: false,
  browser: false,
  board: false,
  pad: false,
  sheet: false,
  requests: false,
  artifacts: false,
  tasks: false,
  fleetUi: false,
  usage: false,
  helpMap: false,
  audio: false,
  liveOverseer: false,
  hermesIntegration: false,
  devTools: false,
  harnessHermes: true,
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
  board: true,
  pad: true,
  sheet: true,
  requests: true,
  artifacts: true,
  tasks: true,
  fleetUi: true,
  usage: true,
  helpMap: true,
  audio: true,
  liveOverseer: true,
  hermesIntegration: true,
  devTools: true,
  harnessHermes: true,
  harnessKimi: true,
  harnessMuse: true,
  harnessFx: true,
  harnessAmp: true,
  harnessOmp: true,
  harnessPrimeAgent: true,
  harnessSettings: true,
};
