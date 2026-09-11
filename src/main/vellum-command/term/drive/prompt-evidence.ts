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

import { promptRegionLines } from "../observer/interaction";

/** Claude/Devin collapse multi-line paste into a `[Pasted text #N]` chip. */
const PASTE_CHIP_LITERAL = "[Pasted";

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
 * True when the prompt region of `snapshot` still holds text we pasted:
 * the harness chip literal (`[Pasted`), the injection marker token, or the
 * payload head. Pure: no I/O, no clocks.
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
  for (const line of promptRegionLines(snapshot.lines)) {
    if (line.includes(PASTE_CHIP_LITERAL)) return true;
    if (marker !== undefined && line.includes(marker)) return true;
    if (head.length > 0 && line.includes(head)) return true;
  }
  return false;
};
