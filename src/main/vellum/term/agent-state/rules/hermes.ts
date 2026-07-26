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
