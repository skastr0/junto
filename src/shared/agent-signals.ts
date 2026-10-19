/**
 * Agent signal builders. The schemas live in the wire module (effect-only,
 * shared with the phone companion) and are re-exported here.
 */
import type { AgentSignal, AgentSignalKind } from "./wire/agent-signals";
import { compareUrgency, levelOfSignal } from "./wire/urgency";

export * from "./wire/agent-signals";

/** Collapse whitespace so a signal reads as one line before it is bounded. */
export const normalizeSignalText = (value: string): string =>
  value.replace(/\s+/gu, " ").trim();

export type SeatSignalRollup = {
  /** Worst open kind on the seat. */
  readonly kind: AgentSignalKind;
  /** The open signal carrying that kind (newest when tied). */
  readonly signal: AgentSignal;
  /** Every open signal on the seat. */
  readonly openCount: number;
};

/** The rollup's tie rule: of two equally urgent signals, the newer one stands. */
const newestWins = (a: AgentSignal, b: AgentSignal): AgentSignal => (a.createdAt >= b.createdAt ? a : b);

/** The more urgent of two signals; a tie goes to {@link newestWins}. */
const dominant = (a: AgentSignal, b: AgentSignal): AgentSignal => {
  const byUrgency = compareUrgency(levelOfSignal(a.kind), levelOfSignal(b.kind));
  if (byUrgency !== 0) return byUrgency < 0 ? a : b;
  return newestWins(a, b);
};

/** `junto signal list`'s order: open first, most urgent first, then oldest, then id. */
export const compareSignalListOrder = (a: AgentSignal, b: AgentSignal): number =>
  Number(b.state === "open") - Number(a.state === "open") ||
  compareUrgency(levelOfSignal(a.kind), levelOfSignal(b.kind)) ||
  a.createdAt - b.createdAt ||
  (a.signalId < b.signalId ? -1 : a.signalId > b.signalId ? 1 : 0);

/** Worst open signal per seat, keyed by nodeId. Closed signals never count. */
export const rollupSeatSignals = (
  signals: Iterable<AgentSignal>,
): ReadonlyMap<string, SeatSignalRollup> => {
  const out = new Map<string, SeatSignalRollup>();
  for (const signal of signals) {
    if (signal.state !== "open") continue;
    const prior = out.get(signal.nodeId);
    const pick = prior ? dominant(prior.signal, signal) : signal;
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
 * What an acknowledgement records: a quiet answer the operator sent with no
 * note. The store holds every answer with text, so main writes this in its
 * place; the seat reads it in `signal list` and is never woken by it.
 */
export const AGENT_SIGNAL_ACKNOWLEDGED_RESPONSE = "Acknowledged, no note";

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
