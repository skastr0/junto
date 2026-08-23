/**
 * Antigravity CLI (`agy`) seat rules.
 *
 * Screen rules for permission prompts, modal actions, braille/spinner working state,
 * and background tasks.
 */

import type { SeatRulePack } from "../types";

export const agyRules: SeatRulePack = {
  harness: "agy",
  version: "2026.08.23.1",
  rules: [
    {
      id: "modal_allow_action",
      state: "attention",
      priority: 310,
      region: "whole_recent",
      visibleAttention: true,
      matchers: {
        any: [
          { contains: ["Apply this change"] },
          { contains: ["Allow execution"] },
          { contains: ["Approve/reject"] },
          { contains: ["Your answer:"] },
        ],
      },
    },
    {
      id: "permission_prompt",
      state: "attention",
      priority: 300,
      region: "whole_recent",
      visibleAttention: true,
      matchers: {
        contains: ["requesting permission for:"],
        any: [
          { contains: ["do you want to proceed?"] },
          { contains: ["tab amend"] },
          { contains: ["edit command"] },
        ],
      },
    },
    {
      id: "spinner_working",
      state: "working",
      priority: 100,
      region: "whole_recent",
      visibleWorking: true,
      matchers: {
        any: [
          { regex: ["^\\s*[\\u2800-\\u28FF]+\\s+\\p{Alphabetic}+\\w*ing\\b"] },
          { contains: ["esc to cancel"] },
        ],
      },
    },
    {
      /**
       * Live activity line above the footer rule:
       *   `● Agent(self)  Read TerminalSurface session load logic · 4m30s`
       * Present for both self-work and subagent turns; absent when idle.
       */
      id: "activity_line_working",
      state: "working",
      priority: 95,
      region: "bottom_non_empty_lines",
      regionN: 8,
      visibleWorking: true,
      matchers: {
        lineRegex: [
          "\\u25CF\\s+Agent\\([^)]*\\).*\\u00B7\\s*(?:\\d+h)?(?:\\d+m)?\\d+s\\s*$",
        ],
      },
    },
    {
      /**
       * Footer subagent counter: `Gemini 3.7 Flash · high · 1 subagent(s)`.
       * The counter is dropped entirely when no subagent is running, so any
       * non-zero count means the seat is working even if the activity line
       * scrolled out of the region.
       */
      id: "subagents_working",
      state: "working",
      priority: 94,
      region: "bottom_non_empty_lines",
      regionN: 8,
      visibleWorking: true,
      matchers: {
        lineRegex: ["[1-9][0-9]*\\s+[Ss]ubagent"],
      },
    },
    {
      id: "background_tasks_working",
      state: "working",
      priority: 90,
      region: "bottom_non_empty_lines",
      regionN: 5,
      visibleWorking: true,
      matchers: {
        any: [
          { regex: [",\\s*[1-9][0-9]*\\s+[Tt][Aa][Ss][Kk]"] },
          { regex: ["\\u00B7\\s*[1-9][0-9]*\\s+[Tt][Aa][Ss][Kk]"] },
        ],
      },
    },
  ],
};
