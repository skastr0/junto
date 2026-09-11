/**
 * Amp CLI (`amp`) seat rules.
 *
 * Written from a real PTY capture of `amp --no-ide threads continue <T-id>`
 *
 * NO COMPOSER PROBES YET: this harness's composer chrome is not grounded in a
 * capture on this machine, so composerVerdictFor returns null and factory
 * typing into its seats REFUSES (composer-unreadable attention). Ground the
 * real empty/draft chrome and add `composer` probes before shipping it.
 * (0.0.1787664850). What Amp actually paints, in order:
 *
 *   startup   title ""                              footer `~ Connecting`
 *   resume    title ""                              footer `~ Catching Up`
 *   turn      title "<braille> amp - ~/Projects/vellum"  footer `~ Streaming`
 *   settled   title "Ready response - amp - ~/…"    footer plain
 *
 * The empty startup title is why readiness here is positive: an Amp seat is
 * not writeable because it went quiet, it is writeable once the composer stops
 * saying `Connecting`. Writing during that window is silently swallowed — the
 * text lands in the composer and the CR never submits it, which is exactly how
 * the first capture of this harness lost its prompt.
 */

import type { SeatRulePack } from "../types";

export const ampRules: SeatRulePack = {
  harness: "amp",
  version: "2026.08.25.1",
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
};
