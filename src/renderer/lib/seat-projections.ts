/**
 * One seat fact → three speech acts (card mark, digit lease, notify).
 *
 * Join key is the canvas node id. Status is never written onto ether.
 * `terminalActivity` remains the card painter; these functions only decide.
 */

import type { AgentSeatState } from "@shared/agent-seat-state";
import { terminalActivity, type ActivitySpec } from "./activity";

export type SeatFacts = {
  readonly nodeId: string;
  readonly seatState?: AgentSeatState | null;
  readonly seatReason?: string | null;
  readonly needsLook?: boolean;
  readonly graphBlocked?: boolean;
  readonly flags?: ReadonlyArray<string>;
  readonly managedSeat?: boolean;
  readonly running?: boolean;
  readonly starting?: boolean;
  readonly processName?: string | null;
  readonly exitReason?: "cli-missing" | "spawn_failed" | null;
  readonly exitMessage?: string | null;
  /** Extra live attention (ACP permission, sink input-required). Not harness. */
  readonly attentionReasons?: ReadonlyArray<string>;
};

export type NotifyKind = "blocked" | "attention";

/** What is this seat doing now? Idle seated = quiet steel. */
export function cardMark(facts: SeatFacts): ActivitySpec {
  return terminalActivity({
    seatState: facts.seatState,
    needsLook: facts.needsLook,
    seatReason: facts.seatReason,
    running: facts.running,
    starting: facts.starting,
    graphBlocked: facts.graphBlocked,
    exitReason: facts.exitReason,
    exitMessage: facts.exitMessage,
    processName: facts.processName,
    managedSeat: facts.managedSeat,
  });
}

/** Should 1–9 sticky-lease this actor? Only working or attention. */
export function digitLease(facts: SeatFacts): boolean {
  return facts.seatState === "working" || facts.seatState === "attention";
}

/** Does this need the operator? Only graph-blocked or attention. Working is not notify. */
export function notifyItem(facts: SeatFacts): NotifyKind | null {
  if (facts.graphBlocked) return "blocked";
  if (facts.seatState === "attention") return "attention";
  if (facts.flags?.includes("attention") === true) return "attention";
  if ((facts.attentionReasons?.length ?? 0) > 0) return "attention";
  return null;
}
