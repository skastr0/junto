/**
 * fx seat rules.
 *
 * Written from a live PTY capture of fx 0.0.6, and the capture refuted the
 * expectation it was written against: the OSC title is NOT a state machine. It
 * reads `fx <sep> <session title> <sep> <model>`, where the middle segment is
 * the workspace name until the first turn names the session — so a working
 * frame and a settled frame carry the SAME title, and keying state off it would
 * pin a finished seat to whatever it last looked like.
 *
 * What actually separates the states is the status line in the body:
 *
 *   idle      `┃`                              (empty composer, footer below)
 *   working   `• Thinking (2s) (↑13 ↓0)`       (bullet + live elapsed)
 *   settled   `  5s (↑13 ↓4)`                  (same meter, no bullet)
 *
 * The `(↑N ↓N)` token meter therefore proves nothing on its own: it survives
 * into the settled frame. The bullet plus a status word is the signal.
 *
 * Separators in fx chrome are U+00B7; rule sources spell them as the escape
 * rather than pasting the glyph, per the repo's copy law.
 */

import type { SeatRulePack } from "../types";

export const fxRules: SeatRulePack = {
  harness: "fx",
  version: "2026.08.26.1",
  rules: [
    {
      /**
       * Tool-permission dialog. The literals come from the shipped binary's own
       * strings ("Allow once", "Allow for this session", "Reject"); both halves
       * must be present, because a dialog offers a choice and prose does not.
       */
      id: "permission_dialog_attention",
      state: "attention",
      priority: 1300,
      region: "whole_recent",
      visibleAttention: true,
      matchers: {
        any: [
          { contains: ["allow once", "reject"] },
          { contains: ["allow for this session", "reject"] },
          { contains: ["allow this mcp tool call?"] },
        ],
      },
    },
    {
      /**
       * Live turn: a bullet, a status word, and an elapsed timer that ticks.
       * Anchored on the bullet so the settled frame's bare `5s (↑13 ↓4)` — same
       * meter, no bullet — cannot read as working.
       */
      id: "status_line_working",
      state: "working",
      priority: 1100,
      region: "bottom_non_empty_lines",
      regionN: 6,
      visibleWorking: true,
      matchers: {
        lineRegex: [
          "^\\s*\\u2022\\s+(?:Thinking|Working|Running|Reading|Streaming)\\b",
        ],
      },
    },
    {
      /** fx's own interrupt hint, shown while a turn can still be cancelled. */
      id: "cancel_hint_working",
      state: "working",
      priority: 1050,
      region: "bottom_non_empty_lines",
      regionN: 4,
      visibleWorking: true,
      matchers: { contains: ["esc to cancel"] },
    },
    {
      /**
       * Settled: the composer is an empty `┃` and the footer carries
       * `<permission mode> U+00B7 <model>`. Both together, because the
       * footer alone is painted during a turn as well.
       */
      id: "empty_composer_idle",
      state: "idle",
      priority: 1000,
      region: "bottom_non_empty_lines",
      regionN: 4,
      visibleIdle: true,
      matchers: {
        all: [
          { lineRegex: ["^\\s*\\u2503\\s*$"] },
          { lineRegex: ["^\\s*\\S+\\s+\\u00B7\\s+\\S+\\s*$"] },
        ],
        not: [
          {
            lineRegex: [
              "^\\s*\\u2022\\s+(?:Thinking|Working|Running|Reading|Streaming)\\b",
            ],
          },
          { contains: ["esc to cancel"] },
        ],
      },
    },
    {
      /** A draft in the composer is still an idle seat, not a working one. */
      id: "composer_draft_idle",
      state: "idle",
      priority: 900,
      region: "bottom_non_empty_lines",
      regionN: 4,
      visibleIdle: true,
      matchers: {
        all: [
          { lineRegex: ["^\\s*\\u2503\\s+\\S"] },
          { lineRegex: ["^\\s*\\S+\\s+\\u00B7\\s+\\S+\\s*$"] },
        ],
        not: [
          {
            lineRegex: [
              "^\\s*\\u2022\\s+(?:Thinking|Working|Running|Reading|Streaming)\\b",
            ],
          },
          { contains: ["esc to cancel"] },
        ],
      },
    },
  ],
};
