/**
 * Composer verdict — screen-truth answers to "may the factory type here?".
 *
 * Grid lines are transcribed from REAL captures: the P1 corpus
 * (tests/pty-e2e/corpus, replayed through SessionObserver) for claude, codex,
 * grok, pi, and devin; live one-off captures on 2026-08-28 for prime-agent
 * (v0.8.1) and cursor (agent v2026.08.11). The corpus-replay grounding for
 * the same probes lives in tests/pty-e2e/scenarios/composer-verdict.test.ts.
 */
import { describe, expect, it } from "vitest";
import {
  admitUngroundedFirstTypedComposer,
  composerVerdictFor,
  composerVerdictForHarness,
  rulePackFor,
} from "../src/main/vellum-command/term/agent-state";
import type { ObserverGridSnapshot } from "../src/main/vellum-command/term/observer/types";

const snap = (
  partial: Partial<ObserverGridSnapshot> & { lines?: readonly string[] },
): ObserverGridSnapshot => {
  const lines = partial.lines ?? [];
  return {
    cols: partial.cols ?? 120,
    rows: partial.rows ?? 32,
    lines,
    text: lines.join("\n"),
    signals: {
      title: "",
      osc9: "",
      modes: {
        bracketedPaste: false,
        synchronizedOutput: false,
        altScreen: false,
        mouseModes: [],
      },
    },
    seq: 1n,
    epoch: "e1",
    bindingId: "b1",
  };
};

const HR = "─".repeat(40);
const NBSP = "\u00a0";

describe("claude", () => {
  const v = (lines: readonly string[]) =>
    composerVerdictFor(snap({ lines }), rulePackFor("claude"));

  it("bare ❯ box is empty", () => {
    expect(v([HR, "❯ ", HR, "  ⏸ manual mode on"])).toBe("empty");
  });

  it("startup placeholder (NBSP after glyph) is empty", () => {
    // Corpus claude/startup-idle paints ❯<NBSP>Try "fix typecheck errors".
    expect(v([HR, `❯${NBSP}Try "fix typecheck errors"`, HR, "footer"])).toBe(
      "empty",
    );
  });

  it("typed text is a draft", () => {
    expect(v([HR, "❯ hello", HR, "footer"])).toBe("draft");
  });

  it("a paste chip is a draft (never re-paste over it)", () => {
    expect(v([HR, "❯ [Pasted text #1 +40 lines]", HR, "footer"])).toBe(
      "draft",
    );
  });

  it("multi-line draft with a bare-glyph first line is a draft, not empty", () => {
    expect(v([HR, "❯ ", "second draft line", HR, "footer"])).toBe("draft");
  });

  it("permission dialog in the box region is null (unreadable, refuse)", () => {
    expect(
      v([HR, "Do you want to proceed?", "  1. Yes", "  2. No", "Esc to cancel"]),
    ).toBe(null);
  });
});

describe("codex", () => {
  const v = (lines: readonly string[]) =>
    composerVerdictFor(snap({ lines }), rulePackFor("codex"));

  it("known placeholder is empty", () => {
    expect(v(["• Hello.", "", "› Implement {feature}", "", "  gpt-5.4-mini low · repo"])).toBe(
      "empty",
    );
  });

  it("typed text is a draft", () => {
    expect(v(["› hello", "", "  gpt-5.4-mini low · repo"])).toBe("draft");
  });

  it("an unknown rotated placeholder reads as draft (hold, loud) — never empty", () => {
    expect(v(["› Fix {bug} in the auth flow", "", "  footer"])).toBe("draft");
  });
});

describe("grok", () => {
  const v = (lines: readonly string[]) =>
    composerVerdictFor(snap({ lines }), rulePackFor("grok"));

  it("bare ❯ above the model footer is empty", () => {
    expect(v(["minimal · /help", "❯", "Grok 4.5 (low) · 22K / 500K (4%)"])).toBe(
      "empty",
    );
  });

  it("typed text is a draft", () => {
    expect(
      v(["minimal · /help", "❯ hello", "Grok 4.5 (low) · 22K / 500K (4%)"]),
    ).toBe("draft");
  });

  it("draft outranks a stale bare ❯ in the same window", () => {
    expect(v(["❯", "❯ hello", "Grok 4.5 (low) · 22K / 500K (4%)"])).toBe(
      "draft",
    );
  });

  // Full TUI (app launch, live capture 2026-08-28): the composer is a
  // bordered box and the closing │ is chrome, never draft content.
  it("boxed empty composer (full TUI) is empty", () => {
    expect(
      v([
        " ╭──────────────────────────╮",
        " │ ❯                        │",
        " ╰───────── Grok 4.5 (low) ─╯",
        " Shift+Tab:mode  Ctrl+x:shortcuts",
      ]),
    ).toBe("empty");
  });

  it("boxed typed text (full TUI) is a draft", () => {
    expect(
      v([
        " ╭──────────────────────────╮",
        " │ ❯ hello                  │",
        " ╰───────── Grok 4.5 (low) ─╯",
        " Shift+Tab:mode  Ctrl+x:shortcuts",
      ]),
    ).toBe("draft");
  });
});

