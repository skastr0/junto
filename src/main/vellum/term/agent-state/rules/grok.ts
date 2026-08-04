/**
 * Grok Build seat rules — OSC 9;4 binary, Action Required title, footer chips, [stop] status.
 * Startup splash draws braille logos → never key working on bare spinner alone.
 * Hooks/events.jsonl will feed via engine hookState (Phase 3+); screen is fallback.
 */

import type { SeatRulePack } from "../types";

export const grokRules: SeatRulePack = {
  harness: "grok",
  version: "2026.07.26.1",
  rules: [
    {
      id: "osc_title_attention",
      state: "attention",
      priority: 1300,
      region: "osc_title",
      visibleAttention: true,
      matchers: { contains: ["action required"] },
    },
    {
      id: "option_dialog_attention",
      state: "attention",
      priority: 1200,
      region: "whole_recent",
      visibleAttention: true,
      matchers: {
        lineRegex: ["^\\s*┃\\s+[0-9a-z]+\\s+\\([●○]\\)\\s"],
      },
    },
    {
      id: "permission_hints_attention",
      state: "attention",
      priority: 1190,
      region: "bottom_non_empty_lines",
      regionN: 2,
      visibleAttention: true,
      matchers: {
        contains: [":select", "ctrl+o:yolo", "ctrl+c:cancel"],
      },
    },
    {
      id: "question_dialog_hints_attention",
      state: "attention",
      priority: 1185,
      region: "bottom_non_empty_lines",
      regionN: 2,
      visibleAttention: true,
      matchers: {
        contains: ["tab:scrollback", "shift+x:dismiss"],
      },
    },
    {
      id: "permission_scope_selector",
      state: "attention",
      priority: 1180,
      region: "whole_recent",
      visibleAttention: true,
      matchers: {
        contains: ["yes, proceed", "no, reject"],
        any: [
          { contains: ["use ← → to choose permission whitelist scope"] },
          { contains: ["←/→:scope"] },
        ],
      },
    },
    {
      id: "background_work_chip_working",
      state: "working",
      priority: 1170,
      region: "whole_recent",
      visibleWorking: true,
      // Animated chip with non-zero background task count (top chrome).
      matchers: {
        lineRegex: ["[⋅:⸬⁙.-]\\s+[1-9][0-9]*\\s+│"],
      },
    },
    {
      id: "osc9_working",
      state: "working",
      priority: 1150,
      region: "osc9",
      visibleWorking: true,
      matchers: { regex: ["^4;1;-1$"] },
    },
    {
      id: "osc_title_idle",
      state: "idle",
      priority: 1100,
      region: "osc_title",
      visibleIdle: true,
      // Idle titles end with "grok" and carry no braille spinner.
      matchers: {
        regex: ["(?:^| - )grok$"],
        not: [{ regex: ["[\\u2800-\\u28FF]"] }],
      },
    },
    {
      id: "osc_title_working",
      state: "working",
      priority: 1000,
      region: "osc_title",
      visibleWorking: true,
      // After idle titles excluded, any other non-empty title is active.
      matchers: { regex: ["\\S"] },
    },
    {
      id: "osc9_idle",
      state: "idle",
      priority: 950,
      region: "osc9",
      visibleIdle: true,
      matchers: { regex: ["^4;0;0$"] },
    },
    {
      id: "spinner_status_working",
      state: "working",
      priority: 200,
      region: "whole_recent",
      visibleWorking: true,
      // Anchor on [stop] chip — bare braille is the splash logo trap.
      matchers: {
        lineRegex: ["^\\s*[\\u2801-\\u28FF]\\s.*\\[stop\\]\\s*$"],
      },
    },
    {
      id: "esc_cancel_hints_working",
      state: "working",
      priority: 190,
      region: "bottom_non_empty_lines",
      regionN: 2,
      visibleWorking: true,
      matchers: {
        contains: ["esc:cancel", "ctrl+.:shortcuts"],
      },
    },
    {
      id: "waiting_tool_working",
      state: "working",
      priority: 120,
      region: "whole_recent",
      visibleWorking: true,
      matchers: {
        any: [
          {
            all: [
              { contains: ["ctrl+c:cancel", "ctrl+enter:interject"] },
              { contains: ["waiting"] },
            ],
          },
        ],
      },
    },
    {
      id: "prompt_hints_idle",
      state: "idle",
      priority: 100,
      region: "footer_line",
      visibleIdle: true,
      matchers: {
        contains: ["ctrl+.:shortcuts"],
        not: [
          { contains: ["esc:cancel"] },
          { contains: ["ctrl+c:cancel"] },
        ],
      },
    },
  ],
};
