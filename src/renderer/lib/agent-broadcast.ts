import type { AgentSeatState } from "@shared/agent-seat-state";
import {
  AGENT_BROADCAST_PROMPTS,
  type AgentBroadcastKind,
} from "@shared/agent-broadcast-prompts";
import type { CanvasNode } from "@shared/canvas";
import { agentSeat$ } from "./agent-seat-state";
import { agentCountLabel, isAgentSeatNode } from "./multi-selection";
import {
  multiPromptAgents,
  multiPromptTargetsFromNodes,
  type MultiPromptOps,
  type MultiPromptResult,
  type MultiPromptTarget,
} from "./multi-prompt";
import { state$ } from "./state";

/**
 * Operator broadcast: one pre-configured prompt typed into every selected
 * agent seat whose terminal is live. Seats without a live terminal are
 * skipped, never queued, so a "stop" cannot land long after the operator
 * asked for it.
 */

export type SeatStateLookup = (bindingId: string) => AgentSeatState | undefined;

export type AgentBroadcastPlan = {
  /** Every agent node in the selection, bound or not. */
  readonly agents: number;
  /** Seats with a live terminal; these receive the prompt. */
  readonly live: ReadonlyArray<MultiPromptTarget>;
  /** Agents with no managed seat or no live terminal. */
  readonly skipped: number;
};

/** Seat states the main process also treats as a live, writable terminal. */
const LIVE_SEAT_STATES: ReadonlySet<AgentSeatState> = new Set(["idle", "working", "attention"]);

const defaultSeatState: SeatStateLookup = (bindingId) =>
  agentSeat$.byBindingId[bindingId].peek()?.state;

export const planAgentBroadcast = (
  nodes: ReadonlyArray<CanvasNode>,
  seatStateOf: SeatStateLookup = defaultSeatState,
): AgentBroadcastPlan => {
  const unique = [...new Map(nodes.map((node) => [node.id, node])).values()];
  const agents = unique.filter(isAgentSeatNode);
  const live = multiPromptTargetsFromNodes(agents).filter((target) => {
    const state = seatStateOf(target.bindingId);
    return state !== undefined && LIVE_SEAT_STATES.has(state);
  });
  return { agents: agents.length, live, skipped: agents.length - live.length };
};

/** Menu subtitle: "3 agents", or "2 of 3 agents live" when some are down. */
export const broadcastMenuHint = (plan: AgentBroadcastPlan): string =>
  plan.skipped === 0
    ? agentCountLabel(plan.live.length)
    : `${plan.live.length} of ${agentCountLabel(plan.agents)} live`;

export type AgentBroadcastOutcome = {
  readonly kind: AgentBroadcastKind;
  readonly skipped: number;
  readonly result: MultiPromptResult;
};

export async function broadcastToAgents(
  kind: AgentBroadcastKind,
  plan: AgentBroadcastPlan,
  ops?: MultiPromptOps,
): Promise<AgentBroadcastOutcome> {
  // A stop or check is only worth sending now: never start a down seat for it.
  const result = await multiPromptAgents(plan.live, AGENT_BROADCAST_PROMPTS[kind].text, ops, { wake: false });
  return { kind, skipped: plan.skipped, result };
}

/** One line for the operator: what went out, and every seat that did not get it now. */
export const formatBroadcastOutcome = (outcome: AgentBroadcastOutcome): string => {
  const { kind, skipped, result } = outcome;
  const parts = [`${kind} sent to ${agentCountLabel(result.sent)}`];
  if (skipped > 0) parts.push(`${skipped} skipped with no live terminal`);
  if (result.queued.length > 0) parts.push(`${result.queued.length} queued until the seat is up`);
  if (result.failed.length > 0) {
    const keys = [...new Set(result.failed.map((note) => note.agentKey))].join(", ");
    parts.push(`${result.failed.length} failed (${keys})`);
  }
  return parts.join(", ");
};

/** True when the operator should see the outcome line (anything short of full delivery). */
export const broadcastNeedsNotice = (outcome: AgentBroadcastOutcome): boolean =>
  outcome.skipped > 0 || outcome.result.queued.length > 0 || outcome.result.failed.length > 0;

/**
 * Menu action: re-plan against the live seat states, send, and raise the
 * outcome line on the warning banner when any selected agent missed it.
 */
export async function broadcastToSelection(
  kind: AgentBroadcastKind,
  nodes: ReadonlyArray<CanvasNode>,
): Promise<void> {
  const outcome = await broadcastToAgents(kind, planAgentBroadcast(nodes));
  if (broadcastNeedsNotice(outcome)) state$.error.set(formatBroadcastOutcome(outcome));
}
