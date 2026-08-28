/**
 * Claude Code seat rules — OSC title braille spinner, prompt-box idle, grid permission forms.
 * Patterns from managed-terminal probes (rewritten; not vendored).
 */

import type { SeatRulePack } from "../types";

export const claudeRules: SeatRulePack = {
  harness: "claude",
  version: "2026.08.11.1",
  rules: [
    {
      id: "osc_title_working",
      state: "working",
      priority: 1100,
      region: "osc_title",
      visibleWorking: true,
      // Leading spinner glyph + space (Claude title churn while working).
      // The glyph FAMILY is version-dependent and has already changed once:
      // 2.1.227 spun braille (⠂ ⠐), 2.1.228 spins half-circles (◐ ◑) and emits
      // no braille at all. Both families are matched, plus the quadrant and
      // clock variants of the same Unicode spinner sets. Do not rely on this
      // list alone — `live_status_line_working` below is the glyph-independent
      // signal that survives the next spinner change.
      matchers: {
        regex: ["^[\\u2800-\\u28FF\\u25D0-\\u25D3\\u25F4-\\u25F7\\u25CB-\\u25CF] "],
      },
    },
    // Glyph-independent working chrome. Claude keeps an EMPTY composer while it
    // works, so `empty_prompt_idle` (1160) would otherwise pin a live turn to
    // idle whenever the title spinner is not recognised — which is exactly what
    // 2.1.228 did by dropping braille. These key on Claude's live status line
    // instead: the elapsed-time form ("Puzzling… (54s, 2.7k tokens)")
    // and the queued-input hint. Both are behaviour, not decoration, and
    // neither appears on an idle screen.
    // NOT keyed on "esc to interrupt": real Claude only prints it mid-turn, but
    // it is version-variable (absent from the 2.1.228 footer) and the scripted
    // TUI paints it as a constant footer, so it cannot separate the two states.
    // Priority sits above both idle prompt-box rules and below every permission
    // rule (1170+); the `not` gate keeps live dialog chrome winning regardless.
    {
      id: "live_status_line_working",
      state: "working",
      priority: 1161,
      region: "bottom_non_empty_lines",
      regionN: 12,
      visibleWorking: true,
      matchers: {
        // "<verb>… (<N>s" — the running form. Deliberately excludes the
        // COMPLETED form ("✻ Sautéed for 2s"): no ellipsis, no parenthesis.
        lineRegex: ["…\\s*\\(\\d+s\\b"],
        not: [
          { contains: ["esc to cancel"] },
          { contains: ["do you want to proceed?"] },
        ],
      },
    },
    {
      id: "queued_input_working",
      state: "working",
      priority: 1163,
      region: "prompt_box_body",
      visibleWorking: true,
      // Claude only offers to edit QUEUED messages while a turn is running.
      matchers: { contains: ["press up to edit queued messages"] },
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
      id: "resume_summary_choice",
      state: "attention",
      priority: 1210,
      region: "whole_recent",
      visibleAttention: true,
      matchers: {
        contains: [
          "resume from summary",
          "resume full session as-is",
          "enter to confirm",
        ],
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
        lineRegex: ["^\\s*/btw(?:\\s|$)", "[Ee][Ss][Cc] to close\\s*$"],
      },
    },
    {
      id: "live_prompt_box",
      state: "idle",
      priority: 950,
      region: "prompt_box_body",
      visibleIdle: true,
      matchers: {
        // Claude Code has used both ❯ (U+276F) and ASCII `>` as the composer
        // glyph across versions — match either so idle is not lost to OSC
        // title "working" while a paste chip sits unsubmitted.
        lineRegex: ["^\\s*[❯>]"],
        not: [
          { contains: ["enter to select"] },
          { contains: ["esc to cancel"] },
          { contains: ["tab/arrow keys"] },
          { contains: ["arrow keys to navigate"] },
          { contains: ["↑/↓ to navigate"] },
        ],
      },
    },
    // EMPTY composer glyph (❯ or > with only whitespace) is Claude's idle
    // chrome. Outranks the stale braille working title (1100) so an empty
    // prompt box never reads "working" off a lagging OSC title (R1 / OBS-18),
    // while live dialog text in the box still blocks it via the not-gates.
    {
      id: "empty_prompt_idle",
      state: "idle",
      priority: 1160,
      region: "prompt_box_body",
      visibleIdle: true,
      matchers: {
        lineRegex: ["^\\s*[❯>]\\s*$"],
        not: [
          { contains: ["enter to select"] },
          { contains: ["esc to cancel"] },
          { contains: ["tab/arrow keys"] },
          { contains: ["arrow keys to navigate"] },
          { contains: ["↑/↓ to navigate"] },
        ],
      },
    },
    // Composer has draft/paste content → idle for chrome, outrank OSC spinner.
    // Prevents "working" dots while `[Pasted text …]` sits in the box.
    {
      id: "composer_draft_idle",
      state: "idle",
      priority: 1150,
      region: "prompt_box_body",
      visibleIdle: true,
      matchers: {
        lineRegex: ["^\\s*[❯>]\\s*\\S"],
        not: [
          { contains: ["enter to select"] },
          { contains: ["esc to cancel"] },
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
      // Live K2 dialog only: the dialog panel renders at the bottom of the
      // grid (same region as live_permission_form). whole_recent let a
      // previous turn's dialog text in the scrollback pin attention over a
      // fresh idle composer (OBS-4/OBS-5a).
      region: "after_last_horizontal_rule",
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
              { lineRegex: ["^\\s*[❯>]?\\s*[Yy]es\\b"] },
              { lineRegex: ["^\\s*1\\.\\s*[Yy]es\\b"] },
              { lineRegex: ["^\\s*2\\.\\s*[Nn]o\\b"] },
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
              { lineRegex: ["^\\s*[❯>]?\\s*1\\.\\s*[Yy]es\\b"] },
              { lineRegex: ["^\\s*2\\.\\s*[Yy]es\\b"] },
              { lineRegex: ["^\\s*2\\.\\s*[Nn]o\\b"] },
              { lineRegex: ["^\\s*3\\.\\s*[Nn]o\\b"] },
            ],
          },
        ],
      },
    },
    {
      id: "legacy_permission_blocker",
      state: "attention",
      priority: 1150,
      // Live dialog chrome only, like live_permission_form: the permission
      // panel is drawn at the bottom of the grid. A stale dialog in the
      // scrollback tail must not pin attention over a live composer.
      region: "after_last_horizontal_rule",
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
        not: [{ lineRegex: ["^\\s*[❯>]\\s*$"] }],
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
      // Deterministic protocol idle (K9): visible so an OSC-9-only idle seat
      // authorizes paste on the rule path (BUG-R3a), matching grok/prime-agent.
      id: "osc9_idle",
      state: "idle",
      priority: 250,
      region: "osc9",
      visibleIdle: true,
      matchers: { regex: ["^4;0"] },
    },
  ],
  // Composer probes — grounded in P1 corpus claude/startup-idle (placeholder
  // `❯ Try "fix typecheck errors"`) and claude/type-echo (draft `❯ hello`,
  // post-turn bare `❯`). The box is the prompt_box_body slice between the
  // last two ─── rules; the whole-region regexes (no `m` flag — ^/$ anchor
  // the full slice) refuse a bare-glyph first line over a multi-line draft.
  // Empties are exact and ordered first; the glyph-anchored draft catch-all
  // also covers our own `[Pasted text #N]` chips. Dialog chrome matches no
  // probe → null → factory typing refuses.
  composer: [
    {
      id: "bare_prompt_empty",
      verdict: "empty",
      region: "prompt_box_body",
      matchers: {
        regex: ["^\\s*[❯>]\\s*$"],
        not: [
          { contains: ["enter to select"] },
          { contains: ["esc to cancel"] },
        ],
      },
    },
    {
      // Fresh-session hint text; dim on screen but plain text in the grid.
      // Separator is \s+ — Claude paints an NBSP (U+00A0) after the glyph.
      id: "placeholder_hint_empty",
      verdict: "empty",
      region: "prompt_box_body",
      matchers: {
        regex: ['^\\s*[❯>]\\s+Try "[^\\n]*"\\s*$'],
        not: [
          { contains: ["enter to select"] },
          { contains: ["esc to cancel"] },
        ],
      },
    },
    {
      id: "composer_content_draft",
      verdict: "draft",
      region: "prompt_box_body",
      matchers: { regex: ["^\\s*[❯>]"] },
    },
  ],
};
