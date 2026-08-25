/**
 * Grok Build seat rules — OSC 9;4 binary, Action Required title, footer chips, [stop] status.
 * Startup splash draws braille logos → never key working on bare spinner alone.
 * Hooks/events.jsonl will feed via engine hookState (Phase 3+); screen is fallback.
 */

import type { SeatRulePack } from "../types";

export const grokRules: SeatRulePack = {
  harness: "grok",
  version: "2026.08.25.1",
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
      /**
       * Waiting on background work it spawned. Captured live:
       *   `◎ 1 subagent still running · send a message to interrupt`
       * Grok flips its OSC title back to the idle shape while the parent turn
       * waits, so `osc_title_idle` (1100) would publish idle over a seat that
       * is still working. This sits above it and reads the status line, which
       * is the only surface that keeps telling the truth.
       */
      id: "background_wait_working",
      state: "working",
      priority: 1160,
      region: "bottom_non_empty_lines",
      regionN: 5,
      visibleWorking: true,
      // Count-anchored on purpose. Grok's own transcript narrates waiting
      // ("One agent still running - …", seen live inside a ┃ thought block),
      // and a loose phrase match there would pin a finished seat to working
      // and starve it of factory work.
      matchers: {
        lineRegex: [
          "[1-9][0-9]*\\s+(?:subagent|command|task|loop)s?\\s+still\\s+running",
        ],
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
      id: "grid_thinking_working",
      state: "working",
      priority: 1120,
      region: "bottom_non_empty_lines",
      regionN: 3,
      visibleWorking: true,
      // Live stack is status, prompt, model footer. Responding sits on the
      // status line — last-2 missed it. Last-3 still ignores scrollback.
      matchers: {
        lineRegex: [
          "(?:[Tt]hinking|[Rr]esponding|Waiting for response)(?:\\.{1,3}|…)",
        ],
      },
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
