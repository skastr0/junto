import type { TerminalManagedPromptResult } from "@shared/ipc";
import type { PromptResult } from "./message-delivery";

const QUEUED_REFUSALS = new Set([
  "seat-busy",
  "composer-not-empty",
  "composer-unreadable",
  "not-ready",
  "operator-active",
]);

/**
 * Map one explicit prompt() result to the operator multi-prompt verdict.
 * Settled (already delivered by notifyAppended) is submitted. Busy / draft /
 * paused leave the durable row pending as queued. Written-without-proof is
 * unresolved and never auto-retries the same generation.
 */
export const mapPromptResultToVerdict = (
  result: PromptResult,
  messageId: string,
): TerminalManagedPromptResult => {
  if ("unavailable" in result) {
    switch (result.unavailable) {
      case "settled":
        return { ok: true, disposition: "submitted", messageId };
      case "paused":
        return {
          ok: true,
          disposition: "queued",
          messageId,
          reason: "paused",
        };
      case "parked":
        return {
          ok: false,
          disposition: "failed",
          messageId,
          reason: "parked",
          error: "Prompt delivery parked after too many transport attempts",
        };
      case "gone":
        return {
          ok: false,
          disposition: "failed",
          messageId,
          reason: "gone",
          error: "Prompt message or seat is gone",
        };
      case "unconfigured":
        return {
          ok: false,
          disposition: "failed",
          messageId,
          reason: "unconfigured",
          error: "Prompt delivery is unconfigured",
        };
    }
  }
  const { outcome } = result;
  if (outcome.status === "submitted") {
    return { ok: true, disposition: "submitted", messageId };
  }
  if (
    outcome.status === "unresolved" ||
    (outcome.status === "refused" && outcome.reason === "written-unresolved")
  ) {
    const reason =
      outcome.status === "unresolved" ? outcome.reason : "written-unresolved";
    return {
      ok: false,
      disposition: "unresolved",
      messageId,
      reason,
      error:
        "Prompt submission is unconfirmed. Inspect the terminal before retrying.",
    };
  }
  if (outcome.status === "refused" && QUEUED_REFUSALS.has(outcome.reason)) {
    return {
      ok: true,
      disposition: "queued",
      messageId,
      reason: outcome.reason,
    };
  }
  const reason = outcome.status === "refused" ? outcome.reason : "failed";
  return {
    ok: false,
    disposition: "failed",
    messageId,
    reason,
    error: `Prompt refused before writing: ${reason}`,
  };
};
