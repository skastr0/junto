/**
 * A seat's collaboration state: what one seat may see of another.
 *
 * A seat is always live and always available. Whether its terminal process is
 * running, whether a PTY stream is attached, which session generation holds
 * the seat: those are internals of how seats are run today, and they never
 * reach a peer. Mail reaches every connected seat; delivering it brings the
 * seat to it.
 *
 * What a peer does see is where the seat stands in the collaboration graph:
 * working, idle, waiting on the operator, blocked, ready for review, or done.
 * It is projected from the seat's most urgent need (`harness-domain/need.ts`),
 * and every cause maps, so a new cause fails the typecheck until it is placed.
 *
 * Pure module, shared by the core, the CLI and tests.
 */
import { Schema } from "effect";
import type { AgentSeatState } from "./agent-seat-state";
import type { Need, NeedCause } from "./harness-domain";

export const SEAT_COLLABORATION_STATES = [
  "working",
  "idle",
  "waiting-on-operator",
  "blocked",
  "ready-for-review",
  "done",
] as const;

export const SeatCollaborationState = Schema.Literals(SEAT_COLLABORATION_STATES);
export type SeatCollaborationState = typeof SeatCollaborationState.Type;

/**
 * Each need cause as a peer reads it. A seat whose process stopped, crashed,
 * hit a usage limit or never started is `idle`: it is available, and mail
 * reaches it.
 */
const BY_CAUSE: Readonly<Record<NeedCause, SeatCollaborationState>> = {
  permission: "waiting-on-operator",
  question: "waiting-on-operator",
  dialog: "waiting-on-operator",
  seat_blocked: "blocked",

  usage_limit: "idle",
  auth_error: "idle",
  crash: "idle",
  unexpected_exit: "idle",

  seat_escalated: "waiting-on-operator",
  awareness_waiting: "waiting-on-operator",
  awareness_approval: "waiting-on-operator",
  awareness_answer: "waiting-on-operator",

  seat_feedback: "ready-for-review",
  turn_unseen: "done",
  turn_failed: "done",

  retrying: "working",
  usage_limit_waking: "idle",
  usage_limit_resuming: "idle",
  stalled: "working",
  awareness_stuck: "working",
  awareness_looping: "working",
  awareness_thrashing: "working",
  awareness_confused: "working",
  awareness_overwhelmed: "working",
  awareness_access: "working",
  awareness_error: "working",

  starting: "working",
  working: "working",
  compacting: "working",

  idle: "idle",
  exited: "idle",
  unknown: "idle",
};

/** The five-value terminal state, for an event that carries no need. */
const BY_STATE: Readonly<Record<AgentSeatState, SeatCollaborationState>> = {
  working: "working",
  attention: "waiting-on-operator",
  idle: "idle",
  unknown: "idle",
  gone: "idle",
};

/**
 * A seat's collaboration state from what was observed of it: its top need when
 * it has one, else its terminal state, else `idle` (nothing observed is not
 * unavailable).
 */
export const collaborationStateOf = (
  observed: { readonly state?: AgentSeatState | undefined; readonly need?: Need | undefined } | undefined,
): SeatCollaborationState => {
  if (observed?.need !== undefined) return BY_CAUSE[observed.need.cause];
  if (observed?.state !== undefined) return BY_STATE[observed.state];
  return "idle";
};
