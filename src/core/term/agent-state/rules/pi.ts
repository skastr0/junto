/**
 * Pi seat rules — grid-primary. The OSC 0 title is static ("π - <name> - <cwd>",
 * no spinner) and OSC 9;4 progress is off by default, so the grid carries the
 * pack: working = status line above the editor ("Working" family literal),
 * attention = project-trust selector + inline confirm dialogs, idle = static
 * title with no status line. No alt screen, so the grid includes scrollback —
 * working/attention rules scope to the bottom status area so stale lines
 * cannot pin a state forever. OSC 133 A/B/C zones frame every message
 * (prompt markers) but the region vocabulary has no osc133 slice, and the
 * editor's box is read through prompt_box_body as the region named below.
 * Patterns from the 2026-08 agent-CLI sweep of pi
 * (rewritten; not vendored), re-grounded on pi 1.5.0 on 2026-11-08:
 *
 * - 1.1.0 painted `Working...` as its own status line.
 * - 1.5.0 paints the status INSIDE the editor's top border, spinner first:
 *   `── ⠧ Working ─────`, and the border keeps its label for the whole turn.
 *   So the working rule is a labelled-border line, not a bare literal, and
 *   the idle rule must refuse that labelled line (a footer alone read as idle
 *   mid-turn for six consecutive live samples).
 * - 1.5.0 also paints a queue line above the footer while mail waits:
 *   `↳ Option+Up to edit all queued messages`. A typed notice is queued there
 *   mid-turn and handed to the model at the next tool boundary, so a queued
 *   line is never idle proof: the labelled working border holds the same turn.
 */

import type { SeatRulePack } from "../types";

/** The editor's top border while a turn runs: `── ⠧ Working ───...`. */
const PI_WORKING_BORDER = "^\\s*─{2,}\\s+.*\\bWorking\\b";

export const piRules: SeatRulePack = {
  harness: "pi",
  version: "2026.11.08.2",
  rules: [
    /**
     * Startup. pi paints its editor and title before it can take a submit, and
     * says `Startup is still in progress` when one arrives too early (it keeps
     * the text and starts nothing). Live 2026-11-08: a fresh session's handoff
     * line waited 204 s behind that status. Hold the prior state rather than
     * publish a writeable idle; it clears itself when the status goes.
     */
    {
      id: "startup_hold",
      state: "unknown",
      priority: 1050,
      region: "bottom_non_empty_lines",
      regionN: 10,
      skipStateUpdate: true,
      matchers: { contains: ["Startup is still in progress"] },
    },
    // Startup project-trust selector: "Trust project folder?" + Trust options
    // + "↑↓ navigate - save - cancel" hints (trust-selector chrome).
    {
      id: "trust_selector_attention",
      state: "attention",
      signal: { _tag: "DialogShown", kind: "trust" },
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
      signal: { _tag: "QuestionAsked" },
      priority: 1000,
      region: "bottom_non_empty_lines",
      regionN: 8,
      visibleAttention: true,
      matchers: {
        contains: ["Delete session?"],
        any: [{ contains: ["confirm"] }, { contains: ["cancel"] }],
      },
    },
    // working literal, scoped to the status area above the editor
    // (bottom of screen). Covers 1.1.0's "Working... (esc to interrupt)".
    {
      id: "working_literal",
      state: "working",
      priority: 200,
      region: "bottom_non_empty_lines",
      regionN: 6,
      visibleWorking: true,
      matchers: { contains: ["Working..."] },
    },
    // 1.5.0's status line is the editor's top border with a spinner and label:
    // `── ⠧ Working ───...`. Highest working priority: the border is unique to
    // a live turn, while a scrollback literal is only a word.
    {
      id: "working_border_status",
      state: "working",
      priority: 205,
      region: "bottom_non_empty_lines",
      regionN: 6,
      visibleWorking: true,
      matchers: { lineRegex: [PI_WORKING_BORDER] },
    },
    {
      id: "compacting_status",
      state: "working",
      signal: { _tag: "CompactionStarted", trigger: "unknown" },
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
      signal: { _tag: "Retrying", cause: "unknown" },
      priority: 180,
      region: "bottom_non_empty_lines",
      regionN: 6,
      visibleWorking: true,
      matchers: {
        // Named groups fill the Retrying signal; the optional delay leaves
        // the lines this matches unchanged.
        lineRegex: [
          "^\\s*[Rr]etrying\\s*\\((?<attempt>\\d+)\\s*/\\s*(?<max>\\d+)\\)\\s+in(?:\\s+(?<retryInMs>\\d+(?:\\.\\d+)?\\s*(?:ms|s|m)\\b))?",
        ],
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
    // forked dists). Below live status-line working rules (200–170): the title
    // does not churn while streaming. When the status strip is clean, the
    // static title is the idle proof — raise above residual footer noise that
    // is not a Working.../Compacting line.
    // A title alone is not idle proof: pi keeps its static title while it is
    // still starting, and says `Startup is still in progress` when it refuses
    // a submit made too early. That screen is not a settled seat.
    {
      id: "osc_title_idle",
      state: "idle",
      priority: 150,
      region: "osc_title",
      visibleIdle: true,
      matchers: { regex: ["^π - |^pi - "], not: [{ contains: ["Startup is still in progress"] }] },
    },
    // Positive idle chrome: editor caret / empty prompt at bottom without a
    // live "Working..." status. Covers the common idle surface when thinking
    // blocks remain expanded in scrollback but the agent is waiting for input.
    {
      id: "editor_prompt_idle",
      state: "idle",
      priority: 160,
      region: "bottom_non_empty_lines",
      regionN: 4,
      visibleIdle: true,
      matchers: {
        // Footer model/context line is always present when the editor is live.
        any: [
          { contains: ["context"] },
          { lineRegex: ["\\d+(\\.\\d+)?%"] },
          { contains: ["tokens"] },
        ],
        // Refuse if a live working status is still in the same strip.
        not: [
          { contains: ["Working..."] },
          { lineRegex: [PI_WORKING_BORDER] },
          { contains: ["Startup is still in progress"] },
          { contains: ["Compacting context..."] },
          { contains: ["Summarizing branch..."] },
          { lineRegex: ["^\\s*[Rr]etrying\\s*\\("] },
        ],
      },
    },
  ],
  // Composer probes — grounded in P1 corpus pi/startup-idle (blank editor
  // interior between the last two ─── rules) and pi/type-echo (typed text in
  // that interior), and re-grounded on pi 1.5.0 (2026-11-08). The editor
  // borders render as full-width rules in the grid, so prompt_box_body IS the
  // editor interior — but only once a labelled status border counts as a
  // border: with the turn running the interior is `── ⠧ Working ───` /
  // blank / `────`, and reading it by bare rules alone fell through to the
  // cwd and footer lines below the box, so a working seat read as "draft".
  // Draft first: any visible content in the interior refuses typing; a blank
  // interior on a pre-editor screen is harmless because the paste gate also
  // requires the seat idle, which needs the editor footer on screen.
  composer: [
    {
      id: "editor_content_draft",
      verdict: "draft",
      region: "prompt_box_body",
      matchers: { regex: ["\\S"] },
    },
    {
      id: "editor_blank_empty",
      verdict: "empty",
      region: "prompt_box_body",
      matchers: { regex: ["^\\s*$"] },
    },
  ],
};
