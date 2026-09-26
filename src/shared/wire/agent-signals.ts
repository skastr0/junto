import { Schema } from "effect";

/**
 * Agent signals: a seat's own declared claim that it needs the operator.
 *
 * - `escalate`: needs the operator's attention; work continues. Any time.
 * - `blocked`: work is entirely blocked on the operator.
 * - `feedback`: not blocked; an opportunity for the operator to review.
 *
 * A signal is durable (it waits for an operator response) and belongs to one
 * canvas seat. It is the agent's claim, never an assessment: advisory thread
 * health (`thread-health.ts`) is a separate axis and must not be merged in.
 */

export const AGENT_SIGNAL_KINDS = ["escalate", "blocked", "feedback"] as const;
export const AgentSignalKind = Schema.Literals(AGENT_SIGNAL_KINDS);
export type AgentSignalKind = typeof AgentSignalKind.Type;

export const AGENT_SIGNAL_STATES = ["open", "answered", "dismissed", "withdrawn"] as const;
export const AgentSignalState = Schema.Literals(AGENT_SIGNAL_STATES);
export type AgentSignalState = typeof AgentSignalState.Type;

/** One short sentence, the same bound as a preamble. */
export const AGENT_SIGNAL_MAX_TEXT_LENGTH = 280;
/** Longer markdown the operator can open. */
export const AGENT_SIGNAL_MAX_DETAIL_LENGTH = 8_000;
/** The operator's answer, delivered to the seat as mail. */
export const AGENT_SIGNAL_MAX_RESPONSE_LENGTH = 8_000;

const boundedText = (max: number) =>
  Schema.String.pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(max)),
  );

export const AgentSignalText = boundedText(AGENT_SIGNAL_MAX_TEXT_LENGTH);
export const AgentSignalDetail = boundedText(AGENT_SIGNAL_MAX_DETAIL_LENGTH);
export const AgentSignalResponseText = boundedText(AGENT_SIGNAL_MAX_RESPONSE_LENGTH);

export const AgentSignalResponse = Schema.Struct({
  text: AgentSignalResponseText,
  /** Epoch ms. */
  at: Schema.Number,
});
export type AgentSignalResponse = typeof AgentSignalResponse.Type;

export const AgentSignal = Schema.Struct({
  signalId: Schema.String,
  canvasName: Schema.String,
  nodeId: Schema.String,
  kind: AgentSignalKind,
  text: AgentSignalText,
  detail: Schema.optionalKey(AgentSignalDetail),
  /** Epoch ms. */
  createdAt: Schema.Number,
  state: AgentSignalState,
  /** Present once the operator answered. */
  response: Schema.optionalKey(AgentSignalResponse),
  /** Epoch ms of the last state change (answer, dismiss, withdraw). */
  closedAt: Schema.optionalKey(Schema.Number),
});
export type AgentSignal = typeof AgentSignal.Type;

/** Live renderer event: the signal as it now stands (upsert by signalId). */
export const AgentSignalEvent = Schema.Struct({
  signal: AgentSignal,
});
export type AgentSignalEvent = typeof AgentSignalEvent.Type;
