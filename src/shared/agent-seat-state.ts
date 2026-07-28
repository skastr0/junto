/**
 * Agent seat state — product states for a managed-terminal worker seat.
 *
 * `done` is not a state: presentation derives it as idle + unseen.
 * `gone` is an authoritative lifecycle invalidation: the former occupant's
 * generation exited or was unbound, so its last activity must not remain live.
 */

export type AgentSeatState =
  | "idle"
  | "working"
  | "attention"
  | "unknown"
  | "gone";

export type AgentSeatConfidence = "high" | "low";

export type AgentSeatStateEvent = {
  readonly bindingId: string;
  readonly epoch: string;
  readonly state: AgentSeatState;
  readonly reason: string;
  readonly confidence: AgentSeatConfidence;
  readonly at: number;
  readonly harness?: string;
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
