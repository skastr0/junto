/**
 * Prompt-pending evidence — pure derivation for the managed-terminal drive.
 *
 * The drive writes a paste envelope + CR and waits for turn-start. Some
 * harness screens lie about receipt: a working repaint can arrive while the
 * pasted text still sits in the prompt box (collapsed into the harness's
 * `[Pasted text #N +k lines]` chip, carrying our marker, or rendered as the
 * payload head). This module answers one question from a grid snapshot:
 *
 *   does the prompt region still hold OUR text?
 *
 * The drive uses the answer to (a) refuse to receipt a pending turn on a
 * false-working event, (b) skip the Ctrl+C clear when the text already left
 * the composer (late ack), and (c) refuse the awaitTurnStart:false fast path
 * while a chip is still pending.
 */

import {
  PASTE_CHIP_TEXT,
  pendingEvidenceLines,
  regionContains,
} from "../observer/interaction";

export { PASTE_CHIP_TEXT };

/** Max chars of the payload head that count as evidence on screen. */
const PAYLOAD_HEAD_MAX = 64;

/** First non-empty payload line, trimmed and capped (the "head"). */
const payloadHead = (text: string): string => {
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t.length > 0) return t.slice(0, PAYLOAD_HEAD_MAX);
  }
  return "";
};

/**
 * True when the prompt region shows Claude/Devin paste-chip chrome.
 * Grok `[Pasted:Nlines]` footers and Codex payload-head leftovers are not
 * chips — those must not request a second CR.
 */
export const promptHasPasteChip = (snapshot: {
  readonly lines: readonly string[];
}): boolean =>
  regionContains(pendingEvidenceLines(snapshot.lines), PASTE_CHIP_TEXT);

/**
 * True when the prompt region of `snapshot` still holds text we pasted:
 * the harness chip literal (`[Pasted text`), the injection marker token, or
 * the payload head. The region is glyph-anchored on ruleless grids (a footer
 * below the composer must not hide a pending line) and needles match across
 * hard-wrapped rows. Pure: no I/O, no clocks.
 */
export const promptStillPending = (
  snapshot: { readonly lines: readonly string[] },
  text: string,
  markerToken?: string,
): boolean => {
  const head = payloadHead(text);
  const marker = markerToken !== undefined && markerToken.length > 0
    ? markerToken
    : undefined;
  const region = pendingEvidenceLines(snapshot.lines);
  if (regionContains(region, PASTE_CHIP_TEXT)) return true;
  if (marker !== undefined && regionContains(region, marker)) return true;
  return regionContains(region, head);
};