describe("pi", () => {
  const v = (lines: readonly string[]) =>
    composerVerdictFor(snap({ lines }), rulePackFor("pi"));

  it("blank editor interior is empty", () => {
    expect(v(["transcript", HR, " ", HR, "cwd", "0.0%/400k (auto)"])).toBe(
      "empty",
    );
  });

  it("typed text in the interior is a draft", () => {
    expect(v(["transcript", HR, "hello", HR, "cwd", "0.0%/400k (auto)"])).toBe(
      "draft",
    );
  });
});

describe("devin", () => {
  const v = (lines: readonly string[]) =>
    composerVerdictFor(snap({ lines }), rulePackFor("devin"));

  it("welcome placeholder is empty", () => {
    expect(
      v([HR, "❭ Ask Devin to build features, fix bugs, or work on your code", HR, "SWE-1.6 Slow"]),
    ).toBe("empty");
  });

  it("typed text is a draft", () => {
    expect(v([HR, "❭ hello", HR, "SWE-1.6 Slow"])).toBe("draft");
  });
});

describe("cursor", () => {
  const v = (lines: readonly string[]) =>
    composerVerdictFor(snap({ lines }), rulePackFor("cursor"));

  it("fresh placeholder is empty", () => {
    expect(v(["  Cursor Agent", "", "  → Plan, search, build anything"])).toBe(
      "empty",
    );
  });

  it("follow-up placeholder is empty", () => {
    expect(v(["transcript", "", "  → Add a follow-up"])).toBe("empty");
  });

  it("a draft starting with the placeholder's own words is a draft", () => {
    // The empty probe must match the placeholder LINE exactly — a real
    // follow-up that happens to start with those words is typed text, and
    // an "empty" verdict here would let the factory type over a live draft.
    expect(
      v(["transcript", "", "  → Add a follow-up remove the unused file"]),
    ).toBe("draft");
  });

  it("typed text is a draft", () => {
    expect(v(["  Cursor Agent", "", "  → hello"])).toBe("draft");
  });
});

describe("prime-agent", () => {
  const v = (lines: readonly string[]) =>
    composerVerdictFor(snap({ lines }), rulePackFor("prime-agent"));

  it("Try-hint placeholder is empty", () => {
    expect(
      v([' >   Try "refactor @<filepath>"', "", "← agents/resume  GPT-5.6 Sol • max"]),
    ).toBe("empty");
  });

  it("typed text is a draft", () => {
    expect(v([" >  hello", "", "← agents/resume  GPT-5.6 Sol • max"])).toBe(
      "draft",
    );
  });
});

describe("fail-closed defaults", () => {
  it("a probe-less pack yields null — factory typing refuses", () => {
    // hermes/kimi/muse/amp/omp carry no probes until their chrome is grounded.
    expect(
      composerVerdictFor(snap({ lines: ["❯ "] }), rulePackFor("hermes")),
    ).toBe(null);
  });

  it("an unknown harness string yields null", () => {
    expect(
      composerVerdictForHarness(snap({ lines: ["❯ "] }), "not-a-harness"),
    ).toBe(null);
  });

  it("an empty screen yields null for a probed harness", () => {
    expect(composerVerdictForHarness(snap({ lines: [] }), "claude")).toBe(null);
  });

  it("ungrounded firstTyped admits a one-shot empty; probed packs stay closed", () => {
    expect(
      admitUngroundedFirstTypedComposer(null, rulePackFor("amp"), true),
    ).toBe("empty");
    expect(
      admitUngroundedFirstTypedComposer(null, rulePackFor("muse"), true),
    ).toBe("empty");
    expect(
      admitUngroundedFirstTypedComposer(null, rulePackFor("amp"), false),
    ).toBe(null);
    expect(
      admitUngroundedFirstTypedComposer(null, rulePackFor("claude"), true),
    ).toBe(null);
    expect(
      admitUngroundedFirstTypedComposer("draft", rulePackFor("amp"), true),
    ).toBe("draft");
  });
});

describe("codex v0.149 (live capture 2026-08-28)", () => {
  const v = (lines: readonly string[]) =>
    composerVerdictFor(snap({ lines }), rulePackFor("codex"));

  it("the current placeholder is empty", () => {
    expect(v(["› Ask Codex to do anything", "", "  ? for shortcuts"])).toBe(
      "empty",
    );
  });
});
