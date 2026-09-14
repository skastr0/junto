/**
 * PTY interaction layer — pure signal derivation for the managed-terminal seat.
 *
 * Combines the observer grid (marker placement), seat state, and timing
 * windows into three product signals:
 *
 *   user      — is the operator at the seat, drafting, or did WE put text there?
 *   injection — what happened to the marker we pasted into the agent's prompt?
 *   turn      — is the agent mid-turn, or has the turn ended?
 *
 * The injection marker is an opaque token (e.g. `[vc-…]`) that Vellum Command
 * pastes into the agent's prompt box alongside its instruction text. Seeing
 * the marker *in the prompt box* means our text is sitting there pending
 * submit; seeing it *outside* the box means the agent already submitted and
 * the text scrolled into output history; seeing nothing after a delivery
 * means the marker was consumed (or scrolled out of the viewport).
 *
 * All functions are pure: no I/O, no state, no clocks.
 */

import {
  afterLastHorizontalRule,
  bottomNonEmptyLines,
  isHorizontalRule,
  promptBoxBody,
} from "./regions";

/** Where is the injection marker right now? */
export type MarkerScan = "none" | "prompt" | "output" | "cleared";

/** Is the operator present / drafting / did we put text in the box? */
export type UserSignal = "absent" | "present" | "drafted" | "submitted";

/**
 * Delivery lifecycle of the last injection.
 * `failed` is reserved for producers that observe delivery errors
 * (e.g. paste rejection) — the pure mapping below never returns it.
 */
export type InjectionSignal = "none" | "live" | "in-flight" | "consumed" | "failed";

/** Agent turn lifecycle relative to the seat. */
export type TurnSignal = "none" | "in-turn" | "ended";

/**
 * The prompt region for marker purposes:
 *  - ≥2 horizontal rules → the prompt box body (between the last two rules);
 *  - exactly 1 rule       → everything after it;
 *  - no rules             → the last non-empty line (bottom-prompt harnesses
 *                           such as Codex never draw a ─── box).
 */
export const promptRegionLines = (
  lines: readonly string[],
): readonly string[] => {
  let ruleCount = 0;
  for (const line of lines) {
    if (isHorizontalRule(line)) ruleCount++;
  }
  if (ruleCount >= 2) return promptBoxBody(lines);
  if (ruleCount === 1) return afterLastHorizontalRule(lines);
  return bottomNonEmptyLines(lines, 1);
};

/** Leading prompt glyph — chrome, not content. */
const PROMPT_GLYPH = /^\s*❯(?:\s+|$)/u;

/** Any harness prompt glyph (❯ Claude / › Codex) — chrome, not content. */
const ANY_PROMPT_GLYPH = /^\s*(?:❯|›)(?:\s+|$)/u;

/**
 * Prompt glyphs the ruleless evidence region anchors on (❯ › ❭ >). `>` is
 * common in scrollback, so the anchor search is confined to the bottom tail.
 */
const EVIDENCE_GLYPH = /^\s*(?:❯|›|❭|>)(?:\s+|$)/u;
const EVIDENCE_TAIL_LINES = 10;

/**
 * Amp's composer has labeled rounded borders, so neither a plain ─── rule
 * nor a prompt glyph anchors it. Select the bottom complete box, never its
 * echoed transcript above. A connected steering panel is still queued text.
 */
const roundedComposerEvidence = (lines: readonly string[]): readonly string[] | undefined => {
  let bottom = lines.length - 1;
  while (bottom >= 0 && !lines[bottom]!.trim()) bottom -= 1;
  if (bottom < 0 || !/^\s*╰(?:─|\s*[∼≈≋~]\s)/u.test(lines[bottom]!)) return undefined;
  let top = bottom - 1;
  while (top >= 0 && /^\s*│.*│\s*$/u.test(lines[top]!)) top -= 1;
  if (top < 0 || top === bottom - 1 || !/^\s*╭[─┴]/u.test(lines[top]!)) return undefined;
  let start = top + 1;
  if (/^\s*╭┴/u.test(lines[top]!)) {
    let steeringTop = top - 1;
    while (steeringTop >= 0 && /^\s*│.*│\s*$/u.test(lines[steeringTop]!)) steeringTop -= 1;
    const steering = lines.slice(steeringTop + 1, top);
    if (steeringTop >= 0 && /^\s*╭─/u.test(lines[steeringTop]!) &&
        steering.some((line) => /^\s*│\s*steering:/u.test(line))) start = steeringTop + 1;
  }
  // Strip only the side chrome of these validated body rows. Otherwise a
  // wrapped payload head gets artificial │ characters between its pieces.
  return lines.slice(start, bottom).flatMap((line) => {
    const body = /^\s*│(.*)│\s*$/u.exec(line);
    return body ? [body[1]!] : [];
  });
};

