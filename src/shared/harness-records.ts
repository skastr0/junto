/**
 * One record per harness: the template that launches it, what it reports and
 * accepts, its params, how its TUI behaves on a PTY, and where it keeps its
 * sessions. Code that branches on
 * a harness reads the record instead of naming one. Main joins the screen rule
 * pack (`src/main/junto/term/harness-record.ts`). Design: `docs/harness-domain.md`.
 */
import { HARNESS_CAPABILITIES } from "./harness-capabilities";
import { isProfileName } from "./profile-name";
import {
  type HarnessCapabilities,
  type HarnessParamKey,
  type HarnessParams,
  type HarnessParamSpec,
  NO_SESSION_STORE,
  paramSpec,
  paramsOfTemplate,
  type SessionHolds,
  type SessionStoreSupport,
  type VerifiedRange,
} from "./harness-domain";
import {
  HARNESS_IDS,
  type HarnessId,
  isHarnessId,
  type ManagedTerminalTemplate,
  templateFor,
} from "./managed-terminal-templates";

/** How a harness's TUI behaves on a PTY, as the drive must know it. */
export type HarnessPtyProfile = {
  /**
   * The TUI enables bracketed paste at startup, probed on a real PTY (DECSET
   * 2004 seen within 15s of launch). Mail never writes before the mode is on.
   */
  readonly bracketedPaste: boolean;
  /**
   * When managed typing may start.
   * - bound: once the seat is bound; the idle gate still blocks dialogs.
   * - signal: only after a positive screen signal. Hermes swallows Ctrl+C
   *   while "Installing TUI dependencies".
   * - composer: only on a settled, empty composer. Amp paints its composer
   *   while it still connects, and text typed there is lost.
   */
  readonly typingReady: "bound" | "signal" | "composer";
  /** A multiline paste chips and no CR collapses it; only Ctrl+C clears it. */
  readonly multilinePasteSticks: boolean;
  /** Minimum wait after spawn before the drive types. */
  readonly postSpawnSettleMs?: number;
  /** A paste is aborted while the pasteboard advertises an image. */
  readonly clipboardImageGuard: boolean;
};

/**
 * What the seat is to Junto. An agent is a third-party harness; the overseer
 * is Junto's own live conversation, which runs Junto's CLI and so is found on
 * Junto's CLI path as well as the tool path.
 */
export type HarnessRole = "agent" | "overseer";

export type HarnessRecord = {
  readonly harness: HarnessId;
  readonly template: ManagedTerminalTemplate;
  readonly capabilities: HarnessCapabilities;
  readonly params: HarnessParams;
  readonly pty: HarnessPtyProfile;
  /** Where the harness keeps its sessions; main supplies the locator over it. */
  readonly sessions: SessionStoreSupport;
  readonly role: HarnessRole;
  /** The harness versions this record was checked against; undefined for Junto's own seat. */
  readonly verified: VerifiedRange | undefined;
};

/**
 * The oldest and newest harness versions, inclusive, that this record's
 * rules, params and decoders were checked against: a capture in the corpus
 * (its manifest names the version) or a version a comment cites as probed.
 * Raise `through` only by re-checking against the newer version.
 */
const HARNESS_VERIFIED_VERSIONS: Readonly<Partial<Record<HarnessId, VerifiedRange>>> = {
  claude: { from: "2.1.272", through: "2.1.304" },
  codex: { from: "0.154.0", through: "0.162.1" },
  grok: { from: "1.0.52", through: "1.0.52" },
  hermes: { from: "0.20.4", through: "0.21.6" },
  pi: { from: "1.1.0", through: "1.1.0" },
  "prime-agent": { from: "0.7.1", through: "0.9.4" },
  kimi: { from: "0.34.0", through: "2.1.1" },
  muse: { from: "0.2.1", through: "1.4.10" },
  devin: { from: "3000.10.27", through: "3000.11.92" },
  cursor: { from: "2026.09.10", through: "2026.10.14" },
  agy: { from: "1.2.1", through: "1.4.0" },
  // Amp versions are 0.0.<build>.
  amp: { from: "0.0.1789401648", through: "0.0.1792209635" },
  fx: { from: "0.0.6", through: "0.0.14" },
  omp: { from: "18.0.9", through: "18.9.2" },
};

const HARNESS_ROLES: Readonly<Partial<Record<HarnessId, HarnessRole>>> = {
  "junto-overseer": "overseer",
};

const PASTE: HarnessPtyProfile = {
  bracketedPaste: true,
  typingReady: "bound",
  multilinePasteSticks: false,
  clipboardImageGuard: false,
};

const NO_PASTE: HarnessPtyProfile = { ...PASTE, bracketedPaste: false };

export const HARNESS_PTY_PROFILES: Readonly<Record<HarnessId, HarnessPtyProfile>> = {
  claude: PASTE,
  codex: PASTE,
  // Grok settles 1.5s after spawn, and an image on the pasteboard rides
  // along with a paste into it.
  grok: { ...PASTE, postSpawnSettleMs: 1_500, clipboardImageGuard: true },
  hermes: { ...PASTE, typingReady: "signal", multilinePasteSticks: true },
  pi: PASTE,
  "prime-agent": NO_PASTE,
  kimi: PASTE,
  muse: PASTE,
  devin: PASTE,
  cursor: NO_PASTE,
  agy: PASTE,
  amp: { ...PASTE, typingReady: "composer" },
  fx: PASTE,
  omp: PASTE,
  "junto-overseer": NO_PASTE,
};

const store = (...holds: readonly [SessionHolds, ...SessionHolds[]]): SessionStoreSupport => ({ level: "store", holds });

