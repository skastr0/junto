/**
 * Antigravity CLI (`agy`) seat rules.
 *
 * Screen rules for permission prompts, modal actions, braille/spinner working state,
 * and background tasks.
 */

import type { SeatRulePack } from "../types";

export const agyRules: SeatRulePack = {
  harness: "agy",
  version: "2026.08.17.1",
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
