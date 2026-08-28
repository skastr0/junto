/**
 * Codex seat rules — OSC title is the primary state feed (Action Required, spinner).
 * Startup trust/hooks modals have no title → grid rules. Rank: OSC → grid.
 */

import type { SeatRulePack } from "../types";

/** Braille / spinner glyphs Codex puts in the OSC title while working. */
const CODEX_TITLE_SPINNER =
  "(?:^| )[\\u2800-\\u28FF⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏](?: |$)";

export const codexRules: SeatRulePack = {
  harness: "codex",
  version: "2026.07.26.1",
  rules: [
    {
      id: "osc_title_attention",
      state: "attention",
      priority: 1100,
      region: "osc_title",
      visibleAttention: true,
      matchers: { contains: ["action required"] },
    },
    {
      id: "osc_title_working",
      state: "working",
      priority: 1050,
      region: "osc_title",
      visibleWorking: true,
      matchers: { regex: [CODEX_TITLE_SPINNER] },
    },
    {
      id: "transcript_viewer",
      state: "unknown",
      priority: 1000,
      region: "whole_recent",
      skipStateUpdate: true,
      matchers: {
        contains: ["↑/↓ to scroll", "pgup/pgdn to", "home/end to jump", "q to quit"],
        any: [
          { contains: ["esc to edit prev"] },
          { contains: ["esc/← to edit prev"] },
        ],
      },
    },
    {
      id: "live_strong_attention",
      state: "attention",
      priority: 900,
      region: "whole_recent",
      visibleAttention: true,
      matchers: {
        any: [
          { contains: ["press enter to confirm or esc to cancel"] },
          { contains: ["enter to submit answer"] },
          { contains: ["enter to submit all"] },
          { contains: ["allow command?"] },
          // Startup modals (no OSC title): directory trust + hooks review.
          { contains: ["do you trust the files in this folder"] },
          { contains: ["trust this directory"] },
          // Real codex v0.147.0 directory-trust modal (pre-TUI, blocking):
          // "Do you trust the contents of this directory?" / "Working with
          // untrusted contents comes with higher risk of prompt injection."
          // — captured verbatim (P1 startup-idle fixture).
          { contains: ["do you trust the contents of this directory"] },
          { contains: ["working with untrusted contents"] },
          { contains: ["review the hooks that will run"] },
          { contains: ["hooks will run for this project"] },
        ],
      },
    },
    {
      id: "weak_attention",
      state: "attention",
      priority: 600,
      region: "bottom_non_empty_lines",
      regionN: 8,
      visibleAttention: true,
      // Bottom-scoped: a stale approval modal in the scrollback tail (a
      // previous turn's "Would you like to run…" form) must not pin
      // attention over the live idle composer (GAP-OBS-5b). The live
      // approval form always paints in the bottom strip.
      matchers: {
        any: [
          { contains: ["[y/n]"] },
          { contains: ["yes (y)"] },
          {
            contains: ["do you want to"],
            any: [{ contains: ["yes"] }, { contains: ["❯"] }],
          },
          {
            contains: ["would you like to"],
            any: [{ contains: ["yes"] }, { contains: ["❯"] }],
          },
        ],
      },
    },
    {
      id: "screen_working_fallback",
      state: "working",
      priority: 500,
      region: "bottom_non_empty_lines",
      regionN: 3,
      visibleWorking: true,
      matchers: {
        lineRegex: [
          "^[•◦]\\s+Working \\([^)]*esc to interrupt\\)(?: - .*)?$",
        ],
        not: [{ contains: ["■ conversation interrupted"] }],
      },
    },
    {
      id: "osc_title_idle",
      state: "idle",
      priority: 100,
      region: "osc_title",
      visibleIdle: true,
      // Any non-empty title that is not spinner / Action Required.
      matchers: {
        regex: ["\\S"],
        not: [
          { regex: [CODEX_TITLE_SPINNER] },
          { contains: ["action required"] },
        ],
      },
    },
  ],
  // Composer probes — grounded in P1 corpus codex/startup-idle (placeholder
  // `› Implement {feature}`) and codex/type-echo (draft `› hello`). Codex
  // paints no ─── rule box, so the probes scope to the bottom strip. Empties
  // are EXACT literals ordered first: a rotated placeholder this pack does
  // not know reads as draft and holds delivery loudly (battery check 3 goes
  // red) instead of pasting into unknown chrome.
  composer: [
    {
      id: "bare_prompt_empty",
      verdict: "empty",
      region: "bottom_non_empty_lines",
      regionN: 4,
      matchers: { lineRegex: ["^\\s*\u203a\\s*$"] },
    },
    {
      id: "placeholder_hint_empty",
      verdict: "empty",
      region: "bottom_non_empty_lines",
      regionN: 4,
      matchers: { lineRegex: ["^\\s*\u203a Implement \\{feature\\}\\s*$"] },
    },
    {
      id: "composer_content_draft",
      verdict: "draft",
      region: "bottom_non_empty_lines",
      regionN: 4,
      matchers: { lineRegex: ["^\\s*\u203a\\s+\\S"] },
    },
  ],
};
