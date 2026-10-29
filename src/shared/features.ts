/**
 * Compile-time product feature gates.
 *
 * Values are injected by electron-vite / bun build `define`. When the define
 * is absent (tsc, vitest without define), the env fallback applies so unit
 * tests and unbundled scripts stay deterministic.
 *
 * Product surfaces default OFF. Each may be enabled for a build with its
 * dedicated `JUNTO_*` environment variable. Official builders always inject
 * every define; the environment fallback exists only for source-run tooling.
 *
 * A feature may also ship in the middle tier, `experimental` (see
 * `FeatureTier`): compiled in, off until the operator turns it on in Settings.
 * Such a feature exports its TIER, never a boolean, so no consumer can read
 * "compiled in" as "on"; they read the resolved predicate instead.
 */

import { featureTierOn, type FeatureKey, type FeatureTier } from "./feature-catalog";

declare const __JUNTO_BROWSER_ENABLED__: boolean | undefined;
declare const __JUNTO_ARTIFACTS_ENABLED__: boolean | undefined;
declare const __JUNTO_TASKS_ENABLED__: boolean | undefined;
declare const __JUNTO_FLEET_UI_ENABLED__: boolean | undefined;
declare const __JUNTO_USAGE_ENABLED__: boolean | undefined;
declare const __JUNTO_HELP_MAP_ENABLED__: boolean | undefined;
declare const __JUNTO_AUDIO_ENABLED__: boolean | undefined;
declare const __JUNTO_LIVE_OVERSEER_ENABLED__: boolean | undefined;
declare const __JUNTO_DEV_TOOLS_ENABLED__: boolean | undefined;
declare const __JUNTO_HARNESS_HERMES_ENABLED__: boolean | undefined;
declare const __JUNTO_HARNESS_KIMI_ENABLED__: boolean | undefined;
declare const __JUNTO_HARNESS_MUSE_ENABLED__: boolean | undefined;
declare const __JUNTO_HARNESS_FX_ENABLED__: boolean | undefined;
declare const __JUNTO_HARNESS_AMP_ENABLED__: boolean | undefined;
declare const __JUNTO_HARNESS_OMP_ENABLED__: boolean | undefined;
declare const __JUNTO_HARNESS_PRIME_AGENT_ENABLED__: boolean | undefined;
declare const __JUNTO_HARNESS_SETTINGS_ENABLED__: boolean | undefined;
declare const __JUNTO_SEAT_AWARENESS_TIER__: FeatureTier | undefined;
declare const __JUNTO_FILES_TIER__: FeatureTier | undefined;
declare const __JUNTO_AUTHORITY_ENABLED__: boolean | undefined;
declare const __JUNTO_VAULT_ENABLED__: boolean | undefined;
declare const __JUNTO_CODE_STEPS_ENABLED__: boolean | undefined;
declare const __JUNTO_AUTOMATION_SIGNALS_ENABLED__: boolean | undefined;

const envEnabled = (key: string): boolean => {
  try {
    return process.env[key] === "1";
  } catch {
    return false;
  }
};

const envTier = (key: string): FeatureTier => {
  try {
    const raw = process.env[key];
    return raw === "1" ? true : raw === "experimental" ? "experimental" : false;
  } catch {
    return false;
  }
};

const definedTier = (value: unknown): value is FeatureTier =>
  typeof value === "boolean" || value === "experimental";

export const BROWSER_ENABLED: boolean =
  typeof __JUNTO_BROWSER_ENABLED__ === "boolean"
    ? __JUNTO_BROWSER_ENABLED__
    : envEnabled("JUNTO_BROWSER");

/** Artifacts sink — node authoring, wires, and the artifact CLI. */
export const ARTIFACTS_ENABLED: boolean =
  typeof __JUNTO_ARTIFACTS_ENABLED__ === "boolean"
    ? __JUNTO_ARTIFACTS_ENABLED__
    : envEnabled("JUNTO_ARTIFACTS");

/**
 * Tasks sink — node authoring, wires, the tasks CLI group, and the
 * task-scoped content access and verdicts that hang off it.
 */
export const TASKS_ENABLED: boolean =
  typeof __JUNTO_TASKS_ENABLED__ === "boolean"
    ? __JUNTO_TASKS_ENABLED__
    : envEnabled("JUNTO_TASKS");

export const FLEET_UI_ENABLED: boolean =
  typeof __JUNTO_FLEET_UI_ENABLED__ === "boolean"
    ? __JUNTO_FLEET_UI_ENABLED__
    : envEnabled("JUNTO_FLEET_UI");

