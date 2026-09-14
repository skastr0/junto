/**
 * Antigravity CLI (`agy`) seat rules.
 *
 * Screen rules for permission prompts, modal actions, braille/spinner working state,
 * and background tasks.
 *
 * Permission-prompt copy since 1.1.28 names the action (`Run this command?`,
 * `Allow access to this URL?`, `Allow calling this tool?`) plus an optional
 * `Reason:` line. The older `requesting permission for:` / `do you want to
 * proceed?` form is still matched.
 */

import type { SeatRulePack } from "../types";

/** 1.1.28+ action titles — also used as idle/composer exclusions. */
const AGY_PERMISSION_TITLES = [
  { contains: ["run this command?"] },
  { contains: ["allow access to this url?"] },
  { contains: ["allow calling this tool?"] },
] as const;

export const agyRules: SeatRulePack = {
  harness: "agy",
  version: "2026.09.11.1",
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
        any: [
          ...AGY_PERMISSION_TITLES,
          {
            contains: ["requesting permission for:"],
            any: [
              { contains: ["do you want to proceed?"] },
              { contains: ["tab amend"] },
              { contains: ["edit command"] },
            ],
          },
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
          // lineRegex: `regex` tests the whole joined region, where a
          // line-start anchor can only see the first row — a spinner below
          // prior output never matched and live turns read idle.
          { lineRegex: ["^\\s*[\\u2800-\\u28FF]+\\s+\\p{Alphabetic}+\\w*ing\\b"] },
          { contains: ["esc to cancel"] },
        ],
      },
    },
    {
      /**
       * Live activity line above the footer rule:
       *   `● Agent(self)  Read TerminalSurface session load logic - 4m30s`
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
       * Footer subagent counter: `Gemini 3.7 Flash - high - 1 subagent(s)`.
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
      /**
       * Empty composer between the last two ─── rules is Antigravity's idle
       * chrome. Without a positive idle rule the seat only ever reached
       * `fallback:idle` (low confidence), which `isSeatIdle` fails closed on —
       * so factory mail nudges were deferred forever as "not-idle".
       * Priority sits below every working rule (90+) and every attention rule
       * (300+): a live activity line, subagent counter or modal still wins.
       */
      id: "empty_prompt_idle",
      state: "idle",
      priority: 80,
      region: "prompt_box_body",
      visibleIdle: true,
      matchers: {
        lineRegex: ["^\\s*[❯>]\\s*$"],
        not: [
          { contains: ["esc to cancel"] },
          { contains: ["do you want to proceed?"] },
          { contains: ["your answer:"] },
          ...AGY_PERMISSION_TITLES,
        ],
      },
    },
    {
      /** Draft text sitting in the composer is still an idle seat. */
      id: "composer_draft_idle",
      state: "idle",
      priority: 70,
      region: "prompt_box_body",
      visibleIdle: true,
      matchers: {
        lineRegex: ["^\\s*[❯>]\\s+\\S"],
        not: [
          { contains: ["esc to cancel"] },
          { contains: ["do you want to proceed?"] },
          { contains: ["your answer:"] },
          ...AGY_PERMISSION_TITLES,
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
  // Composer probes — lifted from this pack's grounded idle rules (empty
  // `[\u276f>]` box, drafted `[\u276f>] text`). Whole-region regexes so a
  // bare-glyph first line never proves empty over a multi-line draft.
  composer: [
    {
      id: "bare_prompt_empty",
      verdict: "empty",
      region: "prompt_box_body",
      matchers: {
        regex: ["^\\s*[\u276f>]\\s*$"],
        not: [
          { contains: ["esc to cancel"] },
          { contains: ["do you want to proceed?"] },
          { contains: ["your answer:"] },
          ...AGY_PERMISSION_TITLES,
        ],
      },
    },
    {
      id: "composer_content_draft",
      verdict: "draft",
      region: "prompt_box_body",
      matchers: { regex: ["^\\s*[\u276f>]"] },
    },
  ],
};
