/**
 * Claude Code seat rules — OSC title braille spinner, prompt-box idle, grid permission forms.
 * Patterns from managed-terminal probes + herdr design (rewritten; not vendored).
 */

import type { SeatRulePack } from "../types";

export const claudeRules: SeatRulePack = {
  harness: "claude",
  version: "2026.07.26.1",
  rules: [
    {
      id: "osc_title_working",
      state: "working",
      priority: 1100,
      region: "osc_title",
      visibleWorking: true,
      // Leading braille spinner glyph + space (Claude title churn while working).
      matchers: { regex: ["^[\\u2800-\\u28FF] "] },
    },
    {
      id: "transcript_viewer",
      state: "unknown",
      priority: 1000,
      region: "bottom_non_empty_lines",
      regionN: 3,
      skipStateUpdate: true,
      matchers: {
        contains: ["showing detailed transcript"],
        any: [
          { contains: ["ctrl+o", "to toggle"] },
          { contains: ["ctrl+e", "show all"] },
          { contains: ["ctrl+e", "collapse"] },
          { contains: ["↑↓ scroll"] },
          { contains: ["? for shortcuts"] },
        ],
      },
    },
    // Attention outranks OSC title working (1100): permission chrome must
    // surface even while the title spinner is still spinning.
    {
      id: "live_permission_form",
      state: "attention",
      priority: 1200,
      region: "after_last_horizontal_rule",
      visibleAttention: true,
      matchers: {
        contains: ["enter to select", "esc to cancel"],
        any: [
          { contains: ["tab/arrow keys to navigate"] },
          { contains: ["arrow keys to navigate"] },
          { contains: ["arrows to navigate"] },
          { contains: ["↑/↓ to navigate"] },
          { contains: ["↑↓ to navigate"] },
        ],
      },
    },
    {
      id: "dynamic_workflow_prompt",
      state: "attention",
      priority: 1200,
      region: "whole_recent",
      visibleAttention: true,
      matchers: {
        contains: ["run a dynamic workflow?", "esc to cancel"],
      },
    },
    {
      id: "btw_overlay_working",
      state: "working",
      priority: 975,
      region: "bottom_non_empty_lines",
      regionN: 5,
      visibleWorking: true,
      matchers: {
        lineRegex: ["^\\s*/btw(?:\\s|$)", "(?i)esc to close\\s*$"],
      },
    },
    {
      id: "live_prompt_box",
      state: "idle",
      priority: 950,
      region: "prompt_box_body",
      visibleIdle: true,
      matchers: {
        lineRegex: ["^\\s*❯"],
        not: [
          { contains: ["enter to select"] },
          { contains: ["esc to cancel"] },
          { contains: ["tab/arrow keys"] },
          { contains: ["arrow keys to navigate"] },
          { contains: ["↑/↓ to navigate"] },
        ],
      },
    },
    {
      id: "model_picker_menu",
      state: "unknown",
      priority: 900,
      region: "whole_recent",
      skipStateUpdate: true,
      matchers: {
        contains: ["select model", "enter to set as default", "esc to cancel"],
        not: [
          { contains: ["do you want to proceed?"] },
          { contains: ["enter to select"] },
        ],
      },
    },
    {
      id: "bash_permission_prompt",
      state: "attention",
      priority: 1180,
      region: "whole_recent",
      visibleAttention: true,
      matchers: {
        contains: ["do you want to proceed?"],
        any: [
          { contains: ["bash command"] },
          { contains: ["bash("] },
          { contains: ["contains expansion"] },
          { contains: ["tab to amend"] },
          { contains: ["ctrl+e to explain"] },
        ],
        all: [
          {
            any: [
              { lineRegex: ["(?i)^\\s*❯?\\s*yes\\b"] },
              { lineRegex: ["(?i)^\\s*1\\.\\s*yes\\b"] },
              { lineRegex: ["(?i)^\\s*2\\.\\s*no\\b"] },
            ],
          },
        ],
      },
    },
    {
      id: "generic_permission_prompt",
      state: "attention",
      priority: 1170,
      region: "after_last_horizontal_rule",
      visibleAttention: true,
      matchers: {
        contains: ["do you want to proceed?", "esc to cancel"],
        all: [
          {
            any: [
              { lineRegex: ["(?i)^\\s*❯?\\s*1\\.\\s*yes\\b"] },
              { lineRegex: ["(?i)^\\s*2\\.\\s*yes\\b"] },
              { lineRegex: ["(?i)^\\s*2\\.\\s*no\\b"] },
              { lineRegex: ["(?i)^\\s*3\\.\\s*no\\b"] },
            ],
          },
        ],
      },
    },
    {
      id: "legacy_permission_blocker",
      state: "attention",
      priority: 1150,
      region: "whole_recent",
      visibleAttention: true,
      matchers: {
        any: [
          {
            contains: ["do you want to"],
            any: [{ contains: ["yes"] }, { contains: ["❯"] }],
          },
          {
            contains: ["would you like to"],
            any: [{ contains: ["yes"] }, { contains: ["❯"] }],
          },
          { contains: ["waiting for permission"] },
          { contains: ["do you want to allow this connection?"] },
          { contains: ["tab to amend"] },
          { contains: ["ctrl+e to explain"] },
          { contains: ["do you want to proceed?", "esc to cancel"] },
          { contains: ["review your answers"] },
          { contains: ["skip interview and plan immediately"] },
        ],
        not: [{ regex: ["(?m)^\\s*❯\\s*$"] }],
      },
    },
    {
      id: "osc_title_idle",
      state: "idle",
      priority: 250,
      region: "osc_title",
      visibleIdle: true,
      // Leading ✳ (U+2733) is Claude's idle title mark.
      matchers: { regex: ["^\\u2733 "] },
    },
    {
      // Claude leaves OSC 9;4;3 stuck while permission is open — only 4;0 is idle.
      id: "osc9_idle",
      state: "idle",
      priority: 250,
      region: "osc9",
      matchers: { regex: ["^4;0"] },
    },
  ],
};
