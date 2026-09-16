/**
 * Cursor Agent seat rules — grid-primary (OSC title is static).
 * Patterns from the 2026-08 agent-CLI sweep of cursor
 * (rewritten; not vendored). Alt-screen snapshots already use buffer.active.
 */

import type { SeatRulePack } from "../types";

export const cursorRules: SeatRulePack = {
  harness: "cursor",
  version: "2026.08.28.1",
  rules: [
    {
      id: "write_file_approval",
      state: "attention",
      priority: 1200,
      region: "bottom_non_empty_lines",
      regionN: 8,
      visibleAttention: true,
      matchers: {
        any: [
          { contains: ["write to this file?"] },
          { contains: ["proceed (y)"] },
          { contains: ["reject & propose changes"] },
        ],
      },
    },
    {
      id: "approval_prompt",
      state: "attention",
      priority: 1190,
      region: "whole_recent",
      visibleAttention: true,
      matchers: {
        any: [
          { contains: ["waiting for approval"] },
          { contains: ["run this command?"] },
          { contains: ["run (once) (y)"] },
          { contains: ["run this command outside the sandbox?"] },
        ],
      },
    },
    {
      id: "stop_hint_working",
      state: "working",
      priority: 200,
      region: "bottom_non_empty_lines",
      regionN: 6,
      visibleWorking: true,
      matchers: {
        contains: ["ctrl+c to stop"],
      },
    },
    {
      id: "background_task_status_working",
      state: "working",
      priority: 190,
      region: "bottom_non_empty_lines",
      regionN: 5,
      visibleWorking: true,
      matchers: {
        regex: ["\\b[1-9]\\d*\\s+background tasks\\b"],
      },
    },
    {
      id: "spinner_working",
      state: "working",
      priority: 180,
      region: "bottom_non_empty_lines",
      regionN: 8,
      visibleWorking: true,
      matchers: {
        lineRegex: ["[\\u2800-\\u28FF]"],
      },
    },
    {
      /**
       * Text in the prompt bar is STILL an idle seat. Grounded live
       * (2026-08-28): a factory paste replaces the placeholder, no other
       * idle rule matches, the seat left idle mid paste->CR sequence, the
       * drive refused its own CR, and the notice sat unsubmitted in the bar
       * (write-failed). Same law as claude/agy/fx composer_draft_idle.
       */
      id: "composer_draft_idle",
      state: "idle",
      priority: 110,
      region: "whole_recent",
      visibleIdle: true,
      matchers: {
        lineRegex: ["^\\s*\u2192\\s+\\S"],
        not: [
          { contains: ["ctrl+c to stop"] },
          { contains: ["run this command?"] },
          { contains: ["proceed (y)"] },
        ],
      },
    },
    {
      id: "welcome_idle",
      state: "idle",
      priority: 120,
      region: "bottom_non_empty_lines",
      regionN: 8,
      visibleIdle: true,
      matchers: {
        any: [
          { contains: ["plan, search, build anything"] },
          { contains: ["add a follow-up"] },
        ],
        not: [
          { contains: ["ctrl+c to stop"] },
          { contains: ["run this command?"] },
          { contains: ["proceed (y)"] },
        ],
      },
    },
  ],
  // Composer probes — grounded in a live capture of agent v2026.08.11
  // (2026-08-28): the prompt bar is an `\u2192` line; empty shows the
  // placeholder (`\u2192 Plan, search, build anything` fresh, `\u2192 Add a
  // follow-up` after a turn), a draft replaces it (`\u2192 hello`). Empties
  // first; the draft catch-all also holds on transcript arrows (safe
  // direction — hold, never paste).
  composer: [
    {
      id: "placeholder_fresh_empty",
      verdict: "empty",
      region: "whole_recent",
      matchers: {
        lineRegex: ["^\\s*\u2192 Plan, search, build anything\\s*$"],
        not: [{ contains: ["ctrl+c to stop"] }],
      },
    },
    {
      id: "placeholder_followup_empty",
      verdict: "empty",
      region: "whole_recent",
      matchers: {
        lineRegex: ["^\\s*\u2192 Add a follow-up\\s*$"],
        not: [{ contains: ["ctrl+c to stop"] }],
      },
    },
    {
      id: "composer_content_draft",
      verdict: "draft",
      region: "whole_recent",
      matchers: { lineRegex: ["^\\s*\u2192 .*\\S"] },
    },
  ],
};
