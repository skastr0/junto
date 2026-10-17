/**
 * One record per harness: the template that launches it, what it reports and
 * accepts, its params, and how its TUI behaves on a PTY. Code that branches on
 * a harness reads the record instead of naming one. Main joins the screen rule
 * pack (`src/main/junto/term/harness-record.ts`). Design: `docs/harness-domain.md`.
 */
import { HARNESS_CAPABILITIES } from "./harness-capabilities";
import { type HarnessCapabilities, type HarnessParams, paramsOfTemplate } from "./harness-domain";
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

export type HarnessRecord = {
  readonly harness: HarnessId;
  readonly template: ManagedTerminalTemplate;
  readonly capabilities: HarnessCapabilities;
  readonly params: HarnessParams;
  readonly pty: HarnessPtyProfile;
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

export const HARNESS_RECORDS: Readonly<Record<HarnessId, HarnessRecord>> = Object.fromEntries(
  HARNESS_IDS.map((harness) => {
    const template = templateFor(harness);
    return [
      harness,
      {
        harness,
        template,
        capabilities: HARNESS_CAPABILITIES[harness],
        params: paramsOfTemplate(template),
        pty: HARNESS_PTY_PROFILES[harness],
      },
    ];
  }),
) as Record<HarnessId, HarnessRecord>;

/** The record for a harness id, or undefined when it names no template. */
export const harnessRecordFor = (harness: string | undefined): HarnessRecord | undefined =>
  harness !== undefined && isHarnessId(harness) ? HARNESS_RECORDS[harness] : undefined;
