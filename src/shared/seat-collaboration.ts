/**
 * Seat collaboration — one seat asks a peer for help, the peer answers, and
 * the answer comes back through ordinary crew mail.
 *
 * This is the one contract both halves share:
 *
 *   renderer  composes the request (who is asking, what the question is, why
 *             this peer) and projects the threads it can see in the canvas
 *             document's mailboxes.
 *   main      validates the same shape, appends it to the peer's mailbox with
 *             `workSystemMailboxNotify`, and returns the message id.
 *
 * The request travels as a normal mailbox message, so the reply path is the
 * one crew mail already has: the peer runs `junto msg reply` against the
 * request id, the reply lands in the asking seat's mailbox carrying
 * `metadata.inReplyTo`, and the renderer matches the two back together. There
 * is no second message store and no parallel ticket database — the mail IS the
 * request, and the metadata below is the only thing this feature adds to it.
 *
 * Nothing here is model-dependent. The peer ranking that produces a draft may
 * be improved by the awareness judgments (when the sidecar is enrolled), but a
 * request the operator writes by hand is the same message with the same
 * return path.
 */

import type { CanvasDoc, CanvasNode } from "./canvas";
import { messageBriefText, messageIdTimeMs } from "./message-delivery";
import type { Message } from "./work-model";

/** Metadata keys stamped on the request message. Open record, by design. */
export const SEAT_COLLABORATION_REQUEST_ID = "juntoCollaborationRequestId";
export const SEAT_COLLABORATION_SOURCE_NODE = "juntoCollaborationSourceNodeId";
export const SEAT_COLLABORATION_SOURCE_LABEL = "juntoCollaborationSourceLabel";
export const SEAT_COLLABORATION_TARGET_LABEL = "juntoCollaborationTargetLabel";
export const SEAT_COLLABORATION_QUESTION = "juntoCollaborationQuestion";
export const SEAT_COLLABORATION_WHY = "juntoCollaborationWhy";

/** Longest question and evidence line the wire accepts. */
export const SEAT_COLLABORATION_QUESTION_MAX = 400;
export const SEAT_COLLABORATION_WHY_MAX = 200;
export const SEAT_COLLABORATION_EVIDENCE_MAX = 4;
export const SEAT_COLLABORATION_EVIDENCE_LINE_MAX = 200;

export type SeatCollaborationDraft = {
  readonly canvas: string;
  readonly sourceNodeId: string;
  readonly sourceLabel: string;
  readonly targetNodeId: string;
  readonly targetLabel: string;
  readonly question: string;
  readonly why: string;
  readonly evidence: readonly string[];
};

/**
 * The ask's outcome. A success carries the mailbox document the request landed
 * in, exactly like every other work write, so the renderer can apply it and the
 * new thread appears immediately instead of on the next unrelated reload.
 */
export type SeatCollaborationAskResult =
  | {
      readonly ok: true;
      readonly requestId: string;
      readonly doc: CanvasDoc;
      readonly revision: string;
    }
  | { readonly ok: false; readonly error: string };

export type SeatCollaborationReply = {
  readonly messageId: string;
  readonly text: string;
  readonly at: number;
};

export type SeatCollaborationThread = {
  readonly requestId: string;
  readonly sourceNodeId: string;
  readonly sourceLabel: string;
  readonly targetNodeId: string;
  readonly targetLabel: string;
  readonly question: string;
  readonly why: string;
  readonly askedAt: number;
  readonly status: "asked" | "answered";
  readonly reply: SeatCollaborationReply | undefined;
};

const trimmed = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

const bounded = (value: string, max: number): string =>
  value.length > max ? value.slice(0, max) : value;

/**
 * The exact command the peer runs to answer. Written into the request body so
 * the reply path is stated where the question is, rather than assumed.
 */
export const collaborationReplyInstruction = (
  sourceNodeId: string,
  requestId: string,
): string =>
  `junto msg reply '{"target":"${sourceNodeId}","text":"<your answer>",` +
  `"inReplyTo":"${requestId}"}'`;

