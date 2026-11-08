/**
 * Claude may stop a resumed, long-running session at a recovery selector.
 * The highlighted first option is its own recommended summary recovery. This
 * predicate is intentionally exact enough that it can never approve a tool,
 * permission, or arbitrary question.
 */

import { afterLastHorizontalRule } from "../observer/regions";
export const isClaudeResumeSummaryChoice = (text: string): boolean => {
  const normalized = text.toLowerCase();
  return (
    normalized.includes("resume from summary") &&
    normalized.includes("resume full session as-is") &&
    normalized.includes("enter to confirm") &&
    normalized.includes("esc to cancel")
  );
};

/**
 * Live-region resume-selector gate for the recovery-CR callsite.
 *
 * The whole-viewport predicate above also matches a stale selector
 * transcript scrolled above a live permission dialog: every phrase is
 * present, but Enter would answer the permission form, not the selector.
 * This gate requires all four phrases inside the live tail (after the last
 * horizontal rule — the codebase's live-dialog-chrome precedent) and
 * refuses when live permission-form chrome ("enter to select") shares that
 * tail. No horizontal rule falls back to the whole viewport, so rule-free
 * selector frames keep matching.
 */
export const isLiveClaudeResumeSummaryChoice = (
  lines: readonly string[],
): boolean => {
  const live = afterLastHorizontalRule(lines).join("\n").toLowerCase();
  return (
    live.includes("resume from summary") &&
    live.includes("resume full session as-is") &&
    live.includes("enter to confirm") &&
    live.includes("esc to cancel") &&
    !live.includes("enter to select")
  );
};

/** Claude accepted `/compact`, but a fresh session had nothing to summarize. */
export const isClaudeCompactNoop = (text: string): boolean => {
  const normalized = text.toLowerCase();
  return (
    normalized.includes("not enough messages to compact") ||
    (normalized.includes("nothing to compact") &&
      normalized.includes("no prior conversation history"))
  );
};
