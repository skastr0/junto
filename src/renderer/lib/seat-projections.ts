/**
 * One assembled seat fact → named speech acts (card, digit lease, notify, hue).
 *
 * Join key is the canvas node id. Status is never written onto the node.
 * `terminalActivity` remains the card painter; these functions only decide.
 */

import type { AgentSeatState, AgentSeatStateEvent } from "@shared/agent-seat-state";
import type { TerminalSessionSummary } from "@shared/terminal";
import { terminalActivity, type ActivitySpec } from "./activity";

export type SeatFacts = {
  readonly nodeId: string;
  readonly seatState?: AgentSeatState | null;
  readonly seatReason?: string | null;
  readonly needsLook?: boolean;
  readonly graphBlocked?: boolean;
  readonly managedSeat?: boolean;
  readonly running?: boolean;
  readonly starting?: boolean;
  readonly processName?: string | null;
  readonly exitReason?: "cli-missing" | "spawn_failed" | null;
  readonly exitMessage?: string | null;
};

export type NotifyKind = "blocked" | "attention";

/** Chip hue for an actor seat. Not a second merge — named projection only. */
export type DigitHue = "blocked" | "attention" | "working" | "idle";

export type SeatFactsInput = {
  readonly nodeId: string;
  readonly seatEvent?: Pick<AgentSeatStateEvent, "state" | "reason"> | null;
  readonly session?: Pick<
    TerminalSessionSummary,
    "status" | "processName" | "title" | "exitReason" | "exitMessage"
  > | null;
  readonly graphBlocked?: boolean;
  readonly managedSeat?: boolean;
  readonly needsLook?: boolean;
};

/** Assemble one SeatFacts from the live planes a call site already holds. */
export function seatFactsForNode(input: SeatFactsInput): SeatFacts {
  const status = input.session?.status;
  return {
    nodeId: input.nodeId,
    seatState: input.seatEvent?.state,
    seatReason: input.seatEvent?.reason,
    needsLook: input.needsLook,
    graphBlocked: input.graphBlocked === true,
    managedSeat: input.managedSeat,
    running: status === "running" || status === "starting",
    starting: status === "starting",
    processName:
      input.session?.processName?.trim() ||
      input.session?.title?.trim() ||
      undefined,
    exitReason: input.session?.exitReason,
    exitMessage: input.session?.exitMessage,
  };
}

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

/** Should 1–9 sticky-lease this actor? Working or attention. */
export function digitLease(facts: SeatFacts): boolean {
  return facts.seatState === "working" || facts.seatState === "attention";
}

/** Does this need the operator? Only graph-blocked or attention. Working is not notify. */
export function notifyItem(facts: SeatFacts): NotifyKind | null {
  if (facts.graphBlocked) return "blocked";
  if (facts.seatState === "attention") return "attention";
  return null;
}

/** Actor chip hue from the same facts. Regions still use rollup severity. */
export function digitHue(facts: SeatFacts): DigitHue {
  const kind = notifyItem(facts);
  if (kind === "blocked") return "blocked";
  if (kind === "attention") return "attention";
  if (facts.seatState === "working") return "working";
  return "idle";
}
