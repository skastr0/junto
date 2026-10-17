/**
 * One record per harness: the template that launches it, what it reports and
 * accepts, its params, and how its TUI behaves on a PTY. Code that branches on
 * a harness reads the record instead of naming one. Main joins the screen rule
 * pack (`src/main/junto/term/harness-record.ts`). Design: `docs/harness-domain.md`.
 */
import { HARNESS_CAPABILITIES } from "./harness-capabilities";
import {
  type HarnessCapabilities,
  type HarnessParamKey,
  type HarnessParams,
  type HarnessParamSpec,
  paramSpec,
  paramsOfTemplate,
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
  readonly role: HarnessRole;
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
        role: HARNESS_ROLES[harness] ?? "agent",
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
