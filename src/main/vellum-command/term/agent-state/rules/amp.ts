/**
 * Amp CLI (`amp`) seat rules.
 *
 * Composer grounded in P1 corpus amp/* captured 2026-09-14 from
 * 0.0.1789397462 (`amp --no-ide`, operator home). Empty is a blank ╭─╮ box;
 * draft puts `steering:` or payload lines inside it. Connecting / catching-up
 * / streaming footers stay unreadable. Permission dialogs were not observed.
 *
 * Historical paint (0.0.1787664850 continue): startup footer `~ Connecting`,
 * resume `~ Catching Up`, turn braille title + `~ Streaming`, settled
 * `<title> - amp - <cwd>`. The empty startup title is why readiness is
 * positive: writing during Connecting is swallowed.
 */

import type { SeatRulePack } from "../types";

export const ampRules: SeatRulePack = {
  harness: "amp",
  version: "2026.09.14.1",
  rules: [
    {
      /** Approval gate: the turn stops until the operator answers. */
      id: "approval_wait_attention",
      state: "attention",
      priority: 1300,
      region: "whole_recent",
      visibleAttention: true,
      matchers: { contains: ["waiting for approval"] },
    },
    {
      /**
       * Ctrl+C opens a menu (`Archive and new thread` / `Archive and quit` /
       * `Quit` / `Esc cancel`) instead of interrupting. A seat sitting on it is
       * waiting on a person, and a second Ctrl+C would archive the thread.
       */
      id: "interrupt_menu_attention",
      state: "attention",
      priority: 1290,
      region: "whole_recent",
      visibleAttention: true,
      matchers: {
        contains: ["ctrl+c then"],
        any: [
          { contains: ["archive and quit"] },
          { contains: ["archive and new thread"] },
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
      /** Composer footer status line for an in-flight turn. */
      id: "footer_status_working",
      state: "working",
      priority: 1100,
      region: "bottom_non_empty_lines",
      regionN: 4,
      visibleWorking: true,
      matchers: {
        any: [
          { contains: ["streaming"] },
          { contains: ["thinking"] },
          { contains: ["cancelling"] },
          { contains: ["retrying"] },
        ],
      },
    },
    {
      /**
       * Startup / reconnect. The composer is on screen but Amp is not yet
       * accepting a turn, and the title is still empty — hold the prior state
       * rather than publish a writeable idle.
       */
      id: "connecting_unknown",
      state: "unknown",
      priority: 1050,
      region: "bottom_non_empty_lines",
      regionN: 4,
      skipStateUpdate: true,
      matchers: {
        any: [
          { contains: ["connecting"] },
          { contains: ["reconnecting"] },
          // Resume replays the thread before the composer accepts a turn.
          { contains: ["catching up"] },
        ],
      },
    },
    {
      /**
       * Settled turn: Amp titles the window `<thread title> - amp - <cwd>`.
       * Braille is excluded above by priority, and again here so a spinner
       * frame can never read as idle.
       */
      id: "osc_title_idle",
      state: "idle",
      priority: 1000,
      region: "osc_title",
      visibleIdle: true,
      matchers: {
        contains: [" - amp - "],
        not: [{ regex: ["[\\u2800-\\u28FF]"] }],
      },
    },
  ],
  composer: [
    {
      id: "composer_content_draft",
      verdict: "draft",
      region: "bottom_non_empty_lines",
      regionN: 8,
      matchers: {
        any: [
          { contains: ["steering:"] },
          { lineRegex: ["^\\s*\\u2502\\s+[^\\u2502\\s]"] },
        ],
        not: [
          { contains: ["waiting for approval"] },
          { contains: ["connecting"] },
          { contains: ["catching up"] },
        ],
      },
    },
    {
      id: "bare_box_empty",
      verdict: "empty",
      region: "bottom_non_empty_lines",
      regionN: 6,
      matchers: {
        lineRegex: ["^\\s*\\u256d\\u2500", "^\\s*\\u2502\\s*\\u2502\\s*$"],
        not: [
          { contains: ["steering:"] },
          { contains: ["streaming"] },
          { contains: ["connecting"] },
          { contains: ["catching up"] },
          { contains: ["waiting for approval"] },
          { lineRegex: ["^\\s*\\u2502\\s+[^\\u2502\\s]"] },
        ],
      },
    },
  ],
};
