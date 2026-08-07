/**
 * Muse seat rules — deliberately minimal. The sweep
 * (docs/research/agent-cli-sweep/muse.md, 2026-08-06 fast-track) verified the
 * terminal handshake surface (bracketed paste, focus events, OSC palette
 * queries, cursor DSR) but captured NO TUI text: no OSC title, no alt screen,
 * working-state signals unverified, no live approval-modal capture, and no
 * herdr manifest. Approval dialogs exist by construction
 * (--approval-mode on-request default; workspace trust is file-managed in
 * ~/.config/muse/trust.json) but their screen text is not evidenced, so no
 * attention rule can be cited. There is no herdr manifest to mirror.
 *
 * The pack therefore ships zero rules: the engine reports low-confidence idle
 * (the seat stays effectively unknown and never publishes visible chrome)
 * until a live muse TUI is probed (free `--provider echo` runs) and real
 * literals land here. Readiness signals (bracketed paste / DSR / palette
 * queries) live in ObserverGridSnapshot.signals, which rule matchers cannot
 * see yet — a future modes-aware rule surface would unlock them.
 */

import type { SeatRulePack } from "../types";

export const museRules: SeatRulePack = {
  harness: "muse",
  version: "2026.08.06.1",
  rules: [],
};
