/**
 * Agent seat state — product states for a managed-terminal worker seat.
 *
 * `done` is not a state: presentation derives it as idle + unseen.
 * `gone` is an authoritative lifecycle invalidation: the former occupant's
 * generation exited or was unbound, so its last activity must not remain live.
 */

import { Schema } from "effect";
import { Need, SeatSnapshot } from "./harness-domain";
import type { AgentSeatState } from "./wire/seat-activity";

// The state vocabulary is a wire module, so the phone reads the same states.
export type { AgentSeatState } from "./wire/seat-activity";

export type AgentSeatConfidence = "high" | "low";

export type AgentSeatStateEvent = {
  readonly bindingId: string;
  readonly epoch: string;
  readonly state: AgentSeatState;
  readonly reason: string;
  readonly confidence: AgentSeatConfidence;
  readonly at: number;
  readonly harness?: string;
  /**
   * The seat's status in the harness-domain vocabulary, which `state`
   * projects (agent-state/projection.ts). Absent on an event published by
   * a build before it, and on the tombstone of a generation moved off its
   * seat, whose snapshot moved with it.
   */
  readonly status?: AgentSeatStatusWire;
};

/**
 * A seat's status as it rides the seat-state plane: its folded snapshot and
 * the most urgent need derived from it (harness-domain topNeed), encoded
 * with the domain schemas so the renderer, a remote hop and the CLI all
 * decode the same thing.
 */
export const AgentSeatStatus = Schema.Struct({
  snapshot: SeatSnapshot,
  need: Need,
});
export type AgentSeatStatus = typeof AgentSeatStatus.Type;
export type AgentSeatStatusWire = typeof AgentSeatStatus.Encoded;

export const encodeAgentSeatStatus = Schema.encodeSync(AgentSeatStatus);

const decodeStatus = Schema.decodeUnknownOption(AgentSeatStatus);

/** The status an event carries, or undefined when it carries none that reads. */
export const agentSeatStatusOf = (
  event: Pick<AgentSeatStateEvent, "status"> | undefined,
): AgentSeatStatus | undefined => {
  if (event?.status === undefined) return undefined;
  const decoded = decodeStatus(event.status);
  return decoded._tag === "Some" ? decoded.value : undefined;
};

/** Optional hook/events feed (Claude settings, Grok events.jsonl, Hermes plugins). */
export type AgentSeatHookState = {
  readonly state: AgentSeatState;
  readonly reason: string;
  readonly at: number;
  /** Full-lifecycle hooks own the seat while live (screen ignored unless attention visible). */
  readonly fullLifecycle?: boolean;
};

export const AGENT_SEAT_STATES: readonly AgentSeatState[] = [
  "idle",
  "working",
  "attention",
  "unknown",
  "gone",
] as const;

export const isAgentSeatState = (value: unknown): value is AgentSeatState =>
  value === "idle" ||
  value === "working" ||
  value === "attention" ||
  value === "unknown" ||
  value === "gone";
