/**
 * A seat's answer to the operator, from any machine (docs/machines.md rule 4,
 * docs/security-doctrine.md). The operator has no inbox: the answer is an
 * agent-role row in the seat's own mailbox, written by the machine the seat
 * lives on, and it crosses to the machine that edits the canvas like any of
 * that seat's mail. One rule decides it on both sides: the seat's machine
 * before it writes the row, and the editing machine before it takes the row
 * from a peer. A row that breaks it closes the link.
 *
 * Pure, no Node imports.
 */
import { mailThreadOf } from "./crew";
import { THREAD_SUBJECT_KEY, threadSubjectOf } from "./thread-subject";
import { isUlid } from "./ulid";
import { OPERATOR_SEAT_ID } from "./work-reference";
import type { Message } from "./work-model";

/** The one refusal, in fixed words: a row's own words never reach a log or a peer. */
export const OPERATOR_REPLY_REFUSAL = "a reply to the operator names no mail the operator sent in that mailbox";

/**
 * Is this seat-authored row an answer to the operator? Any agent-role row, or
 * any row that names a `toNodeId`, is one, and is held to the whole rule:
 * a seat writes no other agent-role mail.
 */
export const isOperatorReplyRow = (message: Pick<Message, "role" | "metadata">): boolean =>
  message.role === "agent" || message.metadata?.toNodeId !== undefined;

/** The mail an answer names as the one it answers, by id, or none. */
export const operatorReplyParentId = (message: Pick<Message, "metadata">): string | undefined => {
  const named = message.metadata?.inReplyTo;
  return typeof named === "string" && named !== "" ? named : undefined;
};

/** The mail it answers as the machine holds it: its stored author's seat (the column, never the metadata) and its row. */
export type OperatorReplyParent = { readonly actorSeatId: string; readonly message: Pick<Message, "messageId" | "metadata"> };

/** Why an answer is refused, for the tests; the link and the seat are told only OPERATOR_REPLY_REFUSAL. */
export type OperatorReplyFault =
  | "not_own_mailbox"
  | "not_a_reply"
  | "no_parent"
  | "parent_not_operator"
  | "parent_in_subject_thread"
  | "not_parent_thread"
  | "not_text";

/**
 * The fault in a seat's answer to the operator, or undefined when it is one.
 * `mailbox` is the node of the mailbox the row is in, `author` the node of the
 * seat that wrote it, `parent` the row `operatorReplyParentId` names as held
 * in that same mailbox. Every one of these holds of an answer:
 *  a) it is in its author's own mailbox;
 *  b) role agent, toNodeId operator, factoryMail, no taskId, no subject;
 *  c) the mail it answers is held in that mailbox, written by the operator;
 *  d) that mail is in no task or resource thread;
 *  e) its thread is that mail's thread;
 *  f) it carries text and nothing else: no other part, no attachments. The
 *     one exception is `metadata.raisedSignalId`, the signal this mail is the
 *     face of, and only as one ULID.
 */
export const operatorReplyFault = (
  row: { readonly mailbox: string; readonly author: string; readonly message: Message },
  parent: OperatorReplyParent | undefined,
): OperatorReplyFault | undefined => {
  const { message } = row;
  const metadata = message.metadata;
  if (row.author !== row.mailbox) return "not_own_mailbox";
  if (
    message.role !== "agent" ||
    metadata?.toNodeId !== "operator" ||
    metadata.factoryMail !== true ||
    message.taskId !== undefined ||
    metadata[THREAD_SUBJECT_KEY] !== undefined
  ) {
    return "not_a_reply";
  }
  if (parent === undefined || operatorReplyParentId(message) !== parent.message.messageId) return "no_parent";
  if (parent.actorSeatId !== OPERATOR_SEAT_ID) return "parent_not_operator";
  if (threadSubjectOf(parent.message) !== undefined || parent.message.metadata?.[THREAD_SUBJECT_KEY] !== undefined) {
    return "parent_in_subject_thread";
  }
  if (mailThreadOf(message) !== mailThreadOf(parent.message)) return "not_parent_thread";
  if (message.parts.some((part) => part.kind !== "text") || metadata.attachments !== undefined) return "not_text";
  const raised = metadata.raisedSignalId;
  if (raised !== undefined && (typeof raised !== "string" || !isUlid(raised))) return "not_text";
  return undefined;
};
