/**
 * Agent signal builders. The schemas live in the wire module (effect-only,
 * shared with the phone companion) and are re-exported here.
 */
import type { AgentSignal, AgentSignalKind } from "./wire/agent-signals";

export * from "./wire/agent-signals";

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