/**
 * Evidence region for "is our text still in the composer" scans. Ruled grids
 * use promptRegionLines. On a ruleless grid the composer can sit ABOVE a
 * footer/status line, and a single last-line window misses it — anchor at
 * the last prompt-glyph line inside the bottom tail and take the rest.
 * Bottom-up anchoring keeps echoed scrollback (a submitted payload repeated
 * above the box) out of the region; a glyph-looking footer line can only
 * shrink the region (a miss), never falsely include history.
 */
export const pendingEvidenceLines = (
  lines: readonly string[],
): readonly string[] => {
  const rounded = roundedComposerEvidence(lines);
  if (rounded !== undefined) return rounded;
  for (const line of lines) {
    if (isHorizontalRule(line)) return promptRegionLines(lines);
  }
  const tailStart = Math.max(0, lines.length - EVIDENCE_TAIL_LINES);
  for (let i = lines.length - 1; i >= tailStart; i -= 1) {
    if (EVIDENCE_GLYPH.test(lines[i]!)) return lines.slice(i);
  }
  return bottomNonEmptyLines(lines, 1);
};

/**
 * Does a region hold `needle`? Per-line first, then a whitespace-squashed
 * join of the rows: a payload head hard-wrapped at the box edge is split
 * across rows (with grid padding/indent interposed) and only re-forms once
 * the rows are joined with all whitespace removed. Squashing both sides
 * keeps a wrap that lands on a real space honest too.
 */
export const regionContains = (
  lines: readonly string[],
  needle: string,
): boolean => {
  if (needle.length === 0) return false;
  for (const line of lines) {
    if (line.includes(needle)) return true;
  }
  const squash = (s: string): string => s.replace(/\s+/g, "");
  return squash(lines.join("")).includes(squash(needle));
};

/**
 * Claude/Devin composer chip. Must stay the full `[Pasted text` prefix —
 * Grok's history footer uses `[Pasted:Nlines]`, which is not a pending
 * composer chip. Shared with prompt-evidence so the prefix cannot drift.
 */
export const PASTE_CHIP_TEXT = "[Pasted text";

/**
 * No-rules grids (Codex never draws ─── rules): our bracketed paste renders
 * inside the composer as `marker\n\nbody…` — the marker line sits directly
 * above a blank-separated trailing block of consecutive non-empty lines (the
 * pasted body). A marker at that head position, inside the composer area
 * (at or below the last prompt-glyph line), is still pending in the prompt
 * box — not output history.
 */
const markerAtPasteHead = (
  lines: readonly string[],
  markerToken: string,
): boolean => {
  // Ruled grids already get the prompt-box region; the paste-head layout is
  // specific to no-rules harnesses.
  let ruleCount = 0;
  for (const line of lines) {
    if (isHorizontalRule(line)) ruleCount++;
  }
  if (ruleCount > 0) return false;

  // Trailing block of consecutive non-empty lines (the pasted body).
  let end = lines.length;
  while (end > 0 && lines[end - 1]!.trim().length === 0) end -= 1;
  if (end === 0) return false;
  let start = end;
  while (start > 0 && lines[start - 1]!.trim().length > 0) start -= 1;

  // Head: the last non-empty line directly above the block (blanks skipped).
  let head = start - 1;
  while (head >= 0 && lines[head]!.trim().length === 0) head -= 1;
  if (head < 0 || !lines[head]!.includes(markerToken)) return false;

  // The head must sit inside the composer (at or below the last prompt
  // glyph), so a marker scrolled into output history above the box is not
  // mistaken for pending text.
  for (let i = head; i >= 0; i--) {
    if (ANY_PROMPT_GLYPH.test(lines[i]!)) return true;
  }
  return false;
};

/**
 * Marker scan over the grid tail.
 *  - `prompt`  — marker inside the prompt region, or our paste-chip literal
 *                in the prompt box, or the marker at the head of our pasted
 *                block on a no-rules grid (injection pending submit);
 *  - `output`  — marker present elsewhere on screen (submitted, in history);
 *  - `cleared` — marker absent but we had delivered (consumed / scrolled away);
 *  - `none`    — marker absent and nothing was ever delivered.
 */
export const scanMarker = (
  lines: readonly string[],
  markerToken: string,
  hadDelivered: boolean,
): MarkerScan => {
  if (markerToken.length === 0) return hadDelivered ? "cleared" : "none";
  const promptRegion = pendingEvidenceLines(lines);
  if (
    regionContains(promptRegion, markerToken) ||
    regionContains(promptRegion, PASTE_CHIP_TEXT)
  ) {
    return "prompt";
  }
  if (markerAtPasteHead(lines, markerToken)) return "prompt";
  for (const line of lines) {
    if (line.includes(markerToken)) return "output";
  }
  return hadDelivered ? "cleared" : "none";
};

