/**
 * Seat collaboration — who to ask, what to ask, and what came back.
 *
 * A leaf module: it reads the canvas projection and the two seat stores, and
 * it composes a request. It never sends anything itself — the operator's click
 * goes through the IPC bridge, and main is what appends the mail.
 *
 * The ranking is honest about what it knows. The deterministic half says only
 * what is true of every seat (this peer is connected, it is idle, it is the
 * one already wired to this seat). The awareness half, when the sidecar is
 * enrolled, adds one more fact that is already published for that seat: its
 * current activity and the words on its own screen. A peer is never described
 * as knowing something the operator cannot see the source of.
 */

import { observable } from "@legendapp/state";
import type { CanvasDoc, CanvasNode } from "@shared/canvas";
import type { AgentSeatStateEvent } from "@shared/agent-seat-state";
import {
  normalizeSeatCollaborationAsk,
  type SeatCollaborationAskResult,
  type SeatCollaborationDraft,
  type SeatCollaborationThread,
} from "@shared/seat-collaboration";
import type {
  SeatAwarenessActivity,
  SeatAwarenessAssessment,
  SeatAwarenessAvailability,
  SeatAwarenessConcern,
} from "./seat-awareness-contract";
import { getJuntoApi } from "./junto-api";
import { applyWorkCanvasWrite } from "./mutations";
import { SEAT_AWARENESS_ACTIVITY_COPY, SEAT_AWARENESS_CONCERN_COPY } from "./seat-awareness";

/** One seat as collaboration sees it: identity, control state, and evidence. */
export type CollaborationSeatFacts = {
  readonly nodeId: string;
  readonly bindingId: string | undefined;
  readonly label: string;
  /** Control state, collapsed to the four that matter for asking a peer. */
  readonly state: "idle" | "working" | "attention" | "unknown" | "gone";
  readonly detail: string | undefined;
  readonly activity: SeatAwarenessActivity | null;
  readonly concerns: readonly SeatAwarenessConcern[];
  readonly availability: SeatAwarenessAvailability;
  readonly excerpt: string | null;
  /** Recent mailbox text on this seat, newest first, bounded by the caller. */
  readonly mail: readonly string[];
};

export type SeatCollaborationPeer = {
  readonly nodeId: string;
  readonly label: string;
  /** Why this peer, in the operator's words. Never claims unseen knowledge. */
  readonly why: string;
  /** The exact question the request carries. */
  readonly question: string;
  readonly basis: "awareness" | "fleet";
  readonly score: number;
};

/**
 * Requests this renderer has sent, by request id.
 *
 * The mailbox is the source of truth, and `collaborationThreads` reads it. This
 * holds the short window in which a request exists durably but the canvas
 * projection the renderer is holding has not caught up yet — without it, a
 * request the operator just sent would look like it never happened, and the
 * same peer would be offered again. A document-derived thread always wins, so
 * this can never contradict the mailbox.
 */
export const seatCollaborationSent$ = observable({
  byRequestId: {} as Record<string, SeatCollaborationThread>,
});

export const rememberSeatCollaboration = (
  requestId: string,
  draft: SeatCollaborationDraft,
): void => {
  seatCollaborationSent$.byRequestId[requestId].set({
    requestId,
    sourceNodeId: draft.sourceNodeId,
    sourceLabel: draft.sourceLabel,
    targetNodeId: draft.targetNodeId,
    targetLabel: draft.targetLabel,
    question: draft.question,
    why: draft.why,
    askedAt: Date.now(),
    status: "asked",
    reply: undefined,
  });
};

/** Mailbox threads, with this session's not-yet-projected requests merged in. */
export const mergeCollaborationThreads = (
  fromDocument: readonly SeatCollaborationThread[],
  sent: Readonly<Record<string, SeatCollaborationThread>>,
): readonly SeatCollaborationThread[] => {
  const known = new Set(fromDocument.map((thread) => thread.requestId));
  const pending = Object.values(sent).filter((thread) => !known.has(thread.requestId));
  return [...fromDocument, ...pending].sort((a, b) => b.askedAt - a.askedAt);
};

/**
 * Which card has its collaboration overlay open.
 *
 * Deliberately module state rather than component state: asking a peer writes
 * the canvas document, the write rebuilds the graph, and the card is remounted
 * under a pointer that has not moved. Component state would be lost in that
 * remount and the overlay would vanish at exactly the moment it has something
 * to show. A rebuilt card re-reads this and stays open.
 */
export const seatCollaborationUi$ = observable({ openNodeId: "" });

export const openSeatCollaboration = (nodeId: string): void => {
  seatCollaborationUi$.openNodeId.set(nodeId);
};

