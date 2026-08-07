/**
 * Kimi Code seat rules — grid-primary. The OSC title is static "Kimi Code"
 * (dead — never key on it) and there is no OSC 9 progress, so the grid
 * carries the pack: mirror of herdr kimi.toml (approval + question panels →
 * attention; moon/braille spinners + background-agent line → working) plus
 * the TUI prompt box "> " and status footer "context: 0% (0/1M)" (idle).
 * No alt screen — the grid includes the whole session like codex.
 * Patterns from docs/research/agent-cli-sweep/kimi.md + herdr kimi.toml
 * (rewritten; not vendored; (?i) inline flags are not valid in this runtime,
 * so case-insensitivity is spelled out with character classes).
 */

import type { SeatRulePack } from "../types";

export const kimiRules: SeatRulePack = {
  harness: "kimi",
  version: "2026.08.07.2",
  rules: [
    // "↵ confirm" + a question + " choose" + approve/reject/revise.
    // Bottom-scoped: transcript replay of an old approval must not pin NEEDS INPUT.
    {
      id: "current_approval_panel",
      state: "attention",
      priority: 1200,
      region: "bottom_non_empty_lines",
      regionN: 16,
      visibleAttention: true,
      matchers: {
        contains: ["↵ confirm"],
        any: [
          { contains: ["run this command?"] },
          { contains: ["write this file?"] },
          { contains: ["apply these edits?"] },
          { contains: ["stop this task?"] },
          { contains: ["ready to build with this plan?"] },
          { lineRegex: ["^\\s*▶?\\s*[Aa]pprove .*\\?$"] },
        ],
        all: [
          { contains: [" choose"] },
          {
            any: [
              { contains: ["approve"] },
              { contains: ["reject"] },
              { contains: ["revise"] },
            ],
          },
        ],
      },
    },
    // Question panel: "↑↓ select" + "esc cancel" + "↵ choose/toggle/save".
    {
      id: "question_panel",
      state: "attention",
      priority: 1190,
      region: "bottom_non_empty_lines",
      regionN: 16,
      visibleAttention: true,
      matchers: {
        contains: ["↑↓ select", "esc cancel"],
        lineRegex: ["^\\s*question\\s*$", "^\\s*\\? "],
        any: [
          { contains: ["↵ choose"] },
          { contains: ["↵ toggle"] },
          { contains: ["↵ save"] },
        ],
      },
    },
    // Legacy approval panel: "requesting approval" + "reject" + approve-once
    // chrome + "1/2/3/4 choose" or "↵ confirm".
    {
      id: "legacy_approval_panel",
      state: "attention",
      priority: 1150,
      region: "bottom_non_empty_lines",
      regionN: 16,
      visibleAttention: true,
      matchers: {
        contains: ["requesting approval", "reject"],
        any: [
          { contains: ["approve once"] },
          { contains: ["approve for this session"] },
        ],
        all: [
          {
            any: [
              { contains: ["1/2/3/4 choose"] },
              { contains: ["↵ confirm"] },
            ],
          },
        ],
      },
    },
    // Background subagent status: "kimi… thinking … [N agents running]".
    {
      id: "background_agent_status_working",
      state: "working",
      priority: 200,
      region: "bottom_non_empty_lines",
      regionN: 3,
      visibleWorking: true,
      matchers: {
        lineRegex: [
          "\\bkimi[-\\w.]*\\s+[Tt]hinking\\b.*\\[[1-9][0-9]*\\s+agents?\\s+running\\]",
        ],
      },
    },
    // Moon-phase spinner: a lone 🌕…🌔 line in the live status strip only.
    // Never whole_recent — a prior turn's moon glyph in scrollback would pin
    // working forever after the agent returned to the prompt.
    {
      id: "moon_spinner_working",
      state: "working",
      priority: 190,
      region: "bottom_non_empty_lines",
      regionN: 6,
      visibleWorking: true,
      matchers: {
        lineRegex: ["^\\s*(🌕|🌖|🌗|🌘|🌑|🌒|🌓|🌔)\\s*$"],
      },
    },
    // Braille spinner + thinking.../working.../using (tool status lines).
    // Bottom-scoped for the same scrollback-pin reason as moon_spinner.
    {
      id: "braille_spinner_working",
      state: "working",
      priority: 180,
      region: "bottom_non_empty_lines",
      regionN: 6,
      visibleWorking: true,
      matchers: {
        lineRegex: [
          "^\\s*[\\u2800-\\u28FF]+\\s*([Tt]hinking\\.\\.\\.|[Ww]orking\\.\\.\\.|[Uu]sing )",
        ],
      },
    },
    // Prompt box "> " + status footer "context: 0% (0/1M)" — always-on idle
    // chrome. Below live working rules (bottom-scoped): when the agent is
    // truly idle the status strip has no moon/braille, so this fires cleanly.
    // Keep priority under working so a live spinner in the same strip still wins.
    {
      id: "prompt_footer_idle",
      state: "idle",
      priority: 150,
      region: "bottom_non_empty_lines",
      regionN: 4,
      visibleIdle: true,
      matchers: {
        contains: ["context:"],
        lineRegex: ["^\\s*>"],
      },
    },
  ],
};
