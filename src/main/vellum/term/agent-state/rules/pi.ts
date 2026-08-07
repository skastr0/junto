/**
 * Pi seat rules — grid-primary. The OSC 0 title is static ("π - <name> - <cwd>",
 * no spinner) and OSC 9;4 progress is off by default, so the grid carries the
 * pack: working = status line above the editor ("Working..." family — herdr
 * literal), attention = project-trust selector + inline confirm dialogs,
 * idle = static title with no status line. No alt screen, so the grid includes
 * scrollback — working/attention rules scope to the bottom status area so
 * stale lines cannot pin a state forever. OSC 133 A/B/C zones frame every
 * message (prompt markers) but the region vocabulary has no osc133 slice and
 * pi's bordered editor is not a ─── rule box, so prompt_box_body is not
 * expressible here.
 * Patterns from docs/research/agent-cli-sweep/pi.md + herdr pi.toml
 * (rewritten; not vendored).
 */

import type { SeatRulePack } from "../types";

export const piRules: SeatRulePack = {
  harness: "pi",
  version: "2026.08.06.1",
  rules: [
    // Startup project-trust selector: "Trust project folder?" + Trust options
    // + "↑↓ navigate - save - cancel" hints (trust-selector chrome).
    {
      id: "trust_selector_attention",
      state: "attention",
      priority: 1100,
      region: "bottom_non_empty_lines",
      regionN: 8,
      visibleAttention: true,
      matchers: {
        contains: ["Trust project folder?"],
        any: [
          { contains: ["↑↓ navigate"] },
          { contains: ["↑/↓ navigate"] },
          { contains: ["save"] },
          { contains: ["cancel"] },
        ],
      },
    },
    // /resume picker: "Delete session?" with confirm/cancel chrome.
    {
      id: "resume_delete_confirm_attention",
      state: "attention",
      priority: 1000,
      region: "bottom_non_empty_lines",
      regionN: 8,
      visibleAttention: true,
      matchers: {
        contains: ["Delete session?"],
        any: [{ contains: ["confirm"] }, { contains: ["cancel"] }],
      },
    },
    // herdr working_literal, scoped to the status area above the editor
    // (bottom of screen). Covers "Working... (esc to interrupt)".
    {
      id: "working_literal",
      state: "working",
      priority: 200,
      region: "bottom_non_empty_lines",
      regionN: 6,
      visibleWorking: true,
      matchers: { contains: ["Working..."] },
    },
    {
      id: "compacting_status",
      state: "working",
      priority: 190,
      region: "bottom_non_empty_lines",
      regionN: 6,
      visibleWorking: true,
      matchers: { contains: ["Compacting context..."] },
    },
    // "Retrying (n/m) in Xs..." retry status line.
    {
      id: "retry_status",
      state: "working",
      priority: 180,
      region: "bottom_non_empty_lines",
      regionN: 6,
      visibleWorking: true,
      matchers: {
        lineRegex: ["^\\s*[Rr]etrying\\s*\\(\\d+\\s*/\\s*\\d+\\)\\s+in"],
      },
    },
    {
      id: "summarizing_status",
      state: "working",
      priority: 170,
      region: "bottom_non_empty_lines",
      regionN: 6,
      visibleWorking: true,
      matchers: { contains: ["Summarizing branch..."] },
    },
    // Static OSC 0 title "π - <sessionName> - <cwdBasename>" ("pi - …" on
    // forked dists). Below every grid working rule: the title does not churn
    // while streaming, so it must never outrank the status line.
    {
      id: "osc_title_idle",
      state: "idle",
      priority: 150,
      region: "osc_title",
      visibleIdle: true,
      matchers: { regex: ["^π - |^pi - "] },
    },
  ],
};
