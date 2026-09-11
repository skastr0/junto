import { describe, expect, it } from "vitest";
import {
  deriveInjectionSignal,
  deriveInteraction,
  deriveTurnSignal,
  deriveUserSignal,
  extractPromptBoxText,
  promptRegionLines,
  scanMarker,
  type InteractionDerived,
} from "../src/main/vellum-command/term/observer/interaction";

const HR = "────────────────";

const NOW = 1_000_000;

describe("scanMarker", () => {
  it("none: marker absent and never delivered", () => {
    expect(scanMarker(["output line", "❯ hello"], "[vc-abc]", false)).toBe(
      "none",
    );
    expect(scanMarker([], "[vc-abc]", false)).toBe("none");
  });

  it("prompt: marker inside the prompt box (two rules)", () => {
    const lines = [
      "history",
      HR,
      "❯ [vc-abc] run the deploy",
      HR,
      "footer",
    ];
    expect(scanMarker(lines, "[vc-abc]", false)).toBe("prompt");
  });

  it("prompt: single rule fallback (after last rule)", () => {
    expect(
      scanMarker(["history", HR, "❯ [vc-abc] do it"], "[vc-abc]", false),
    ).toBe("prompt");
  });

  it("prompt: no rules fallback (last non-empty line)", () => {
    expect(scanMarker(["some output", "❯ [vc-abc] do it"], "[vc-abc]", false)).toBe(
      "prompt",
    );
    // Empty token can never be "prompt".
    expect(scanMarker(["❯ [vc-abc]"], "", false)).toBe("none");
  });

  it("output: marker present outside the prompt region", () => {
    const lines = [
      "[vc-abc] deploy complete",
      HR,
      "❯",
      HR,
      "footer",
    ];
    expect(scanMarker(lines, "[vc-abc]", false)).toBe("output");
    // No rules: marker on a non-last line is output.
    expect(
      scanMarker(["[vc-abc] done", "❯ what next"], "[vc-abc]", false),
    ).toBe("output");
  });

  it("cleared: marker absent after a delivery", () => {
    expect(scanMarker(["❯"], "[vc-abc]", true)).toBe("cleared");
    expect(scanMarker([], "[vc-abc]", true)).toBe("cleared");
    expect(scanMarker(["❯"], "", true)).toBe("cleared");
  });
});

describe("extractPromptBoxText", () => {
  it("strips the prompt glyph and joins the box body", () => {
    expect(
      extractPromptBoxText(["a", HR, "❯ hello", "❯ second line", HR, "footer"]),
    ).toBe("hello\nsecond line");
  });

  it("an idle prompt box yields an empty string", () => {
    expect(extractPromptBoxText([HR, "❯", HR])).toBe("");
    expect(extractPromptBoxText(["❯   "])).toBe("");
    expect(extractPromptBoxText([])).toBe("");
  });

  it("keeps injected marker text", () => {
    expect(extractPromptBoxText([HR, "❯ [vc-abc] please run", HR])).toBe(
      "[vc-abc] please run",
    );
  });

  it("no rules: uses the last non-empty line", () => {
    expect(extractPromptBoxText(["out", "❯ draft here"])).toBe("draft here");
  });
});

describe("deriveUserSignal", () => {
  it("present: recent input wins over box content", () => {
    expect(
      deriveUserSignal("[vc-abc] text", "[vc-abc]", NOW - 2_000, NOW),
    ).toBe("present");
    // Exactly at the window edge is still present.
    expect(deriveUserSignal("", undefined, NOW - 10_000, NOW)).toBe("present");
    // Just past the window is not present.
    expect(deriveUserSignal("", undefined, NOW - 10_001, NOW)).toBe("absent");
  });

  it("drafted: non-empty box without our marker", () => {
    expect(deriveUserSignal("fix the bug", "[vc-abc]", undefined, NOW)).toBe(
      "drafted",
    );
    expect(deriveUserSignal("fix the bug", undefined, NOW - 60_000, NOW)).toBe(
      "drafted",
    );
  });

  it("submitted: our marker sits in the prompt box, agent has not submitted", () => {
    expect(
      deriveUserSignal("[vc-abc] run the deploy", "[vc-abc]", NOW - 60_000, NOW),
    ).toBe("submitted");
  });

  it("absent: empty box and no recent input", () => {
    expect(deriveUserSignal("", "[vc-abc]", undefined, NOW)).toBe("absent");
    expect(deriveUserSignal("  ", "[vc-abc]", NOW - 60_000, NOW)).toBe("absent");
    expect(deriveUserSignal("", undefined, NOW - 60_000, NOW)).toBe("absent");
  });
});