export const closeSeatCollaboration = (nodeId: string): void => {
  // Only the card that opened it may close it: a remount can deliver the
  // leave event after the next card has already taken the slot.
  if (seatCollaborationUi$.openNodeId.peek() === nodeId) {
    seatCollaborationUi$.openNodeId.set("");
  }
};

/** Heading copy for the collaboration section. */
export const SEAT_COLLABORATION_HEADING = "collaboration";
export const SEAT_COLLABORATION_IDLE_WHY = "connected and idle";
export const SEAT_COLLABORATION_ASK_PREFIX = "Ask";
export const SEAT_COLLABORATION_ASKED_LINE = "asked";
export const SEAT_COLLABORATION_ANSWERED_LINE = "answered";
export const SEAT_COLLABORATION_WAITING_LINE = "waiting for a reply";
export const SEAT_COLLABORATION_UNAVAILABLE_LINE =
  "collaboration is unavailable in this build";

/** Token stop list — words that would match every seat. */
const STOPWORDS: ReadonlySet<string> = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "your", "you",
  "not", "are", "was", "were", "has", "have", "had", "but", "its", "it's",
  "all", "any", "can", "will", "would", "should", "could", "then", "than",
  "there", "their", "them", "they", "what", "when", "where", "which", "while",
  "who", "why", "how", "use", "using", "used", "run", "runs", "running", "get",
  "got", "gets", "make", "made", "one", "two", "new", "old", "now", "out",
  "see", "seen", "say", "says", "said", "let", "lets", "just", "also", "more",
  "most", "some", "such", "only", "over", "under", "after", "before", "again",
  "still", "here", "about", "because", "been", "being", "does", "did", "done",
  "file", "files", "line", "lines", "text", "true", "false", "null", "none",
  "error", "errors", "test", "tests", "code", "task", "tasks", "work", "seat",
  "agent", "terminal", "message", "mail", "read", "write", "wrote", "check",
  "checking", "look", "looking", "need", "needs", "want", "wants", "help",
]);

const TOKEN_MAX = 24;
const DEFAULT_PEER_LIMIT = 3;
const MAIL_LOOKBACK = 3;

/** Split free text into comparable topic tokens (identifiers survive). */
export const collaborationTokens = (text: string): ReadonlySet<string> => {
  const tokens = new Set<string>();
  const matches = text.toLowerCase().match(/[a-z0-9][a-z0-9._/-]*/gu) ?? [];
  for (const raw of matches) {
    const token = raw.replace(/[._/-]+$/u, "");
    if (token.length < 4 || STOPWORDS.has(token)) continue;
    tokens.add(token);
    if (tokens.size >= TOKEN_MAX) break;
  }
  return tokens;
};

const intersection = (
  a: ReadonlySet<string>,
  b: ReadonlySet<string>,
): readonly string[] => [...a].filter((token) => b.has(token));

/** First non-empty line of the node's text, else the spawn label. */
export const collaborationSeatLabel = (node: CanvasNode): string => {
  const firstLine =
    node.type === "text"
      ? (node.text.split("\n")[0] ?? "").trim()
      : "";
  const spawnLabel =
    typeof node.ether?.terminal?.label === "string"
      ? node.ether.terminal.label.trim()
      : "";
  return firstLine || spawnLabel || node.id;
};

const MAILBOX_LOOKBACK = 40;

const recentMailOf = (node: CanvasNode): readonly string[] => {
  const messages = (node.ether as { readonly messages?: unknown } | undefined)
    ?.messages;
  if (!Array.isArray(messages)) return [];
  const out: string[] = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as {
      readonly parts?: ReadonlyArray<{ readonly kind?: string; readonly text?: string }>;
    };
    const text = (message.parts ?? [])
      .map((part) => (part.kind === "text" ? (part.text ?? "") : ""))
      .join(" ")
      .replace(/\s+/gu, " ")
      .trim();
    if (text === "") continue;
    out.push(text.slice(0, 240));
    if (out.length >= MAIL_LOOKBACK) break;
  }
  return out;
};

const controlStateOf = (
  event: AgentSeatStateEvent | undefined,
): CollaborationSeatFacts["state"] => {
  const state = event?.state;
  if (state === "gone") return "gone";
  if (state === "attention") return "attention";
  if (state === "working") return "working";
  if (state === "idle") return "idle";
  return "unknown";
};

