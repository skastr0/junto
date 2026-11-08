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

/** One seat's state event, as the window reads it and as a core hands it to main. */
export const AgentSeatStateEvent = Schema.Struct({
  bindingId: Schema.String,
  epoch: Schema.String,
  state: Schema.Literals(["idle", "working", "attention", "unknown", "gone"]),
  reason: Schema.String,
  confidence: Schema.Literals(["high", "low"]),
  at: Schema.Number,
  harness: Schema.optionalKey(Schema.String),
  /**
   * The seat's status in the harness-domain vocabulary, which `state`
   * projects (agent-state/projection.ts). Absent on an event published by
   * a build before it, and on the tombstone of a generation moved off its
   * seat, whose snapshot moved with it. Carried in its encoded form.
   */
  status: Schema.optionalKey(Schema.toEncoded(AgentSeatStatus)),
});
export type AgentSeatStateEvent = typeof AgentSeatStateEvent.Type;

// The wire's state and confidence are the model's vocabularies.
const sameState: [AgentSeatStateEvent["state"]] extends [AgentSeatState] ? ([AgentSeatState] extends [AgentSeatStateEvent["state"]] ? true : false) : false = true;
const sameConfidence: [AgentSeatStateEvent["confidence"]] extends [AgentSeatConfidence] ? ([AgentSeatConfidence] extends [AgentSeatStateEvent["confidence"]] ? true : false) : false = true;
void [sameState, sameConfidence];

export const encodeAgentSeatStatus = Schema.encodeSync(AgentSeatStatus);

const decodeStatus = Schema.decodeUnknownOption(AgentSeatStatus);

/**
 * Each carried status decoded once. A status object rides its event unchanged
 * (a new event brings a new one), and the feed, the desktop notifications and
 * every seat's need asked for every seat's status on each seat change: a
 * schema decode per seat per read, 30 ms over 30 s on the operator's board
 * (0.11.10 trace).
 */
const decodedStatus = new WeakMap<object, AgentSeatStatus | undefined>();

/** The status an event carries, or undefined when it carries none that reads. */
export const agentSeatStatusOf = (
  event: Pick<AgentSeatStateEvent, "status"> | undefined,
): AgentSeatStatus | undefined => {
  const status: unknown = event?.status;
  if (status === undefined) return undefined;
  // Only an object can be held; anything else off the wire is junk that does not read.
  const holdable = typeof status === "object" && status !== null;
  if (holdable && decodedStatus.has(status)) return decodedStatus.get(status);
  const decoded = decodeStatus(status);
  const value = decoded._tag === "Some" ? decoded.value : undefined;
  if (holdable) decodedStatus.set(status, value);
  return value;
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
