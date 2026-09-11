/**
 * Prime Agent seat rules — grid/OSC net. The built-in socket reporter is
 * the real feed (idle/working/blocked + session id); this pack covers the
 * screen fallback only: OSC 9;4;3 progress (working), OSC 0 static title
 * (idle), ◇◈◆◈ in-place tool markers (working), the "Working..." manifest
 * literal, and centered overlay selectors (attention). Alt screen is on — grid
 * snapshots see the alt buffer, not scrollback. The footer is intentionally
 * empty (no token/model line to sniff). OSC 133 A/B/C zones wrap message
 * blocks but the region vocabulary has no osc133 slice — OSC 9 + grid carry
 * the pack.
 * Patterns from the 2026-08 agent-CLI sweep of prime-agent
 * (rewritten; not vendored).
 */

import type { SeatRulePack } from "../types";

export const primeAgentRules: SeatRulePack = {
  harness: "prime-agent",
  version: "2026.08.07.2",
  rules: [
    // OSC 9;4;3 (indeterminate) while a turn streams; cleared 4;0 on
    // agent_end / compaction_end / exit.
    {
      id: "osc9_working",
      state: "working",
      priority: 1150,
      region: "osc9",
      visibleWorking: true,
      matchers: { regex: ["^4;3"] },
    },
    // Centered overlay selectors (login / permission / confirm dialogs,
    // model + settings selectors) = attention moments. Overlay screen text is
    // unverified in the sweep; "permission" chrome plus a selector hint is the
    // honest net — the socket feed is authoritative when live.
    {
      id: "permission_overlay_attention",
      state: "attention",
      priority: 1100,
      region: "whole_recent",
      visibleAttention: true,
      matchers: {
        contains: ["permission"],
        any: [
          { contains: ["confirm"] },
          { contains: ["cancel"] },
          { contains: ["↑↓"] },
          { contains: ["select"] },
        ],
      },
    },
    // Manifest mirror (pi.toml): "Working..." literal — status strip only.
    // whole_recent would pin working after any prior turn that printed it.
    {
      id: "working_literal",
      state: "working",
      priority: 200,
      region: "bottom_non_empty_lines",
      regionN: 6,
      visibleWorking: true,
      matchers: { contains: ["Working..."] },
    },
    // In-place tool markers animate ◇◈◆◈ at 250 ms while working (status strip).
    {
      id: "tool_marker_working",
      state: "working",
      priority: 150,
      region: "bottom_non_empty_lines",
      regionN: 8,
      visibleWorking: true,
      matchers: { lineRegex: ["[◇◈◆]"] },
    },
    // Static OSC 0 title "π|prime-agent - <sessionName> - <cwdBasename>"
    // (APP_TITLE π by default; prime-agent when a piConfigName is set).
    // Below the working rules: the title does not churn while streaming.
    // Raised above tool_marker so an idle title beats leftover diamond glyphs
    // when OSC 9 has cleared (agent_end / 4;0).
    {
      id: "osc_title_idle",
      state: "idle",
      priority: 160,
      region: "osc_title",
      visibleIdle: true,
      matchers: { regex: ["^π - |^pi - |^prime-agent - "] },
    },
    // OSC 9 cleared → idle (agent_end / compaction_end / exit).
    {
      id: "osc9_idle",
      state: "idle",
      priority: 100,
      region: "osc9",
      visibleIdle: true,
      matchers: { regex: ["^4;0"] },
    },
  ],
  // Composer probes — grounded in a live capture of prime-agent v0.8.1
  // (2026-08-28): the composer is a bare `>` line above the shortcut footer;
  // empty shows `>   Try "refactor @<filepath>"`, a draft replaces it
  // (`>  hello`). No ─── rule box, so probes scope to the bottom strip.
  composer: [
    {
      id: "placeholder_hint_empty",
      verdict: "empty",
      region: "bottom_non_empty_lines",
      regionN: 2,
      matchers: { lineRegex: ["^\\s*>\\s+Try \"[^\\n]*\"\\s*$"] },
    },
    {
      id: "bare_prompt_empty",
      verdict: "empty",
      region: "bottom_non_empty_lines",
      regionN: 2,
      matchers: { lineRegex: ["^\\s*>\\s*$"] },
    },
    {
      id: "composer_content_draft",
      verdict: "draft",
      region: "bottom_non_empty_lines",
      regionN: 2,
      matchers: { lineRegex: ["^\\s*>\\s+\\S"] },
    },
  ],
};
