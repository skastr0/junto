/**
 * Muse seat rules.
 *
 * Sweep (docs/research/agent-cli-sweep/muse.md) + 2026-08 probe:
 * - Handshake surface verified: bracketed paste, focus, OSC palette, DSR.
 * - No OSC title, no alt screen, no evidenced attention/working literals.
 * - `--agents <JSON>` CLI accepts an object shape, but the binary reports
 *   "Session Agent Definition decoder is not implemented" — not a Tier A path
 *   on Muse Code 0.1.0-R708.1.
 *
 * Doctrine is Tier B firstTyped. Screen matchers cannot yet express
 * handshake-only idle, so the typeable gate for the armed firstTyped body
 * lives in SeatStateRuntime.isSeatIdle (muse + bracketedPaste + pending
 * firstTyped). Keep this pack empty of inventing unproven chrome strings;
 * when live TUI literals land, add attention/working/idle rules here.
 */

import type { SeatRulePack } from "../types";

export const museRules: SeatRulePack = {
  harness: "muse",
  version: "2026.08.07.1",
  rules: [],
};
