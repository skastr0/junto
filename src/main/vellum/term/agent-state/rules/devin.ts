/**
 * Devin seat rules — grid-primary mirror of herdr devin.toml (7 rules).
 * The OSC title is unreliable (tmux-style; herdr chose grid-only), so no osc
 * rules. Prompt-box marker is the ❭ (U+276D) line; idle = welcome footer or
 * "context:" footer; attention = workspace-trust + permission footers;
 * working = running-tools / guide / tool-read-timeout footers. All rules key
 * on bottom_non_empty_lines exactly like the manifest.
 * Patterns from docs/research/agent-cli-sweep/devin.md + herdr devin.toml
 * (rewritten; not vendored).
 */

import type { SeatRulePack } from "../types";

export const devinRules: SeatRulePack = {
  harness: "devin",
  version: "2026.08.06.1",
  rules: [
    // First-run workspace trust: "do you trust the authors of this
    // directory?" + "with untrusted content." + "yes, trust <dir>".
    {
      id: "workspace_trust_prompt",
      state: "attention",
      priority: 1200,
      region: "bottom_non_empty_lines",
      regionN: 8,
      visibleAttention: true,
      matchers: {
        contains: [
          "do you trust the authors of this directory?",
          "with untrusted content.",
          "yes, trust ",
        ],
      },
    },
    // Permission footer: "approve once" + "select" + "confirm" + "esc cancel".
    {
      id: "permission_prompt",
      state: "attention",
      priority: 1190,
      region: "bottom_non_empty_lines",
      regionN: 8,
      visibleAttention: true,
      matchers: {
        contains: ["approve once", "select", "confirm", "esc cancel"],
      },
    },
    {
      id: "running_tools_footer",
      state: "working",
      priority: 200,
      region: "bottom_non_empty_lines",
      regionN: 8,
      visibleWorking: true,
      matchers: {
        contains: ["running tools", "esc to interrupt"],
        not: [{ contains: ["approve once", "esc cancel"] }],
      },
    },
    {
      id: "guide_while_working",
      state: "working",
      priority: 190,
      region: "bottom_non_empty_lines",
      regionN: 6,
      visibleWorking: true,
      matchers: {
        contains: ["guide devin while it works"],
        not: [{ contains: ["approve once", "esc cancel"] }],
      },
    },
    {
      id: "tool_reading_timeout",
      state: "working",
      priority: 180,
      region: "bottom_non_empty_lines",
      regionN: 8,
      visibleWorking: true,
      matchers: {
        contains: ["reading shell ", "timeout:"],
        not: [{ contains: ["approve once", "esc cancel"] }],
      },
    },
    {
      id: "welcome_prompt_footer",
      state: "idle",
      priority: 120,
      region: "bottom_non_empty_lines",
      regionN: 8,
      visibleIdle: true,
      matchers: {
        contains: ["ask devin to build", "features, fix bugs", "your code"],
        lineRegex: ["^\\s*❭ Ask Devin to build"],
        not: [
          { contains: ["approve once", "esc cancel"] },
          { contains: ["running tools", "esc to interrupt"] },
          { contains: ["guide devin while it works"] },
        ],
      },
    },
    {
      id: "live_prompt_footer",
      state: "idle",
      priority: 100,
      region: "bottom_non_empty_lines",
      regionN: 6,
      visibleIdle: true,
      matchers: {
        contains: ["context:"],
        lineRegex: ["^\\s*❭"],
        not: [
          { contains: ["approve once", "esc cancel"] },
          { contains: ["running tools", "esc to interrupt"] },
          { contains: ["guide devin while it works"] },
        ],
      },
    },
  ],
};
