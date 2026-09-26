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
  /** Sound: the procedural cue engine and Settings, Sound. */
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
  /**
   * Seat awareness (Jev) and seat collaboration: the advisory sidecar, the
   * hover that paints its judgment, the thread-health reading and the minimap
   * tint it drives, the peer-help request and its thread, and the AI hold on
   * the delivery gate.
   *
   * Ship profile EXPERIMENTAL: compiled in, off until the operator turns it on
   * in Settings, Experimental. Off (the tier or the toggle), the sidecar
   * constructs no client, publishes nothing, renders no surface and refuses the
   * collaboration action. On, it still needs its provider key.
   */
  seatAwareness: {
    env: "JUNTO_SEAT_AWARENESS",
    define: "__JUNTO_SEAT_AWARENESS_TIER__",
    experimental: {
      title: "Seat awareness (Jev)",
      description:
        "A model reads each agent seat's recent terminal output and says how the thread is going: " +
        "stuck, thrashing, waiting on you, or going well. Seat cards, the minimap and the feed show " +
        "its reading, and a seat can ask a peer for help. Terminal excerpts are sent to the provider " +
        "while this is on.",
      requirement: {
        env: "TYPESAFE_API_KEY",
        label: "Needs a provider key in TYPESAFE_API_KEY. Without one, seats say the key is missing.",
      },
      applies: "live",
    },
  },
  /**
   * The reviews connection family between two seats. Off, seats connect only
   * as messages: no family choice when drawing, no swap to reviews, and no
   * authoring path offers the verb. Existing reviews edges still decode.
   */
  reviews: {
    env: "JUNTO_REVIEWS",
    define: "__JUNTO_REVIEWS_ENABLED__",
  },
} as const;

export type FeatureKey = keyof typeof FEATURE_CATALOG;

/**
 * How one build carries one feature.
 *
 *   false            compiled out: not built yet, or pruned from this build.
 *   "experimental"   compiled in, OFF until the operator turns it on in
 *                    Settings, Experimental. The toggle is a product setting.
 *   true             compiled in and on.
 *
 * Only a feature whose catalog entry declares `experimental` has a runtime
 * toggle, so only those may take the middle tier; the build refuses the rest.
 */
export type FeatureTier = boolean | "experimental";

export type FeatureSet = Readonly<Record<FeatureKey, FeatureTier>>;

/** What Settings shows for a feature that can ship experimental. */
export type ExperimentalFeatureSpec = {
  readonly title: string;
  readonly description: string;
  /** Something the feature needs beyond the toggle, named plainly. */
  readonly requirement?: { readonly env: string; readonly label: string };
  /** "live": the toggle takes effect at once. "restart": after a relaunch. */
  readonly applies: "live" | "restart";
};

export const experimentalFeatureSpec = (
  key: FeatureKey,
): ExperimentalFeatureSpec | undefined => {
  const entry = FEATURE_CATALOG[key];
  return "experimental" in entry ? entry.experimental : undefined;
};

/** Compiled into the build, whether on or experimental. */
export const featureCompiled = (tier: FeatureTier): boolean => tier !== false;

/**
 * The one resolved predicate: compiled, and either on in this build or turned
 * on by the operator. Every consumer of a tiered feature reads this.
 */
export const featureTierOn = (tier: FeatureTier, optedIn: boolean): boolean =>
  tier === true || (tier === "experimental" && optedIn);

/** The receipt word for a tier: honest about the middle one. */
export const featureTierWord = (tier: FeatureTier): "on" | "experimental" | "off" =>
  tier === true ? "on" : tier === false ? "off" : "experimental";

/**
 * Public release baseline. Work-sink extras and the host-local Browser stay
 * off; Fleet UI and remote/host management stay off. Each gate remains the
 * way back on for a build that needs the surface. Seat awareness ships
 * experimental: compiled in, toggled off by default.
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
  // The procedural sound engine, at a gentle default volume.
  audio: true,
  liveOverseer: false,
  hermesIntegration: false,
  devTools: false,
  // Built and in the app, off until the operator turns it on in Settings.
  seatAwareness: "experimental",
  reviews: false,
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
  seatAwareness: true,
  reviews: true,
  harnessHermes: true,
  harnessKimi: true,
  harnessMuse: true,
  harnessFx: true,
  harnessAmp: true,
  harnessOmp: true,
  harnessPrimeAgent: true,
  harnessSettings: true,
};
