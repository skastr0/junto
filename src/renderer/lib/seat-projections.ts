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
  /** Extra live attention (ACP permission, sink input-required). Not harness. */
  readonly attentionReasons?: ReadonlyArray<string>;
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
  readonly attentionReasons?: ReadonlyArray<string>;
  readonly managedSeat?: boolean;
  readonly needsLook?: boolean;
};

const attentionElevated = (facts: SeatFacts): boolean =>
  facts.seatState === "attention" ||
  (facts.attentionReasons?.length ?? 0) > 0;

/**
 * Live attention reasons for a seat named by its agent key, from **its own**
 * coarse chat slice, never the whole agent map. One agent's permission flip
 * is one key's write, so a caller keyed to that one slice pays nothing for
 * the others. A caller with no seat passes undefined and gets none.
 */
export function attentionReasonsForSeat(
  agentKey: string | undefined,
  ownCoarse?: { readonly pendingPermissionId?: string },
): ReadonlyArray<string> {
  return agentKey && ownCoarse?.pendingPermissionId ? ["permission:pending"] : [];
}

/**
 * The whole-map form, for a caller that already holds the map and projects
 * many seats at once (RTS rows, the hotbar). A component rendered once per
 * seat uses useSeatAttentionReasons instead (occupancy-feed.ts).
 */
export function liveAttentionReasonsForSeat(
  agentKey: string | undefined,
  chatByAgent?: Readonly<Record<string, { readonly pendingPermissionId?: string } | undefined>>,
): ReadonlyArray<string> {
  return attentionReasonsForSeat(agentKey, agentKey ? chatByAgent?.[agentKey] : undefined);
}

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
    attentionReasons: input.attentionReasons,
  };
}

/** What is this seat doing now? Idle seated = quiet steel. */
export function cardMark(facts: SeatFacts): ActivitySpec {
  const elevateToAttention =
    facts.seatState === "attention" ||
    (attentionElevated(facts) && facts.graphBlocked !== true);
  return terminalActivity({
    seatState: elevateToAttention ? "attention" : facts.seatState,
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

/** Should 1–9 sticky-lease this actor? Working or attention, including elevated. */
export function digitLease(facts: SeatFacts): boolean {
  return facts.seatState === "working" || attentionElevated(facts);
}

/** Does this need the operator? Only graph-blocked or attention. Working is not notify. */
export function notifyItem(facts: SeatFacts): NotifyKind | null {
  if (facts.graphBlocked) return "blocked";
  if (attentionElevated(facts)) return "attention";
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
