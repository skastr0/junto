/**
 * Muse seat rules.
 *
 * Composer + idle chrome grounded in P1 corpus muse/* captured 2026-09-14
 * from Muse Code 1.2.1-R2847.1 (`--provider echo`). Live glyph is U+276F
 * `❯` between a "Voice input" header and a ─── footer rule; 2026-08 probes
 * recorded U+27E9 `⟩`, kept as an alternate. Permission dialogs were not
 * observed — unmatched screens stay composer-null (refuse).
 */

import type { SeatRulePack } from "../types";

const MUSE_GLYPH = "[\u276f\u27e9]";

export const museRules: SeatRulePack = {
  harness: "muse",
  version: "2026.09.14.2",
  rules: [
    {
      id: "live_status_working",
      state: "working",
      priority: 110,
      region: "bottom_non_empty_lines",
      regionN: 6,
      visibleWorking: true,
      // P1 type-echo paints Thinking before the OSC spinner. This live
      // status sits immediately above the Voice input header, outside the
      // four-line composer strip; a transcript status elsewhere is not it.
      matchers: {
        regex: ["(?:^|\\n)\\s*[◇◆◈]\\s+(?:Thinking|Working)[^\\n]*\\n\\s*── Voice input\\b"],
      },
    },
    {
      id: "osc_title_working",
      state: "working",
      priority: 100,
      region: "osc_title",
      visibleWorking: true,
      // Real muse working-turn capture: the OSC title animates braille
      // spinner frames ("⠙ muse", ⠋⠙⠹⠸⠼ muse) while working.
      matchers: {
        regex: ["[\u2800-\u28FF]"],
      },
    },
    {
      id: "composer_draft_idle",
      state: "idle",
      priority: 90,
      region: "bottom_non_empty_lines",
      regionN: 4,
      visibleIdle: true,
      // Typed/pasted composer (`❯ hello`, `❯ PASTE_LINE_00`). `esc to
      // interrupt` is mid-turn chrome on the same strip after CR.
      matchers: {
        lineRegex: [`^\\s*${MUSE_GLYPH}\\s+\\S`],
        not: [{ contains: ["esc to interrupt"] }],
      },
    },
    {
      id: "bare_composer_idle",
      state: "idle",
      priority: 80,
      region: "bottom_non_empty_lines",
      regionN: 4,
      visibleIdle: true,
      matchers: {
        lineRegex: [`^\\s*${MUSE_GLYPH}\\s*$`],
        not: [
          { lineRegex: [`^\\s*${MUSE_GLYPH}\\s+\\S`] },
          { contains: ["esc to interrupt"] },
        ],
      },
    },
  ],
  composer: [
    {
      id: "composer_content_draft",
      verdict: "draft",
      region: "bottom_non_empty_lines",
      regionN: 4,
      matchers: {
        lineRegex: [`^\\s*${MUSE_GLYPH}\\s+\\S`],
        not: [{ contains: ["esc to interrupt"] }],
      },
    },
    {
      id: "bare_prompt_empty",
      verdict: "empty",
      region: "bottom_non_empty_lines",
      regionN: 4,
      matchers: {
        lineRegex: [`^\\s*${MUSE_GLYPH}\\s*$`],
        not: [{ lineRegex: [`^\\s*${MUSE_GLYPH}\\s+\\S`] }],
      },
    },
  ],
};
