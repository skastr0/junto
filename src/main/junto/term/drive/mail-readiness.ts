/**
 * Mail readiness: when a seat's terminal can take a pasted message.
 *
 * A seat whose process is running is not yet a seat that reads input. Mail
 * written before the harness TUI enabled bracketed paste (DECSET 2004) lands
 * as literal `^[[200~…^[[201~` text and its CR is eaten by startup, so the
 * operator has to press Enter by hand. Mail therefore waits for the first
 * ready moment of each process generation: the TUI has asked for bracketed
 * paste and the seat has settled idle. After that moment mail is typed
 * whatever the seat is doing, as the delivery law says, as long as the
 * terminal still takes a paste.
 *
 * A harness not known to use bracketed paste is ready on confirmed idle
 * chrome instead, and the drive types its text without paste markers.
 */

import type { AgentSeatState } from "../../../../shared/agent-seat-state";

/**
 * Harnesses whose TUI enables bracketed paste at startup, probed on a real
 * PTY (DECSET 2004 seen within 15s of launch). Mail to these never writes
 * before the mode is on.
 */
export const BRACKETED_PASTE_HARNESSES: ReadonlySet<string> = new Set([
  "agy",
  "amp",
  "claude",
  "codex",
  "devin",
  "fx",
  "grok",
  "hermes",
  "kimi",
  "muse",
  "omp",
  "pi",
]);

/** Amp paints its composer while it still connects; text typed there is lost. */
const AMP_STARTUP_FOOTER =
  /^\s*╰\s*(?:[∼≈≋~]\s*)?(?:loading thread|connecting|reconnecting|catching up)\b/iu;

export type MailReadinessInput = {
  /** The seat's process generation is running. */
  readonly running: boolean;
  /** That generation's identity (terminal epoch). */
  readonly generation?: string;
  readonly harness?: string;
  readonly seatState?: AgentSeatState;
  /** The TUI has enabled bracketed paste (observer mode flag). */
  readonly bracketedPaste: boolean;
  /** High-confidence or visible idle chrome (the drive's idle gate). */
  readonly idleConfirmed: boolean;
  /** Last screen lines, for harnesses that paint before they connect. */
  readonly lines?: ReadonlyArray<string>;
};

const usesBracketedPaste = (harness: string | undefined): boolean =>
  BRACKETED_PASTE_HARNESSES.has(harness?.trim().toLowerCase() ?? "");

/** The terminal takes a paste right now: the mode is on, or never used. */
export const mailPasteable = (input: MailReadinessInput): boolean =>
  input.running && (input.bracketedPaste || !usesBracketedPaste(input.harness));

/** The first ready moment of a generation: TUI up and settled idle. */
export const mailFirstReady = (input: MailReadinessInput): boolean => {
  if (!input.running || input.seatState !== "idle") return false;
  if (!usesBracketedPaste(input.harness)) {
    return input.bracketedPaste || input.idleConfirmed;
  }
  if (!input.bracketedPaste) return false;
  if (input.harness === "amp") {
    const tail = (input.lines ?? []).filter((line) => line.trim()).slice(-8);
    if (tail.some((line) => AMP_STARTUP_FOOTER.test(line))) return false;
  }
  return true;
};

/**
 * Per-binding latch of the first ready moment, held for one generation.
 * Process-local; a respawned seat has a new generation and waits for its
 * own TUI.
 */
export class MailReadinessLatch {
  /** bindingId → the generation that has been ready. */
  private readonly ready = new Map<string, string | undefined>();

  /** Record what the seat shows now; true when mail may be typed now. */
  observe(bindingId: string, input: MailReadinessInput): boolean {
    if (!input.running) {
      this.ready.delete(bindingId);
      return false;
    }
    const latched =
      this.ready.has(bindingId) && this.ready.get(bindingId) === input.generation;
    if (!latched) {
      if (!mailFirstReady(input)) return false;
      this.ready.set(bindingId, input.generation);
    }
    return mailPasteable(input);
  }

  clear(): void {
    this.ready.clear();
  }
}