/**
 * The request body the peer reads from its mailbox.
 *
 * Deliberately short and machine-parseable at the top: the peer's PTY only
 * gets a one-line notice plus the `junto msg read` pointer (factory mail is
 * summarized, never pasted whole), so the body is read, not dumped.
 */
export const composeCollaborationRequestText = (
  draft: SeatCollaborationDraft,
  requestId: string,
): string => {
  const lines = [
    `[collaboration request from ${draft.sourceLabel}]`,
    "",
    draft.question,
  ];
  if (draft.why.length > 0) {
    lines.push("", `Why you: ${draft.why}`);
  }
  if (draft.evidence.length > 0) {
    lines.push("", `${draft.sourceLabel} screen:`);
    for (const line of draft.evidence) lines.push(`  ${line}`);
  }
  lines.push(
    "",
    "The operator routed this request. Answer it directly; if you cannot help, say so in one line.",
    `Reply with: ${collaborationReplyInstruction(draft.sourceNodeId, requestId)}`,
  );
  return lines.join("\n");
};

/** Metadata merged into the request Message. */
export const collaborationRequestMetadata = (
  draft: SeatCollaborationDraft,
  requestId: string,
): Record<string, unknown> => ({
  // Factory mail: the PTY gets one notify line plus the read pointer, so a
  // multi-line request never derails a seat that is mid-turn.
  factoryMail: true,
  senderName: draft.sourceLabel,
  [SEAT_COLLABORATION_REQUEST_ID]: requestId,
  [SEAT_COLLABORATION_SOURCE_NODE]: draft.sourceNodeId,
  [SEAT_COLLABORATION_SOURCE_LABEL]: draft.sourceLabel,
  [SEAT_COLLABORATION_TARGET_LABEL]: draft.targetLabel,
  [SEAT_COLLABORATION_QUESTION]: draft.question,
  [SEAT_COLLABORATION_WHY]: draft.why,
});

/**
 * Validate an untrusted ask (renderer to main, or a test). Absent or malformed
 * fields are refused rather than defaulted: a request with no question, or one
 * addressed to the asking seat itself, would be mail the peer cannot act on.
 */
export const normalizeSeatCollaborationAsk = (
  value: unknown,
): { readonly ok: true; readonly draft: SeatCollaborationDraft } | { readonly ok: false; readonly error: string } => {
  if (value === null || typeof value !== "object") {
    return { ok: false, error: "ask must be an object" };
  }
  const raw = value as Record<string, unknown>;
  const canvas = trimmed(raw.canvas);
  const sourceNodeId = trimmed(raw.sourceNodeId);
  const sourceLabel = trimmed(raw.sourceLabel);
  const targetNodeId = trimmed(raw.targetNodeId);
  const targetLabel = trimmed(raw.targetLabel);
  const question = trimmed(raw.question);
  const why = trimmed(raw.why);
  if (canvas === "") return { ok: false, error: "canvas is required" };
  if (sourceNodeId === "") return { ok: false, error: "sourceNodeId is required" };
  if (targetNodeId === "") return { ok: false, error: "targetNodeId is required" };
  if (sourceNodeId === targetNodeId) {
    return { ok: false, error: "a seat cannot ask itself" };
  }
  if (question === "") return { ok: false, error: "question is required" };
  if (question.length > SEAT_COLLABORATION_QUESTION_MAX) {
    return {
      ok: false,
      error: `question must be at most ${SEAT_COLLABORATION_QUESTION_MAX} characters`,
    };
  }
  const evidenceRaw = Array.isArray(raw.evidence) ? raw.evidence : [];
  const evidence: string[] = [];
  for (const entry of evidenceRaw) {
    const line = trimmed(entry);
    if (line === "") continue;
    evidence.push(bounded(line, SEAT_COLLABORATION_EVIDENCE_LINE_MAX));
    if (evidence.length >= SEAT_COLLABORATION_EVIDENCE_MAX) break;
  }
  return {
    ok: true,
    draft: {
      canvas,
      sourceNodeId,
      sourceLabel: sourceLabel === "" ? sourceNodeId : sourceLabel,
      targetNodeId,
      targetLabel: targetLabel === "" ? targetNodeId : targetLabel,
      question,
      why: bounded(why, SEAT_COLLABORATION_WHY_MAX),
      evidence,
    },
  };
};