/** Agent seats on one canvas, as collaboration sees them. */
export const collaborationFleet = (input: {
  readonly doc: Pick<CanvasDoc, "nodes">;
  readonly seatByBindingId: Readonly<Record<string, AgentSeatStateEvent | undefined>>;
  readonly awarenessByBindingId: Readonly<
    Record<string, SeatAwarenessAssessment | undefined>
  >;
}): readonly CollaborationSeatFacts[] => {
  const fleet: CollaborationSeatFacts[] = [];
  for (const node of input.doc.nodes) {
    if (node.ether?.entity?.kind !== "agent") continue;
    const bindingId =
      typeof node.ether?.terminal?.bindingId === "string" &&
      node.ether.terminal.bindingId.trim() !== ""
        ? node.ether.terminal.bindingId
        : undefined;
    const event = bindingId === undefined ? undefined : input.seatByBindingId[bindingId];
    const assessment =
      bindingId === undefined ? undefined : input.awarenessByBindingId[bindingId];
    const concerns = (assessment?.concerns ?? []).filter(
      (concern): concern is SeatAwarenessConcern => typeof concern === "string",
    );
    fleet.push({
      nodeId: node.id,
      bindingId,
      label: collaborationSeatLabel(node),
      state: controlStateOf(event),
      detail: typeof event?.reason === "string" ? event.reason : undefined,
      activity: assessment?.activity ?? null,
      concerns,
      availability: assessment?.availability ?? "not_assessed",
      excerpt: assessment?.evidence.lines.map((line) => line.text).join(" ") ?? null,
      mail: recentMailOf(node),
    });
  }
  return fleet;
};

/** Concerns worth asking a peer about, in the order the question should follow. */
const CONCERN_PRIORITY: readonly SeatAwarenessConcern[] = [
  "access_problem",
  "execution_error",
  "repetition",
  "answer_requested",
  "approval_requested",
];

const topicOf = (facts: CollaborationSeatFacts): string | undefined => {
  // The seat's own name is not a topic: "Builder" would otherwise be the
  // longest token on a screen with nothing else on it.
  const named = collaborationTokens(facts.label);
  const tokens = [
    ...collaborationTokens(
      [facts.detail ?? "", facts.excerpt ?? ""].join(" "),
    ),
  ].filter((token) => !named.has(token));
  const best = tokens.sort((a, b) => b.length - a.length)[0];
  return best;
};

const concernPhrase = (concern: SeatAwarenessConcern): string =>
  SEAT_AWARENESS_CONCERN_COPY[concern] ?? concern;

/**
 * The exact question a peer receives. Composed from the asking seat's own
 * evidence: its leading concern when the sidecar named one, otherwise the
 * topic its screen is about, otherwise an open request to look.
 */
export const collaborationQuestion = (
  facts: CollaborationSeatFacts,
): string => {
  const topic = topicOf(facts);
  const concern = CONCERN_PRIORITY.find((entry) => facts.concerns.includes(entry));
  const about = topic === undefined ? "its current problem" : `"${topic}"`;
  if (concern === "access_problem") {
    return `How did you get past the access problem with ${about}?`;
  }
  if (concern === "execution_error") {
    return `Have you hit this failure with ${about} before, and how did you get past it?`;
  }
  if (concern === "repetition") {
    return `${facts.label} keeps hitting ${about} again and again. Have you solved it before?`;
  }
  if (concern === "answer_requested") {
    return `Can you answer the question ${facts.label} is waiting on about ${about}?`;
  }
  if (concern === "approval_requested") {
    return `What did you do when this approval came up for ${about}?`;
  }
  if (topic === undefined) {
    return `Can you look at ${facts.label}'s current screen and suggest the next step?`;
  }
  return `Have you worked on ${about}? What did you find?`;
};

const availabilityBonus = (state: CollaborationSeatFacts["state"]): number => {
  if (state === "idle") return 2;
  if (state === "working") return 1;
  if (state === "attention") return 1;
  return 0;
};

const STATE_PHRASE: Readonly<Record<CollaborationSeatFacts["state"], string>> = {
  idle: SEAT_COLLABORATION_IDLE_WHY,
  working: "connected, mid-turn",
  attention: "connected, needs operator input",
  unknown: "connected, no live turn",
  gone: "connected",
};

const peerWhy = (peer: CollaborationSeatFacts, shared: readonly string[]): string => {
  const activity =
    peer.activity === null ? undefined : SEAT_AWARENESS_ACTIVITY_COPY[peer.activity];
  const topic = [...shared].sort((a, b) => b.length - a.length)[0];
  if (topic !== undefined && peer.availability === "current") {
    const what = activity === undefined ? "working" : activity;
    return `connected, ${what}, and its own screen mentions ${topic}`;
  }
  if (topic !== undefined && peer.mail.some((line) => collaborationTokens(line).has(topic))) {
    return `connected, and its recent mail mentions ${topic}`;
  }
  if (activity !== undefined) return `connected, currently ${activity}`;
  return STATE_PHRASE[peer.state];
};

/**
 * Ranked peers for one seat. Deterministic: the same fleet always produces the
 * same order, and a peer is included only when it is a real, reachable seat
 * that is not the asking seat and not already holding an open request.
 */