/**
 * What each harness's sessions are where it keeps them, as main's session
 * store finds them (`src/main/junto/term/session-existence.ts`), which a test
 * holds this to.
 */
export const HARNESS_SESSION_STORE_SUPPORT: Readonly<Record<HarnessId, SessionStoreSupport>> = {
  grok: store("folder"),
  // The jsonl, or the id-named folder of its sidecars.
  claude: store("transcript", "folder"),
  codex: store("transcript"),
  hermes: store("database"),
  pi: store("transcript"),
  "prime-agent": store("transcript"),
  kimi: store("folder"),
  muse: store("folder"),
  // A legacy transcript file, else the sessions database.
  devin: store("transcript", "database"),
  cursor: store("folder", "transcript"),
  agy: store("transcript", "folder"),
  amp: store("transcript"),
  fx: store("folder"),
  omp: store("transcript"),
  "junto-overseer": NO_SESSION_STORE,
};

type ParamFacts = Partial<
  Record<HarnessParamKey, Partial<Pick<HarnessParamSpec, "aliases" | "sessionOwnedFlags" | "refusedFlags" | "inAgentKey" | "custom">>>
>;

/** Param facts a template's argv spec has no slot for. */
const HARNESS_PARAM_FACTS: Readonly<Partial<Record<HarnessId, ParamFacts>>> = {
  amp: {
    // Amp accepts both spellings of its mode flag, and plugin modes beyond
    // the built-in list, so a mode key is open.
    mode: { aliases: ["--mode"], custom: true },
    // Junto applies speed features at thread creation; once the thread
    // exists they are Amp's, so a resume drops them.
    extraArgs: {
      sessionOwnedFlags: [
        { flag: "--features", takesValue: true },
        { flag: "--fast", takesValue: false },
      ],
      refusedFlags: [
        { flags: ["--visibility"], why: "Junto creates a private thread for this seat" },
        {
          flags: ["--executor", "--runner-dir", "--project", "--orb-size"],
          why: "Orb and runner seats need their own integration",
        },
        {
          flags: ["--no-tui", "--runner-id", "--share", "--desktop", "--amp-env"],
          why: "this seat uses Amp's interactive terminal, not a runner server",
        },
        {
          flags: [
            "-x", "--execute", "-ox", "--orb-execute", "--stream-json",
            "--stream-json-thinking", "--stream-json-input", "--title", "--attach",
            "--plugin-ready-timeout", "--no-archive-after-execute",
          ],
          why: "execute-mode options do not apply to an interactive seat",
        },
      ],
    },
  },
  // A Hermes seat's agent is its profile: the node factory keys it
  // `${host}:<profile>`, or `${host}:hermes` with none.
  hermes: { profile: { inAgentKey: true } },
};

/** A template's params with the harness's param facts applied. */
export const harnessParamsOf = (template: ManagedTerminalTemplate): HarnessParams => {
  const params = paramsOfTemplate(template);
  const facts = HARNESS_PARAM_FACTS[template.harness];
  if (facts === undefined) return params;
  return { ...params, params: params.params.map((spec) => ({ ...spec, ...facts[spec.key] })) };
};

export const HARNESS_RECORDS: Readonly<Record<HarnessId, HarnessRecord>> = Object.fromEntries(
  HARNESS_IDS.map((harness) => {
    const template = templateFor(harness);
    return [
      harness,
      {
        harness,
        template,
        capabilities: HARNESS_CAPABILITIES[harness],
        params: harnessParamsOf(template),
        pty: HARNESS_PTY_PROFILES[harness],
        sessions: HARNESS_SESSION_STORE_SUPPORT[harness],
        role: HARNESS_ROLES[harness] ?? "agent",
        verified: HARNESS_VERIFIED_VERSIONS[harness],
      },
    ];
  }),
) as Record<HarnessId, HarnessRecord>;

/** The record for a harness id, or undefined when it names no template. */
export const harnessRecordFor = (harness: string | undefined): HarnessRecord | undefined =>
  harness !== undefined && isHarnessId(harness) ? HARNESS_RECORDS[harness] : undefined;

/**
 * The profile a seat's agent key names, for a harness whose profile is in the
 * key. `${host}:<harness>` is the no-profile key the node factory mints.
 */
export const profileFromAgentKey = (harness: HarnessId, agentKey: string | undefined): string | undefined => {
  const profile = agentKeyProfileSuffix(harness, agentKey);
  return profile !== undefined && isProfileName(profile) ? profile : undefined;
};

/**
 * What a seat's agent key names as its profile, whether or not it is a
 * profile name: a launch refuses a key whose suffix is not one rather than
 * starting the harness's default profile.
 */
export const agentKeyProfileSuffix = (harness: HarnessId, agentKey: string | undefined): string | undefined => {
  if (paramSpec(HARNESS_RECORDS[harness].params, "profile")?.inAgentKey !== true) return undefined;
  const separator = agentKey?.indexOf(":") ?? -1;
  const profile = separator >= 0 ? agentKey?.slice(separator + 1).trim() : undefined;
  return profile && profile !== harness ? profile : undefined;
};

/** The agent key a seat's choices mint: the profile when the harness keys agents by it, else the harness. */
export const agentKeyOf = (harness: HarnessId, agentHost: string, profile: string | undefined): string =>
  paramSpec(HARNESS_RECORDS[harness].params, "profile")?.inAgentKey === true && profile
    ? `${agentHost}:${profile}`
    : `${agentHost}:${harness}`;

/** Whether this harness id is Junto's own overseer seat. */
export const isOverseerHarness = (harness: string | undefined): boolean =>
  harnessRecordFor(harness)?.role === "overseer";