export const USAGE_ENABLED: boolean =
  typeof __JUNTO_USAGE_ENABLED__ === "boolean"
    ? __JUNTO_USAGE_ENABLED__
    : envEnabled("JUNTO_USAGE");

export const HELP_MAP_ENABLED: boolean =
  typeof __JUNTO_HELP_MAP_ENABLED__ === "boolean"
    ? __JUNTO_HELP_MAP_ENABLED__
    : envEnabled("JUNTO_HELP_MAP");

/** Local GPT-Live POC, disabled unless explicitly included in this build. */
export const LIVE_OVERSEER_ENABLED: boolean =
  typeof __JUNTO_LIVE_OVERSEER_ENABLED__ === "boolean"
    ? __JUNTO_LIVE_OVERSEER_ENABLED__
    : envEnabled("JUNTO_LIVE_OVERSEER");

export const AUDIO_ENABLED: boolean =
  typeof __JUNTO_AUDIO_ENABLED__ === "boolean"
    ? __JUNTO_AUDIO_ENABLED__
    : envEnabled("JUNTO_AUDIO");

/**
 * Developer diagnostics in Advanced settings + logs explorer chrome.
 * Compile-time only: ship profile injects false; prod never shows install
 * feed URLs, build/updater provenance, data paths, or logs explorer.
 */
export const DEV_TOOLS_ENABLED: boolean =
  typeof __JUNTO_DEV_TOOLS_ENABLED__ === "boolean"
    ? __JUNTO_DEV_TOOLS_ENABLED__
    : envEnabled("JUNTO_DEV_TOOLS");

/**
 * Hermes managed TUI seat — ON; the gate stays as the way back off.
 *
 * The terminal seat is `hermes chat --tui` on a PTY like every other harness.
 * Known limit carried by the template: Hermes chips multiline bracketed
 * paste, so typed delivery beyond the `-q` spawn prompt is single-line only.
 */
export const HARNESS_HERMES_ENABLED: boolean =
  typeof __JUNTO_HARNESS_HERMES_ENABLED__ === "boolean"
    ? __JUNTO_HARNESS_HERMES_ENABLED__
    : envEnabled("JUNTO_HARNESS_HERMES");

/** Kimi Code managed seat — ON; the gate stays as the way back off. */
export const HARNESS_KIMI_ENABLED: boolean =
  typeof __JUNTO_HARNESS_KIMI_ENABLED__ === "boolean"
    ? __JUNTO_HARNESS_KIMI_ENABLED__
    : envEnabled("JUNTO_HARNESS_KIMI");

/** Muse Code managed seat — ON; the gate stays as the way back off. */
export const HARNESS_MUSE_ENABLED: boolean =
  typeof __JUNTO_HARNESS_MUSE_ENABLED__ === "boolean"
    ? __JUNTO_HARNESS_MUSE_ENABLED__
    : envEnabled("JUNTO_HARNESS_MUSE");

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
  typeof __JUNTO_HARNESS_FX_ENABLED__ === "boolean"
    ? __JUNTO_HARNESS_FX_ENABLED__
    : envEnabled("JUNTO_HARNESS_FX");

/**
 * Amp managed seat — ON; the gate stays as the way back off. Seat rules and
 * the thread-receipt parser are proven against the installed CLI.
 */
export const HARNESS_AMP_ENABLED: boolean =
  typeof __JUNTO_HARNESS_AMP_ENABLED__ === "boolean"
    ? __JUNTO_HARNESS_AMP_ENABLED__
    : envEnabled("JUNTO_HARNESS_AMP");

/**
 * Oh My Pi managed seat — ON, with the gate kept for a fast way back off.
 *
 * Residual, unchanged by the flag: its approval dialog has never been
 * captured, so the attention rule matches literals taken from the shipped
 * binary rather than a rendered frame — a seat sitting on a permission prompt
 * may read idle until that capture exists.
 */
export const HARNESS_OMP_ENABLED: boolean =
  typeof __JUNTO_HARNESS_OMP_ENABLED__ === "boolean"
    ? __JUNTO_HARNESS_OMP_ENABLED__
    : envEnabled("JUNTO_HARNESS_OMP");

/** Stock Prime Agent 0.7.1 managed seat; separately installed CLI required. */
export const HARNESS_PRIME_AGENT_ENABLED: boolean =
  typeof __JUNTO_HARNESS_PRIME_AGENT_ENABLED__ === "boolean"
    ? __JUNTO_HARNESS_PRIME_AGENT_ENABLED__
    : envEnabled("JUNTO_HARNESS_PRIME_AGENT");

/**
 * Settings → Agents surface: scan harness CLIs/options and persist per-harness
 * spawn defaults. Ships on.
 */
