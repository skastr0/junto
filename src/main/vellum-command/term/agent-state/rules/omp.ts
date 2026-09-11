/**
 * Oh My Pi (`omp`) seat rules.
 *
 * Written from a live PTY capture of omp 18.0.9. Unlike some harnesses here,
 *
 * NO COMPOSER PROBES YET: this harness's composer chrome is not grounded in a
 * capture on this machine, so composerVerdictFor returns null and factory
 * typing into its seats REFUSES (composer-unreadable attention). Ground the
 * real empty/draft chrome and add `composer` probes before shipping it.
 * omp's OSC title IS a state machine, and the body agrees with it:
 *
 *   idle      title `π > omp-probe`          status bar, no Working line
 *   working   title `π <braille> omp-probe`  body ` <braille> Working… <esc>`
 *   settled   title `π > Reply with PONG`    the title becomes the generated
 *                                            session name, still `>`-marked
 *
 * So the marker after `π ` is the signal: a braille frame means a turn is
 * running, `>` means the seat is waiting. Both the title and the body line are
 * matched, because either alone would be a single point of failure and they
 * cost nothing together.
 *
 * The status bar is always present (`… U+00B7 GLM-5.3-Flash (2x usage)
 * U+00B7 high U+00B7 …`) and therefore proves nothing about state on its
 * own. Its separators are U+00B7; rule sources spell them as the escape
 * rather than pasting the glyph, per the repo's copy law.
 */

import type { SeatRulePack } from "../types";

export const ompRules: SeatRulePack = {
  harness: "omp",
  version: "2026.08.28.1",
  rules: [
    {
      /**
       * Tool-approval dialog. Literals come from the shipped binary's own
       * strings; both an affirmative and a refusal must be on screen, because a
       * dialog offers a choice while prose does not.
       */
      id: "approval_dialog_attention",
      state: "attention",
      priority: 1300,
      region: "whole_recent",
      visibleAttention: true,
      matchers: {
        any: [
          { contains: ["allow once", "reject"] },
          { contains: ["allow once", "deny"] },
          { contains: ["allow all", "reject"] },
          { contains: ["requires approval"] },
        ],
      },
    },
    {
      /** Braille spinner in the OSC title — a turn is running. */
      id: "osc_title_working",
      state: "working",
      priority: 1200,
      region: "osc_title",
      visibleWorking: true,
      matchers: { regex: ["[\\u2800-\\u28FF]"] },
    },
    {
      /** The body's own status line for a live turn. */
      id: "working_line_working",
      state: "working",
      priority: 1150,
      region: "bottom_non_empty_lines",
      regionN: 6,
      visibleWorking: true,
      matchers: {
        any: [
          { lineRegex: ["[\\u2800-\\u28FF]\\s*Working"] },
          { contains: ["esc to cancel"] },
          { contains: ["ctrl+c to stop"] },
        ],
      },
    },
    {
      /**
       * Waiting. The `>` marker sits where the spinner would be, and braille is
       * excluded again here so a spinner frame can never read as idle.
       */
      id: "osc_title_idle",
      state: "idle",
      priority: 1000,
      region: "osc_title",
      visibleIdle: true,
      matchers: {
        regex: ["^\\s*\\u03C0\\s*>"],
        not: [{ regex: ["[\\u2800-\\u28FF]"] }],
      },
    },
  ],
};
