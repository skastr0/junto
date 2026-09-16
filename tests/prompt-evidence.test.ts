import { describe, expect, it } from "vitest";
import {
  PASTE_CHIP_TEXT,
  promptHasPasteChip,
  promptStillPending,
} from "../src/main/junto/term/drive";

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

  it("ruleless prompt above a footer line is still pending", () => {
    // A status/footer line below the composer must not hide the pending
    // line — the evidence region anchors on the last prompt glyph, not the
    // last non-empty row. (adapter probe: ruleless-prompt-above-footer)
    expect(
      promptStillPending(
        { lines: ["> factory notice", "shortcut footer"] },
        "factory notice",
      ),
    ).toBe(true);
  });

  it("payload head hard-wrapped across box rows is still pending", () => {
    // A >64-char single-line paste wraps inside the box; no row holds the
    // whole head, only the joined rows do.
    // (adapter probe: literal-pending-head-wraps-across-lines)
    const text =
      "A literal factory message that is deliberately longer than sixty four characters.";
    const lines = [
      RULE,
      "❭ " + text.slice(0, 20),
      text.slice(20, 40),
      text.slice(40, 60),
      text.slice(60),
      RULE,
    ];
    expect(promptStillPending({ lines }, text)).toBe(true);
  });

  it("wrapped head survives grid padding and continuation indent", () => {
    // Real grids pad rows to column width and indent wrapped rows under the
    // glyph; the whitespace-squashed join still re-forms the head.
    const text =
      "A literal factory message that is deliberately longer than sixty four characters.";
    const lines = [
      RULE,
      ("❭ " + text.slice(0, 30)).padEnd(48),
      ("  " + text.slice(30, 60)).padEnd(48),
      ("  " + text.slice(60)).padEnd(48),
      RULE,
    ];
    expect(promptStillPending({ lines }, text)).toBe(true);
  });

  it("submitted payload echoed in scrollback is not pending", () => {
    // The ruleless anchor is the LAST prompt glyph; history above it stays
    // out of the region, so a delivered payload does not read as pending.
    expect(
      promptStillPending(
        { lines: ["❯ factory notice", "ack output", ">"] },
        "factory notice",
      ),
    ).toBe(false);
  });

  it("ruleless grid with no glyph falls back to the last non-empty line", () => {
    expect(
      promptStillPending({ lines: ["status", "pending text"] }, "pending text"),
    ).toBe(true);
    expect(
      promptStillPending({ lines: ["pending text", "status"] }, "pending text"),
    ).toBe(false);
  });

  it("Amp rounded composer holds literal text while its footer is outside the pending region", () => {
    const box = ["╭──────── low ─╮", "│ hello       │", "╰─────────────╯"];
    expect(promptStillPending({ lines: box }, "hello")).toBe(true);
    expect(promptStillPending({ lines: box }, "low")).toBe(false);
    expect(promptStillPending({ lines: ["┃ hello", "reply", "╭──────── low ─╮", "│             │", "╰─────────────╯"] }, "hello")).toBe(false);
  });

  it("Amp connected steering remains pending but detached history does not", () => {
    const steering = ["╭──────────────────╮", "│ steering: hello  │"];
    const composer = ["╭┴─────── low ────┴╮", "│                  │", "╰ ∼ Streaming ─────╯"];
    expect(promptStillPending({ lines: [...steering, ...composer] }, "hello")).toBe(true);
    expect(promptStillPending({ lines: [...steering, "╰──────────────────╯", "╭──────── low ─────╮", "│                  │", "╰ ∼ Streaming ─────╯"] }, "hello")).toBe(false);
  });

  it("Amp narrow boxed rows preserve a wrapped literal head without treating side walls as payload", () => {
    const text = "A literal factory message longer than sixty four characters wraps inside a narrow composer.";
    const rows = Array.from({ length: Math.ceil(text.length / 22) }, (_, index) => `│ ${text.slice(index * 22, (index + 1) * 22).padEnd(22)} │`);
    expect(promptStillPending({ lines: ["╭───────────────── low ─╮", ...rows, "╰───────────────────────╯"] }, text)).toBe(true);
    expect(promptStillPending({ lines: [...rows, "╭───────────────── low ─╮", "│                       │", "╰───────────────────────╯"] }, text)).toBe(false);
  });
});