export const HARNESS_SETTINGS_ENABLED: boolean =
  typeof __JUNTO_HARNESS_SETTINGS_ENABLED__ === "boolean"
    ? __JUNTO_HARNESS_SETTINGS_ENABLED__
    : envEnabled("JUNTO_HARNESS_SETTINGS");

/**
 * Seat awareness (Jev) and seat collaboration — the advisory sidecar, its hover,
 * the thread-health reading, and the peer-help request. Display only.
 *
 * EXPERIMENTAL in the ship profile: compiled in, off until the operator turns
 * it on in Settings. This is the build's tier, not the answer to "is it on":
 * read {@link seatAwarenessOn} (or the renderer's `useSeatAwarenessOn`), which
 * folds in the operator's toggle. Off, no client is constructed, nothing is
 * observed, no surface renders and the collaboration action is refused.
 */
export const SEAT_AWARENESS_TIER: FeatureTier =
  typeof __JUNTO_SEAT_AWARENESS_TIER__ !== "undefined" &&
  definedTier(__JUNTO_SEAT_AWARENESS_TIER__)
    ? __JUNTO_SEAT_AWARENESS_TIER__
    : envTier("JUNTO_SEAT_AWARENESS");

/** Seat awareness is in this build at all (on or experimental). */
export const SEAT_AWARENESS_COMPILED: boolean = SEAT_AWARENESS_TIER !== false;

/**
 * The Files node (0.11): the `files` kind, its card and its modal.
 *
 * EXPERIMENTAL in the ship profile, on in all-on. This is the build's tier:
 * read {@link filesOn} for "is it on", which folds in the operator's toggle.
 */
export const FILES_TIER: FeatureTier =
  typeof __JUNTO_FILES_TIER__ !== "undefined" && definedTier(__JUNTO_FILES_TIER__)
    ? __JUNTO_FILES_TIER__
    : envTier("JUNTO_FILES");

/** The Files node is in this build at all (on or experimental). */
export const FILES_COMPILED: boolean = FILES_TIER !== false;

/**
 * One authority per canvas (0.11/06): the consensus driver, the authority
 * owner ops and `junto authority`. OFF in ship (carried to 0.12), on in all-on.
 */
export const AUTHORITY_ENABLED: boolean =
  typeof __JUNTO_AUTHORITY_ENABLED__ === "boolean"
    ? __JUNTO_AUTHORITY_ENABLED__
    : envEnabled("JUNTO_AUTHORITY");

/**
 * A vault per machine (0.11/07, N5): token scope, token file and a region
 * source read with this machine's own token. OFF in ship (carried to 0.12).
 */
export const VAULT_ENABLED: boolean =
  typeof __JUNTO_VAULT_ENABLED__ === "boolean"
    ? __JUNTO_VAULT_ENABLED__
    : envEnabled("JUNTO_VAULT");

/** Code steps in automations (0.11/05 K1 to K4): saved, offered and run. */
export const CODE_STEPS_ENABLED: boolean =
  typeof __JUNTO_CODE_STEPS_ENABLED__ === "boolean"
    ? __JUNTO_CODE_STEPS_ENABLED__
    : envEnabled("JUNTO_CODE_STEPS");

/** The signal action in automations (0.11/07 N2): saved, offered and raised. */
export const AUTOMATION_SIGNALS_ENABLED: boolean =
  typeof __JUNTO_AUTOMATION_SIGNALS_ENABLED__ === "boolean"
    ? __JUNTO_AUTOMATION_SIGNALS_ENABLED__
    : envEnabled("JUNTO_AUTOMATION_SIGNALS");

export const BUILD_FEATURES = {
  browser: BROWSER_ENABLED,
  artifacts: ARTIFACTS_ENABLED,
  tasks: TASKS_ENABLED,
  fleetUi: FLEET_UI_ENABLED,
  usage: USAGE_ENABLED,
  helpMap: HELP_MAP_ENABLED,
  audio: AUDIO_ENABLED,
  liveOverseer: LIVE_OVERSEER_ENABLED,
  devTools: DEV_TOOLS_ENABLED,
  harnessHermes: HARNESS_HERMES_ENABLED,
  harnessKimi: HARNESS_KIMI_ENABLED,
  harnessMuse: HARNESS_MUSE_ENABLED,
  harnessFx: HARNESS_FX_ENABLED,
  harnessAmp: HARNESS_AMP_ENABLED,
  harnessOmp: HARNESS_OMP_ENABLED,
  harnessPrimeAgent: HARNESS_PRIME_AGENT_ENABLED,
  harnessSettings: HARNESS_SETTINGS_ENABLED,
  seatAwareness: SEAT_AWARENESS_TIER,
  files: FILES_TIER,
  authority: AUTHORITY_ENABLED,
  vault: VAULT_ENABLED,
  codeSteps: CODE_STEPS_ENABLED,
  automationSignals: AUTOMATION_SIGNALS_ENABLED,
} as const satisfies Readonly<Record<FeatureKey, FeatureTier>>;

