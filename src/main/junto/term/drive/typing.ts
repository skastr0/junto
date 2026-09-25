/**
 * Managed-terminal typing recipe — pure byte sequences, no I/O.
 *
 * Verified facts (docs/managed-terminal-verification.md + probes):
 * - Bracketed paste (ESC[200~ … ESC[201~) as ONE write, then a SEPARATE CR.
 * - Never LF (0x0A) — inserts a newline and never submits on the v1 harnesses.
 * - Never payload+CR in one write — Codex silently never submits.
 * - Interrupt is Ctrl+C (0x03) only — never ESC (rebindable / context-multiplexed).
 * - Two idle 0x03 must be ≥ ~1.0s apart (Claude self-exits in the 0.509–1.009s window).
 */

/** CSI bracketed-paste start (DECSET 2004 body). */
export const BRACKETED_PASTE_START = "\u001b[200~";
/** CSI bracketed-paste end. */
export const BRACKETED_PASTE_END = "\u001b[201~";
/** Carriage return — the only submit key we emit. */
export const CR = "\r";
/** Ctrl+C — sole interrupt byte. Never ESC. */
export const INTERRUPT_BYTE = "\u0003";

/**
 * Minimum gap between two 0x03 while the seat is idle.
 * Claude self-exits when two idle interrupts land inside ~0.5–1.0s.
 */
export const MIN_IDLE_INTERRUPT_GAP_MS = 1_000;

/** Bounded wait for turn-start acknowledgement after a prompt write. */
export const DEFAULT_PROMPT_STALL_MS = 5_000;

/**
 * Settle after paste-end (`ESC[201~`) before the first CR.
 * Claude/Devin (and other ink TUIs) collapse multi-line paste into a chip;
 * a CR that races the paste-end handler lands in the composer and never
 * submits — the operator sees `[Pasted text #N +k lines]` stuck forever.
 * Verified Claude window was 0–150ms; 40ms is inside the safe band and
 * far under Grok's 1.5s post-spawn gate.
 *
 * A newline in the payload is the chip trigger. The write recipe for those
 * bodies is paste → settle → CR → (if still pending and idle) CR. The
 * second CR is part of the recipe, not a 5s stall recovery.
 */
export const PASTE_TO_CR_SETTLE_MS = 80;

/** Ink TUIs collapse a bracketed paste into a chip when the body has a newline. */
export const payloadMayChip = (text: string): boolean => text.includes("\n");

/**
 * Hermes (E2 / GAP-DRV-6): a multiline paste chips immediately and never
 * collapses on any CR — only Ctrl+C clears it. The drive must refuse that
 * body before a write, not try the Claude/Devin 2-CR recipe.
 */
export const hermesRefusesMultilinePaste = (
  harness: string | undefined,
  text: string,
): boolean => harness === "hermes" && payloadMayChip(text);

/** Wrap text in a bracketed-paste envelope (single write payload). */
export const encodeBracketedPaste = (text: string): string =>
  `${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}`;

/**
 * Ordered PTY writes for one submitted prompt: paste envelope, then CR.
 * Callers MUST issue each element as its own write() — never join them.
 */
export const buildPromptWriteSequence = (text: string): readonly [string, string] => [
  encodeBracketedPaste(text),
  CR,
];

/**
 * Ordered PTY writes for one mail submission. A terminal that has not
 * enabled bracketed paste would show the markers as literal text, so there
 * the body is typed plain: control bytes dropped and newlines folded to
 * spaces, since each one would otherwise submit a fragment.
 */
export const buildMailWriteSequence = (
  text: string,
  bracketedPaste: boolean,
): readonly [string, string] =>
  bracketedPaste
    ? buildPromptWriteSequence(text)
    : [
        text
          .replace(/\s*[\r\n]+\s*/gu, " ")
          .replace(/[\u0000-\u001f\u007f]/gu, ""),
        CR,
      ];

/**
 * Guard for idle interrupts: two 0x03 while idle must never be < minGap apart.
 * Mid-turn (not idle) a single 0x03 is always allowed — caller skips this check.
 */
export const canSendIdleInterrupt = (
  lastIdleInterruptAtMs: number | undefined,
  nowMs: number,
  minGapMs: number = MIN_IDLE_INTERRUPT_GAP_MS,
): boolean => {
  if (lastIdleInterruptAtMs === undefined) return true;
  return nowMs - lastIdleInterruptAtMs >= minGapMs;
};