export const collaborationPeerSuggestions = (input: {
  readonly source: CollaborationSeatFacts;
  readonly fleet: readonly CollaborationSeatFacts[];
  /** Seats with an open request from this source — not asked twice. */
  readonly awaitingNodeIds?: readonly string[];
  readonly limit?: number;
}): readonly SeatCollaborationPeer[] => {
  const { source } = input;
  const awaiting = new Set(input.awaitingNodeIds ?? []);
  const sourceTokens = collaborationTokens(
    [
      source.label,
      source.detail ?? "",
      source.excerpt ?? "",
      ...source.concerns.map(concernPhrase),
      ...source.mail,
    ].join(" "),
  );
  const peers: SeatCollaborationPeer[] = [];
  for (const peer of input.fleet) {
    if (peer.nodeId === source.nodeId) continue;
    if (peer.bindingId === undefined) continue;
      // A seat with no live turn is still a real mailbox: crew mail queues and
    // wakes it. Only a seat that has left the canvas cannot be asked.
    if (peer.state === "gone") continue;
    if (awaiting.has(peer.nodeId)) continue;
    const peerTokens = collaborationTokens(
      [peer.label, peer.activity ?? "", peer.excerpt ?? "", ...peer.mail].join(" "),
    );
    const shared = intersection(sourceTokens, peerTokens);
    const score = shared.length * 3 + availabilityBonus(peer.state);
    peers.push({
      nodeId: peer.nodeId,
      label: peer.label,
      why: peerWhy(peer, shared),
      question: collaborationQuestion(source),
      basis: shared.length > 0 && peer.availability === "current" ? "awareness" : "fleet",
      score,
    });
  }
  return peers
    .sort((a, b) =>
      b.score === a.score ? a.label.localeCompare(b.label) : b.score - a.score,
    )
    .slice(0, input.limit ?? DEFAULT_PEER_LIMIT);
};

/** Evidence lines quoted in the request: the asking seat's own screen. */
export const collaborationEvidence = (
  source: CollaborationSeatFacts,
): readonly string[] => {
  const lines: string[] = [];
  if (source.detail !== undefined && source.detail.trim() !== "") {
    lines.push(`status: ${source.detail.trim()}`);
  }
  if (source.activity !== null) {
    lines.push(`activity: ${SEAT_AWARENESS_ACTIVITY_COPY[source.activity]}`);
  }
  const excerpt = (source.excerpt ?? "").trim();
  if (excerpt !== "") lines.push(excerpt.slice(0, 200));
  return lines.slice(0, 3);
};

/** Compose the wire draft for one peer. */
export const collaborationDraft = (input: {
  readonly canvas: string;
  readonly source: CollaborationSeatFacts;
  readonly peer: SeatCollaborationPeer;
}): SeatCollaborationDraft => ({
  canvas: input.canvas,
  sourceNodeId: input.source.nodeId,
  sourceLabel: input.source.label,
  targetNodeId: input.peer.nodeId,
  targetLabel: input.peer.label,
  question: input.peer.question,
  why: input.peer.why,
  evidence: collaborationEvidence(input.source),
});

/** Threads that are still waiting on a reply, as node ids. */
export const awaitingPeerNodeIds = (
  threads: readonly SeatCollaborationThread[],
  sourceNodeId: string,
): readonly string[] =>
  threads
    .filter((thread) => thread.sourceNodeId === sourceNodeId && thread.status === "asked")
    .map((thread) => thread.targetNodeId);

/** Send one request. The bridge is absent in tests and in a cold renderer. */
export const askSeatPeer = async (
  draft: SeatCollaborationDraft,
): Promise<SeatCollaborationAskResult> => {
  const normalized = normalizeSeatCollaborationAsk(draft);
  if (!normalized.ok) return { ok: false, error: normalized.error };
  const api = getJuntoApi();
  if (api?.seatCollaborationAsk === undefined) {
    return { ok: false, error: SEAT_COLLABORATION_UNAVAILABLE_LINE };
  }
  try {
    const result = await api.seatCollaborationAsk(normalized.draft);
    // The request is mail, so the write returns the mailbox document. Applying
    // it is what turns the suggestion into an open thread on the card.
    if (result.ok) {
      rememberSeatCollaboration(result.requestId, normalized.draft);
      // The write's own document read can predate the message projection, so
      // the thread is recorded here and the mailbox takes over as it catches
      // up. Applying the returned document keeps the rest of the canvas in
      // step; it is not what the thread depends on.
      applyWorkCanvasWrite(normalized.draft.canvas, result.doc, result.revision);
    }
    return result;
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "collaboration request failed",
    };
  }
};

/** One-line thread status for the card. */
export const collaborationThreadLine = (
  thread: SeatCollaborationThread,
): string =>
  thread.status === "answered"
    ? `${SEAT_COLLABORATION_ANSWERED_LINE} by ${thread.targetLabel}`
    : `${SEAT_COLLABORATION_WAITING_LINE} (${thread.targetLabel})`;
