export const FEATURE_CATALOG = {
  browser: {
    env: "JUNTO_BROWSER",
    define: "__JUNTO_BROWSER_ENABLED__",
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
   * picker step ride this gate.
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
   * (model, effort, permission, extra arguments). Ships on.
   */
  harnessSettings: {
    env: "JUNTO_HARNESS_SETTINGS",
    define: "__JUNTO_HARNESS_SETTINGS_ENABLED__",
  },
  /**
   * Seat awareness (Jev) and seat collaboration: the advisory sidecar, the
   * hover that paints its judgment, the thread-health reading and the minimap
   * tint it drives, and the peer-help request and its thread. Display only:
   * no judgment gates a delivery.
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
        "A model reads each agent's recent terminal output and says how it is going: stuck, thrashing, waiting on you, or going well. Terminal excerpts are sent to the provider while this is on.",
      requirement: {
        env: "TYPESAFE_API_KEY",
        label: "Needs a provider key in TYPESAFE_API_KEY.",
      },
      applies: "live",
    },
  },
  /**
   * The Files node (0.11): one folder on one machine as a file tree with a
   * light editor. Ships on in 0.11; the experimental entry stays the way to
   * ship it behind the Settings toggle again.
   */
  files: {
    env: "JUNTO_FILES",
    define: "__JUNTO_FILES_TIER__",
    experimental: {
      title: "Files node",
      description:
        "A canvas node that opens a folder on this machine as a file tree, with a light editor, previews and comments.",
      applies: "live",
    },
  },
  /**
   * One authority per canvas, by quorum commit (0.11/06, F1 to F6): the
   * consensus driver, the authority owner ops and `junto authority`. Carried
   * to 0.12: off in ship, on in all-on. Off, nothing starts the driver and no
   * way in reaches the ops; the state step's tables stay empty. No
   * `experimental` entry: the driver fills missing lists once per store
   * (c0ef3775e), which holds only while the gate is fixed for the process.
   */
  authority: {
    env: "JUNTO_AUTHORITY",
    define: "__JUNTO_AUTHORITY_ENABLED__",
  },
  /**
   * A vault per machine, 1Password first (0.11/07, N5): the token's scope
   * record, the token file and a region source read with this machine's own
   * token. Carried to 0.12: off in ship, on in all-on. Off, no token is read,
   * minted or written, and the state step's table stays empty.
   */
  vault: {
    env: "JUNTO_VAULT",
    define: "__JUNTO_VAULT_ENABLED__",
  },
  /**
   * Files over SSH (0.11/12): a Files node on another machine served through
   * that machine's Junto over the link, and `unreachable` when it cannot be
   * reached. For 0.12: off in ship, on in all-on. Off, another machine's
   * Files node is the stub card it is today.
   */
  filesRemote: {
    env: "JUNTO_FILES_REMOTE",
    define: "__JUNTO_FILES_REMOTE_ENABLED__",
  },
  /**
   * Code steps in automations (0.11/05, K1 to K4): the step in the editor and
   * the CLI, and the runner that starts its process. Off in ship until a
   * real-app walk passes. Off, a save refuses a code step, the editor and the
   * CLI do not offer one, and a stored one is ruled not_available unrun.
   */
  codeSteps: {
    env: "JUNTO_CODE_STEPS",
    define: "__JUNTO_CODE_STEPS_ENABLED__",
  },
  /**
   * The signal action in automations (0.11/07, N2): an automation raising a
   * signal in the needs-you feed, and answers back into automations (0.11/09).
   * On in ship from 0.11.1, after its real-app walks. Off, a save refuses
   * the action, the editor and the CLI do not offer it, and a stored one is
   * ruled not_available unraised. Seat raises
   * and their forms (N1, N3, N4) are not under it.
   */
  automationSignals: {
    env: "JUNTO_AUTOMATION_SIGNALS",
    define: "__JUNTO_AUTOMATION_SIGNALS_ENABLED__",
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
 * Public release baseline. Tasks, Artifacts and the host-local Browser ship
 * on; the other gates stay as they are. Each gate remains the way back off or
 * on for a build that needs it. Seat awareness ships experimental: compiled in,
 * toggled off by default.
 */
export const SHIP_FEATURES: FeatureSet = {
  browser: true,
  artifacts: true,
  tasks: true,
  // Machines: the window, the owner commands and seats on other machines.
  fleetUi: true,
  usage: false,
  helpMap: false,
  // The procedural sound engine, at a gentle default volume.
  audio: true,
  liveOverseer: false,
  devTools: false,
  // Built and in the app, off until the operator turns it on in Settings.
  seatAwareness: "experimental",
  // The Files node (0.11) ships on.
  files: true,
  // Fleet authority and the vault are carried to 0.12: built from main, never live in ship.
  authority: false,
  vault: false,
  // Files over SSH is for 0.12: built from main, never live in ship until remote-verify walks it.
  filesRemote: false,
  // Unverified in the real app at the freeze: flips on when its walk passes (0.11 release checklist).
  codeSteps: false,
  // On from 0.11.1: N2 and H5 walked in the real app, dark and bright
  // (operator-work-verify 25/25, human-loop-h5-verify 12/12).
  automationSignals: true,
  harnessHermes: true,
  harnessKimi: true,
  harnessMuse: true,
  harnessFx: true,
  harnessAmp: true,
  harnessOmp: true,
  harnessPrimeAgent: true,
  harnessSettings: true,
};

export const ALL_FEATURES: FeatureSet = {
  browser: true,
  artifacts: true,
  tasks: true,
  fleetUi: true,
  usage: true,
  helpMap: true,
  audio: true,
  liveOverseer: true,
  devTools: true,
  seatAwareness: true,
  files: true,
  authority: true,
  vault: true,
  filesRemote: true,
  codeSteps: true,
  automationSignals: true,
  harnessHermes: true,
  harnessKimi: true,
  harnessMuse: true,
  harnessFx: true,
  harnessAmp: true,
  harnessOmp: true,
  harnessPrimeAgent: true,
  harnessSettings: true,
};