/** The operator's experimental toggles, as the settings row stores them. */
export type ExperimentalOptIns = Readonly<Record<string, boolean>> | undefined;

/** Features this build compiled in as experimental: the Settings list. */
export const experimentalFeatureKeys = (): ReadonlyArray<FeatureKey> =>
  (Object.keys(BUILD_FEATURES) as Array<FeatureKey>).filter(
    (key) => BUILD_FEATURES[key] === "experimental",
  );

/**
 * The one resolved predicate for a tiered feature: compiled, and either on in
 * this build or turned on by the operator. An opt-in for a feature this build
 * ships on or compiled out changes nothing.
 */
export const featureOn = (
  key: FeatureKey,
  optIns: ExperimentalOptIns,
): boolean => featureTierOn(BUILD_FEATURES[key], optIns?.[key] === true);

/** Seat awareness (Jev) resolved against the operator's toggle. */
export const seatAwarenessOn = (optIns: ExperimentalOptIns): boolean =>
  featureOn("seatAwareness", optIns);

/** The Files node resolved against the operator's toggle. */
export const filesOn = (optIns: ExperimentalOptIns): boolean =>
  featureOn("files", optIns);

/**
 * Historical hidden kinds remain decodable, but cannot regain authoring
 * controls. This is the one predicate every authoring, wire, and capability
 * surface reads so a disabled feature cannot reappear through a side door.
 */
export const productNodeKindEnabled = (kind: string | undefined): boolean => {
  if (kind === "task") return TASKS_ENABLED;
  if (kind === "page") return BROWSER_ENABLED;
  if (kind === "artifacts") return ARTIFACTS_ENABLED;
  // Compiled in: a files node decodes, stores and draws. Authoring surfaces
  // also read the operator's toggle through filesOn.
  if (kind === "files") return FILES_COMPILED;
  return true;
};

/**
 * Whether a capability token belongs to a surface this build enabled. The
 * sibling of {@link productNodeKindEnabled} for lists that speak ports (CLI
 * docs, capability inventories) rather than node kinds.
 */
export const productPortEnabled = (port: string): boolean => {
  if (port.startsWith("tasks.")) return TASKS_ENABLED;
  if (port.startsWith("content.")) return TASKS_ENABLED;
  if (port.startsWith("artifact.")) return ARTIFACTS_ENABLED;
  if (port.startsWith("browser.")) return BROWSER_ENABLED;
  return true;
};

/**
 * Whether an overseer operation belongs to a surface this build enabled.
 * Gated families leave the catalog, the CLI tree, the offline lists, and the
 * live dispatcher together.
 */
export const overseerOperationEnabled = (operation: string): boolean => {
  const family = operation.split(".", 1)[0] ?? operation;
  if (family === "task") return TASKS_ENABLED;
  if (family === "content") return TASKS_ENABLED;
  if (family === "artifact") return ARTIFACTS_ENABLED;
  if (family === "page") return BROWSER_ENABLED;
  return true;
};

/**
 * Whether this build runs a resource kind's commands. A command of a kind
 * that is off is refused whole on every way in: the work socket, the
 * renderer's resource IPC and a peer's queued command.
 */
export const productResourceKindEnabled = (kind: string): boolean => {
  if (kind === "task") return TASKS_ENABLED;
  if (kind === "artifact") return ARTIFACTS_ENABLED;
  return true;
};

/**
 * The build features a harness template may name as its authoring gate, and
 * whether each is on. The template declares which one is its own.
 */
export const HARNESS_FEATURE_GATES = {
  liveOverseer: LIVE_OVERSEER_ENABLED,
  harnessHermes: HARNESS_HERMES_ENABLED,
  harnessKimi: HARNESS_KIMI_ENABLED,
  harnessMuse: HARNESS_MUSE_ENABLED,
  harnessFx: HARNESS_FX_ENABLED,
  harnessAmp: HARNESS_AMP_ENABLED,
  harnessOmp: HARNESS_OMP_ENABLED,
  harnessPrimeAgent: HARNESS_PRIME_AGENT_ENABLED,
} as const satisfies Partial<Record<FeatureKey, boolean>>;

export type HarnessFeatureGate = keyof typeof HARNESS_FEATURE_GATES;
