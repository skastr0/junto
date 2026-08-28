/**
 * Muse seat rules.
 *
 * Sweep (docs/research/agent-cli-sweep/muse.md) + 2026-08 probe:
 *
 * NO COMPOSER PROBES YET: this harness's composer chrome is not grounded in a
 * capture on this machine, so composerVerdictFor returns null and factory
 * typing into its seats REFUSES (composer-unreadable attention). Ground the
 * real empty/draft chrome and add `composer` probes before shipping it.
 * - Handshake surface verified: bracketed paste, focus, OSC palette, DSR.
 * - No OSC title, no alt screen, no evidenced attention/working literals.
 * - `--agents <JSON>` CLI accepts an object shape, but the binary reports
 *   "Session Agent Definition decoder is not implemented" — not a Tier A path
 *   on Muse Code 0.1.0-R708.1.
 *
 * Doctrine is Tier B firstTyped. Screen matchers cannot yet express
 * handshake-only idle, so the typeable gate for the armed firstTyped body
 * lives in SeatStateRuntime.isSeatIdle (muse + bracketedPaste + pending
 * firstTyped). Only the OSC-title spinner is evidenced (working-turn.jsonl:
 * ⠋⠙⠹⠸⠼ muse frames); keep the pack otherwise empty of inventing
 * unproven chrome strings — startup idle (plain "muse" title) intentionally
 * falls through to fallback idle (fail-closed, isSeatIdle false).
 */

import type { SeatRulePack } from "../types";

export const museRules: SeatRulePack = {
  harness: "muse",
  version: "2026.08.07.2",
  rules: [
    {
      id: "osc_title_working",
      state: "working",
      priority: 100,
      region: "osc_title",
      visibleWorking: true,
      // Real muse working-turn capture: the OSC title animates braille
      // spinner frames ("⠙ muse", ⠋⠙⠹⠸⠼ muse) while working.
      // Startup idle keeps the plain "muse" title → no match → fallback
      // idle (documented fail-closed, isSeatIdle false).
      matchers: {
        regex: ["[\u2800-\u28FF]"],
      },
    },
  ],
};
