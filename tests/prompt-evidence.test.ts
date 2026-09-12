import { describe, expect, it } from "vitest";
import {
  PASTE_CHIP_TEXT,
  promptHasPasteChip,
  promptStillPending,
} from "../src/main/vellum-command/term/drive";

const RULE = "─".repeat(40);

describe("prompt paste-chip evidence", () => {
  it("names the Claude/Devin chip prefix, not a bare [Pasted", () => {
    expect(PASTE_CHIP_TEXT).toBe("[Pasted text");
    expect("[Pasted:40lines]".includes(PASTE_CHIP_TEXT)).toBe(false);
  });

  it("promptHasPasteChip is true only for composer [Pasted text chrome", () => {
    expect(
      promptHasPasteChip({
        lines: [RULE, "❯ [Pasted text #1 +4 lines]", RULE],
      }),
    ).toBe(true);
    expect(
      promptHasPasteChip({
        lines: ["history", "[Pasted:40lines]", "› "],
      }),
    ).toBe(false);
    expect(
      promptHasPasteChip({
        lines: ["› one", "  two"],
      }),
    ).toBe(false);
  });

  it("Grok [Pasted:Nlines] footer is not promptStillPending chip evidence", () => {
    expect(
      promptStillPending(
        { lines: ["old turn", "[Pasted:40lines]", "› "] },
        "one\ntwo",
      ),
    ).toBe(false);
  });

  it("payload head in the no-rules prompt region is still pending", () => {
    // No-rules region is the last non-empty line (Codex bottom prompt).
    expect(promptStillPending({ lines: ["history", "› one"] }, "one\ntwo")).toBe(
      true,
    );
  });
});
