import { Schema } from "effect";
import { ActorSeatId } from "./actor-seat";
import type { NodeId } from "./model/base";
import { OPERATOR_SEAT_ID, operatorActorRef, type ActorRef } from "./work-reference";

/**
 * Who a mail is from, closed: a seat, the operator, or a node. A node (a task
 * refusing a command, an automation) writes notices and takes no reply
 * (plan 0.10, 02 and 07).
 *
 * Every mailbox row is written under an actor seat id (`work_messages.actor_seat_id`)
 * and admission stamps `fromSeat` and `senderNodeId` from it, never from the
 * caller. A node has no seat, so it writes under {@link NODE_SENDER_SEAT_ID},
 * a stable non-executable identity like the operator's: no credential derives
 * it, so it can never act or claim work. The kind is read back from the
 * stamped `fromSeat` alone, so a client's metadata cannot make a seat's mail
 * read as a node's or the other way round.
 *
 * Pure: no I/O.
 */

export type MailFrom =
  | { readonly kind: "seat"; readonly actor: ActorRef }
  | { readonly kind: "operator"; readonly canvasName: string }
  | { readonly kind: "node"; readonly canvasName: string; readonly nodeId: NodeId; readonly name: string };

export type MailFromKind = MailFrom["kind"];

/** The actor seat id every node-sent row is written under. Never a principal. */
export const NODE_SENDER_SEAT_ID = Schema.decodeUnknownSync(ActorSeatId)(`seat_${"d".repeat(64)}`);

/** The actor a row from `from` is written under: admission stamps the sender from it. */
export const mailWriterOf = (from: MailFrom): ActorRef => {
  switch (from.kind) {
    case "seat":
      return from.actor;
    case "operator":
      return operatorActorRef(from.canvasName);
    case "node":
      return { seatId: NODE_SENDER_SEAT_ID, canvasName: from.canvasName, nodeId: from.nodeId };
  }
};

/**
 * The name a node-sent row carries for its header: admission keeps
 * `senderName` as written, and stamps `fromSeat` and `senderNodeId` itself.
 */
export const nodeSenderMetadata = (from: Extract<MailFrom, { kind: "node" }>): { readonly senderName: string } => ({
  senderName: from.name,
});

/** Whose a stored row is, read from its admitted `fromSeat`. */
export const mailFromKindOf = (message: {
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}): MailFromKind => {
  const fromSeat = message.metadata?.fromSeat;
  if (fromSeat === NODE_SENDER_SEAT_ID) return "node";
  if (fromSeat === OPERATOR_SEAT_ID) return "operator";
  return "seat";
};

/**
 * The sender as a mail header names it, and where `junto msg reply` sends an
 * answer. A node takes no reply: its header has no target, by type.
 */
export type MailHeaderSender =
  | { readonly kind: "seat"; readonly label: string; readonly replyTarget?: string }
  | { readonly kind: "operator"; readonly label: string; readonly replyTarget?: string }
  | { readonly kind: "node"; readonly label: string; readonly replyTarget?: never };
