/**
 * Hermes seat rules — thin screen net; hooks are authoritative when live.
 * Attention: OSC title ⚠; dangerous-command approval form on grid.
 */

import type { SeatRulePack } from "../types";

export const hermesRules: SeatRulePack = {
  harness: "hermes",
  version: "2026.07.26.1",
  rules: [
    {
      id: "osc_title_attention",
      state: "attention",
      priority: 400,
      region: "osc_title",
      visibleAttention: true,
      // Plan §9: OSC title ⚠ → attention.
      matchers: {
        any: [
          { contains: ["⚠"] },
          { contains: ["\u26A0"] },
          { regex: ["\\u26A0|⚠"] },
        ],
      },
    },
    {
      id: "dangerous_command_approval",
      state: "attention",
      priority: 300,
      region: "whole_recent",
      visibleAttention: true,
      matchers: {
        any: [
          { contains: ["dangerous command"] },
          { contains: ["allow once", "allow for this session", "deny"] },
        ],
        all: [
          {
            any: [
              { contains: ["enter to confirm"] },
              { contains: ["↑/↓ to select"] },
              { contains: ["show full command"] },
            ],
          },
        ],
      },
    },
    {
      id: "osc_title_working",
      state: "working",
      priority: 250,
      region: "osc_title",
      visibleWorking: true,
      // Real hermes working-turn capture: the OSC title flips to a ⏳ prefix
      // ("⏳ gpt-5.4-mini · ~/Projects" / "⏳ Greeting and Assistance · …")
      // while the agent works; idle titles carry ✓. Working-evidence only —
      // hermes idle intentionally stays fallback-unpasteable (GAP-DRV-6b).
      matchers: { regex: ["^⏳"] },
    },
    {
      id: "grid_forging_working",
      state: "working",
      priority: 240,
      region: "bottom_non_empty_lines",
      regionN: 5,
      visibleWorking: true,
      // Real early-turn capture (working-turn.jsonl, cut 3500): while the
      // agent session is being created the status line reads
      // "─ forging session… │  │ voice off ─ …" in the bottom strip. The
      // ready footer ("─ ready │ …") is the idle chrome and never matches.
      matchers: {
        contains: ["forging session"],
      },
    },
    {
      id: "interrupt_status_working",
      state: "working",
      priority: 100,
      region: "whole_recent",
      visibleWorking: true,
      matchers: {
        any: [
          { contains: ["msg=interrupt"] },
          { contains: ["ctrl+c cancel"] },
        ],
      },
    },
    {
      // Ready footer from hermes TUI probes (thin idle chrome).
      id: "ready_footer_idle",
      state: "idle",
      priority: 50,
      region: "footer_line",
      visibleIdle: true,
      matchers: {
        regex: ["(?i)\\bready\\b"],
        not: [{ contains: ["⚠"] }],
      },
    },
  ],
};
