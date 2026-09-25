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

/** Collapse whitespace so a signal reads as one line before it is bounded. */
export const normalizeSignalText = (value: string): string =>
  value.replace(/\s+/gu, " ").trim();

/** Worst first: blocked outranks escalate outranks feedback. */
export const AGENT_SIGNAL_SEVERITY: Readonly<Record<AgentSignalKind, number>> = {
  blocked: 3,
  escalate: 2,
  feedback: 1,
};

export type SeatSignalRollup = {
  /** Worst open kind on the seat. */
  readonly kind: AgentSignalKind;
  /** The open signal carrying that kind (newest when tied). */
  readonly signal: AgentSignal;
  /** Every open signal on the seat. */
  readonly openCount: number;
};

const worse = (a: AgentSignal, b: AgentSignal): AgentSignal => {
  const bySeverity = AGENT_SIGNAL_SEVERITY[a.kind] - AGENT_SIGNAL_SEVERITY[b.kind];
  if (bySeverity !== 0) return bySeverity > 0 ? a : b;
  return a.createdAt >= b.createdAt ? a : b;
};

/** Worst open signal per seat, keyed by nodeId. Closed signals never count. */
export const rollupSeatSignals = (
  signals: Iterable<AgentSignal>,
): ReadonlyMap<string, SeatSignalRollup> => {
  const out = new Map<string, SeatSignalRollup>();
  for (const signal of signals) {
    if (signal.state !== "open") continue;
    const prior = out.get(signal.nodeId);
    const pick = prior ? worse(prior.signal, signal) : signal;
    out.set(signal.nodeId, {
      kind: pick.kind,
      signal: pick,
      openCount: (prior?.openCount ?? 0) + 1,
    });
  }
  return out;
};

const KIND_WORDS: Readonly<Record<AgentSignalKind, string>> = {
  blocked: "blocked",
  escalate: "escalate",
  feedback: "feedback",
};

/**
 * The operator's answer as the seat reads it: typed into the seat as operator
 * mail, naming which of its signals it answers so the agent can match it.
 */
export const composeSignalAnswerMail = (
  signal: Pick<AgentSignal, "signalId" | "kind" | "text">,
  response: string,
): string =>
  [
    `The operator answered your ${KIND_WORDS[signal.kind]} signal (${signal.signalId}): "${signal.text}"`,
    "",
    response.trim(),
  ].join("\n");
