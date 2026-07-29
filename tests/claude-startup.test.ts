import { describe, expect, it } from "vitest";
import { isClaudeResumeSummaryChoice } from "../src/main/vellum/term/drive/claude-startup";

describe("Claude managed startup recovery", () => {
  it("recognizes only the long-session summary selector", () => {
    expect(
      isClaudeResumeSummaryChoice(`
        This session is 1h 52m old and 207.2k tokens.
        1. Resume from summary (recommended)
        2. Resume full session as-is
        Enter to confirm · Esc to cancel
      `),
    ).toBe(true);
  });

  it.each([
    "Do you want to proceed? Enter to confirm · Esc to cancel",
    "1. Resume from summary (recommended)",
    "Resume full session as-is · Enter to confirm",
  ])("does not match another interactive prompt: %s", (text) => {
    expect(isClaudeResumeSummaryChoice(text)).toBe(false);
  });
});
