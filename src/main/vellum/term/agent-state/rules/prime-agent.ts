/**
 * Prime Agent seat rules — grid/OSC net. The built-in herdr socket reporter is
 * the real feed (idle/working/blocked + session id); this pack covers the
 * screen fallback only: OSC 9;4;3 progress (working), OSC 0 static title
 * (idle), ◇◈◆◈ in-place tool markers (working), the "Working..." manifest
 * literal, and centered overlay selectors (attention). Alt screen is on — grid
 * snapshots see the alt buffer, not scrollback. The footer is intentionally
 * empty (no token/model line to sniff). OSC 133 A/B/C zones wrap message
 * blocks but the region vocabulary has no osc133 slice — OSC 9 + grid carry
 * the pack.
 * Patterns from docs/research/agent-cli-sweep/prime-agent.md + herdr pi.toml
 * (rewritten; not vendored).
 */

import type { SeatRulePack } from "../types";

export const primeAgentRules: SeatRulePack = {
  harness: "prime-agent",
  version: "2026.08.06.1",
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
    // Manifest mirror (pi.toml): "Working..." literal (agents-view list).
    {
      id: "working_literal",
      state: "working",
      priority: 200,
      region: "whole_recent",
      visibleWorking: true,
      matchers: { contains: ["Working..."] },
    },
    // In-place tool markers animate ◇◈◆◈ at 250 ms while working.
    {
      id: "tool_marker_working",
      state: "working",
      priority: 150,
      region: "whole_recent",
      visibleWorking: true,
      matchers: { lineRegex: ["[◇◈◆]"] },
    },
    // Static OSC 0 title "π|prime-agent - <sessionName> - <cwdBasename>"
    // (APP_TITLE π by default; prime-agent when a piConfigName is set).
    // Below the working rules: the title does not churn while streaming.
    {
      id: "osc_title_idle",
      state: "idle",
      priority: 120,
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
};