const metadataOf = (message: Message): Record<string, unknown> | undefined => {
  const metadata = message.metadata;
  return metadata === undefined || metadata === null ? undefined : metadata;
};

/** Text of a message, flattened to one display line. Empty when it has none. */
export const collaborationMessageText = (message: Message): string => {
  const text = messageBriefText(message);
  return text === "(empty)" ? "" : text;
};

type RawRequest = {
  readonly requestId: string;
  readonly targetNodeId: string;
  readonly sourceNodeId: string;
  readonly sourceLabel: string;
  readonly targetLabel: string;
  readonly question: string;
  readonly why: string;
  readonly askedAt: number;
};

const readRequest = (
  message: Message,
  targetNodeId: string,
): RawRequest | undefined => {
  const metadata = metadataOf(message);
  if (metadata === undefined) return undefined;
  const requestId = trimmed(metadata[SEAT_COLLABORATION_REQUEST_ID]);
  if (requestId === "") return undefined;
  return {
    requestId,
    targetNodeId,
    sourceNodeId: trimmed(metadata[SEAT_COLLABORATION_SOURCE_NODE]),
    sourceLabel: trimmed(metadata[SEAT_COLLABORATION_SOURCE_LABEL]),
    targetLabel: trimmed(metadata[SEAT_COLLABORATION_TARGET_LABEL]),
    question: trimmed(metadata[SEAT_COLLABORATION_QUESTION]),
    why: trimmed(metadata[SEAT_COLLABORATION_WHY]),
    askedAt: messageIdTimeMs(message.messageId) ?? 0,
  };
};

const readReplyLink = (message: Message): string => {
  const metadata = metadataOf(message);
  return metadata === undefined ? "" : trimmed(metadata.inReplyTo);
};

const mailboxOf = (node: CanvasNode): readonly Message[] => {
  const messages = (node.ether as { readonly messages?: unknown } | undefined)
    ?.messages;
  return Array.isArray(messages) ? (messages as readonly Message[]) : [];
};

/**
 * Every collaboration thread visible in one canvas document.
 *
 * A request is any message carrying this feature's request id; the seat whose
 * mailbox holds it is the seat being asked. A reply is any message in the
 * document carrying `metadata.inReplyTo` equal to the request id, which is
 * exactly what `junto msg reply` stamps. Both halves are read from the same
 * projection the crew-mail surface already paints, so a thread cannot say
 * something the mailbox does not.
 */
export const collaborationThreads = (
  doc: Pick<CanvasDoc, "nodes">,
): readonly SeatCollaborationThread[] => {
  const requests: RawRequest[] = [];
  const replies = new Map<string, SeatCollaborationReply>();
  for (const node of doc.nodes) {
    for (const message of mailboxOf(node)) {
      const request = readRequest(message, node.id);
      if (request !== undefined) requests.push(request);
      const link = readReplyLink(message);
      if (link !== "" && !replies.has(link)) {
        replies.set(link, {
          messageId: message.messageId,
          text: collaborationMessageText(message),
          at: messageIdTimeMs(message.messageId) ?? 0,
        });
      }
    }
  }
  const threads = requests.map((request): SeatCollaborationThread => {
    const reply = replies.get(request.requestId);
    return {
      ...request,
      status: reply === undefined ? "asked" : "answered",
      reply,
    };
  });
  return threads.sort((a, b) => b.askedAt - a.askedAt);
};

/** Threads one seat asked for (outstanding first, then most recent). */
export const collaborationThreadsForSource = (
  threads: readonly SeatCollaborationThread[],
  sourceNodeId: string,
): readonly SeatCollaborationThread[] =>
  threads.filter((thread) => thread.sourceNodeId === sourceNodeId);
