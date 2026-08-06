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

/**
 * Marker scan over the grid tail.
 *  - `prompt`  — marker inside the prompt region (our injection pending submit);
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
  const promptRegion = promptRegionLines(lines);
  for (const line of promptRegion) {
    if (line.includes(markerToken)) return "prompt";
  }
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