describe("deriveInjectionSignal", () => {
  it("maps the four marker scans", () => {
    expect(deriveInjectionSignal("none", false)).toBe("none");
    expect(deriveInjectionSignal("prompt", true)).toBe("live");
    expect(deriveInjectionSignal("output", true)).toBe("in-flight");
    expect(deriveInjectionSignal("cleared", true)).toBe("consumed");
  });

  it("hadDelivery is a cross-check, not an input to the mapping", () => {
    expect(deriveInjectionSignal("prompt", false)).toBe("live");
    expect(deriveInjectionSignal("cleared", false)).toBe("consumed");
  });
});

describe("deriveTurnSignal", () => {
  it("in-turn while the seat is working or attention", () => {
    expect(deriveTurnSignal("working", "prompt", undefined, NOW)).toBe("in-turn");
    expect(deriveTurnSignal("attention", "cleared", NOW - 1, NOW)).toBe(
      "in-turn",
    );
  });

  it("ended: idle + cleared marker", () => {
    expect(deriveTurnSignal("idle", "cleared", undefined, NOW)).toBe("ended");
  });

  it("ended: idle + output within the quiet window", () => {
    expect(deriveTurnSignal("idle", "prompt", NOW - 1, NOW)).toBe("ended");
    // Exactly at the window edge.
    expect(deriveTurnSignal("idle", "none", NOW - 4_000, NOW)).toBe("ended");
  });

  it("none: idle without cleared marker or recent output", () => {
    expect(deriveTurnSignal("idle", "prompt", undefined, NOW)).toBe("none");
    expect(deriveTurnSignal("idle", "none", NOW - 4_001, NOW)).toBe("none");
    expect(deriveTurnSignal("unknown", "cleared", undefined, NOW)).toBe("none");
    expect(deriveTurnSignal("gone", "cleared", NOW - 1, NOW)).toBe("none");
    expect(deriveTurnSignal("working", "cleared", NOW - 60_000, NOW)).toBe(
      "in-turn",
    );
  });
});

describe("deriveInteraction", () => {
  const box = (body: string): string[] => [HR, body, HR, "footer"];

  it("working seat with marker in box and fresh user input", () => {
    const d: InteractionDerived = deriveInteraction(
      "working",
      box("❯ [vc-abc] please ship"),
      "[vc-abc]",
      true,
      NOW - 1_000,
      NOW - 5_000,
      NOW,
    );
    expect(d).toEqual({
      user: "present",
      injection: "live",
      turn: "in-turn",
      promptBoxHasNonMarkerText: true,
    });
  });

  it("idle seat, nothing delivered, empty box", () => {
    const d = deriveInteraction("idle", box("❯"), undefined, false, undefined, undefined, NOW);
    expect(d).toEqual({
      user: "absent",
      injection: "none",
      turn: "none",
      promptBoxHasNonMarkerText: false,
    });
  });

  it("idle seat, marker consumed, recent output → turn ended", () => {
    const d = deriveInteraction(
      "idle",
      box("❯"),
      "[vc-abc]",
      true,
      undefined,
      NOW - 500,
      NOW,
    );
    expect(d).toEqual({
      user: "absent",
      injection: "consumed",
      turn: "ended",
      promptBoxHasNonMarkerText: false,
    });
  });

  it("operator draft in the box", () => {
    const d = deriveInteraction(
      "idle",
      box("❯ fix the tests"),
      "[vc-abc]",
      false,
      NOW - 60_000,
      undefined,
      NOW,
    );
    expect(d).toEqual({
      user: "drafted",
      injection: "none",
      turn: "none",
      promptBoxHasNonMarkerText: true,
    });
  });

  it("marker-only box is submitted but has no non-marker text", () => {
    const d = deriveInteraction(
      "idle",
      box("❯ [vc-abc]"),
      "[vc-abc]",
      true,
      NOW - 60_000,
      undefined,
      NOW,
    );
    expect(d.user).toBe("submitted");
    expect(d.injection).toBe("live");
    expect(d.promptBoxHasNonMarkerText).toBe(false);
  });
});

describe("promptRegionLines", () => {
  it("two rules → box body; one rule → after it; none → last non-empty", () => {
    expect(promptRegionLines([HR, "❯ x", HR])).toEqual(["❯ x"]);
    expect(promptRegionLines(["a", HR, "❯ x"])).toEqual(["❯ x"]);
    expect(promptRegionLines(["a", "❯ x"])).toEqual(["❯ x"]);
    expect(promptRegionLines(["a", "❯ x", ""])).toEqual(["❯ x", ""]);
  });
});