/**
 * Joined prompt-region text, trimmed. A bare prompt glyph (`❯`) is stripped:
 * an idle prompt box yields an empty string rather than chrome text.
 */
export const extractPromptBoxText = (lines: readonly string[]): string => {
  const parts: string[] = [];
  for (const line of promptRegionLines(lines)) {
    const t = line.replace(PROMPT_GLYPH, "").trim();
    if (t.length > 0) parts.push(t);
  }
  return parts.join("\n");
};

const effectiveMarker = (markerToken: string | undefined): string | undefined =>
  markerToken !== undefined && markerToken.length > 0 ? markerToken : undefined;

/**
 * Operator presence from the prompt box + input recency.
 *  - `present`   — last user input within USER_PRESENT_WINDOW_MS of now
 *                  (operator is actively at the seat — wins over box content);
 *  - `submitted` — prompt box non-empty AND contains our marker: our injected
 *                  text is sitting in the box, agent has not submitted yet;
 *  - `drafted`   — prompt box non-empty without our marker: an operator draft
 *                  or unrecognized text;
 *  - `absent`    — empty box, no recent input.
 */
export const deriveUserSignal = (
  promptBoxText: string,
  markerToken: string | undefined,
  lastUserInputAtMs: number | undefined,
  nowMs: number,
  USER_PRESENT_WINDOW_MS = 10_000,
): UserSignal => {
  if (
    lastUserInputAtMs !== undefined &&
    nowMs - lastUserInputAtMs <= USER_PRESENT_WINDOW_MS
  ) {
    return "present";
  }
  const text = promptBoxText.trim();
  if (text.length === 0) return "absent";
  const marker = effectiveMarker(markerToken);
  if (marker !== undefined && text.includes(marker)) return "submitted";
  return "drafted";
};

/**
 * Pure mapping from a marker scan to the injection lifecycle.
 * `hadDelivery` is a cross-check already folded into `scanMarker` ("cleared");
 * it stays in the signature for callers that derive a scan without a delivery
 * flag (e.g. from an external snapshot).
 */
export const deriveInjectionSignal = (
  markerScan: MarkerScan,
  hadDelivery: boolean,
): InjectionSignal => {
  void hadDelivery;
  switch (markerScan) {
    case "none":
      return "none";
    case "prompt":
      return "live";
    case "output":
      return "in-flight";
    case "cleared":
      return "consumed";
  }
};

/**
 * Turn lifecycle from seat state + marker + output recency.
 *  - `in-turn` — seat is working or attention (turn in progress);
 *  - `ended`   — seat idle AND (marker consumed/cleared OR output within
 *                TURN_QUIET_MS — the agent just finished and the screen is
 *                still settling);
 *  - `none`    — otherwise (unknown/gone seat, or idle with neither evidence).
 */
export const deriveTurnSignal = (
  seatState: string,
  markerScan: MarkerScan,
  lastOutputAtMs: number | undefined,
  nowMs: number,
  TURN_QUIET_MS = 4_000,
): TurnSignal => {
  if (seatState === "working" || seatState === "attention") return "in-turn";
  if (seatState === "idle") {
    if (markerScan === "cleared") return "ended";
    if (
      lastOutputAtMs !== undefined &&
      nowMs - lastOutputAtMs <= TURN_QUIET_MS
    ) {
      return "ended";
    }
  }
  return "none";
};

/** Prompt box has text beyond our own injected marker (operator content). */
const promptBoxHasNonMarkerText = (
  promptBoxText: string,
  markerToken: string | undefined,
): boolean => {
  const text = promptBoxText.trim();
  if (text.length === 0) return false;
  const marker = effectiveMarker(markerToken);
  if (marker === undefined) return true;
  return text.replaceAll(marker, "").trim().length > 0;
};

export type InteractionDerived = {
  readonly user: UserSignal;
  readonly injection: InjectionSignal;
  readonly turn: TurnSignal;
  readonly promptBoxHasNonMarkerText: boolean;
};

/** One-shot derivation of the full interaction picture from a grid tail. */
export const deriveInteraction = (
  seatState: string,
  lines: readonly string[],
  markerToken: string | undefined,
  hadDelivery: boolean,
  lastUserInputAtMs: number | undefined,
  lastOutputAtMs: number | undefined,
  nowMs: number,
): InteractionDerived => {
  const marker = scanMarker(lines, markerToken ?? "", hadDelivery);
  const promptBoxText = extractPromptBoxText(lines);
  return {
    user: deriveUserSignal(promptBoxText, markerToken, lastUserInputAtMs, nowMs),
    injection: deriveInjectionSignal(marker, hadDelivery),
    turn: deriveTurnSignal(seatState, marker, lastOutputAtMs, nowMs),
    promptBoxHasNonMarkerText: promptBoxHasNonMarkerText(promptBoxText, markerToken),
  };
};
