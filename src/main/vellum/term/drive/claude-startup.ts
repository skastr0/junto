/**
 * Claude may stop a resumed, long-running session at a recovery selector.
 * The highlighted first option is its own recommended summary recovery. This
 * predicate is intentionally exact enough that it can never approve a tool,
 * permission, or arbitrary question.
 */
export const isClaudeResumeSummaryChoice = (text: string): boolean => {
  const normalized = text.toLowerCase();
  return (
    normalized.includes("resume from summary") &&
    normalized.includes("resume full session as-is") &&
    normalized.includes("enter to confirm") &&
    normalized.includes("esc to cancel")
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
