import { Schema } from "effect";
import { ActorSeatId } from "./actor-seat";
import { mailAuthorOf, type MailAuthorKind } from "./mail-author";

/**
 * Who a stored mail is from, as delivery names it, and whether it takes a
 * reply. The authors are `mail-author.ts`'s closed union; a row is written
 * under its author's actor (`noticeActorRef`, `automationActorRef`, the
 * operator's or a seat's), and admission stamps `fromSeat` and
 * `senderNodeId` from that actor, never from the caller. So the author is
 * read back from those two stamps and the mailbox the row sits in, and no
 * other metadata can make a seat's mail read as a node's or the other way
 * round.
 *
 * A seat and the operator take replies. An automation and a resource's
 * notice are written from a node with no one to answer, and a malformed row
 * names no one: none of them take a reply, and their header can carry no
 * reply target, by type.
 *
 * Pure: no I/O.
 */

const isActorSeatId = Schema.is(ActorSeatId);

/**
 * The kind of a stored row's author in `mailbox`, from its admitted stamps.
 * A row from before seat ids, whose `fromSeat` names a node, was a seat's.
 */
export const storedMailAuthorKindOf = (
  message: { readonly metadata?: Readonly<Record<string, unknown>> | undefined },
  mailbox: string,
): MailAuthorKind => {
  const fromSeat = message.metadata?.fromSeat;
  const nodeId = message.metadata?.senderNodeId;
  if (!isActorSeatId(fromSeat)) return typeof fromSeat === "string" ? "seat" : "malformed";
  return mailAuthorOf({ seatId: fromSeat, nodeId: typeof nodeId === "string" ? nodeId : "" }, mailbox).kind;
};

/** Whether mail by an author of this kind takes a reply. */
export const authorTakesReply = (kind: MailAuthorKind): boolean => {
  switch (kind) {
    case "seat":
    case "operator":
      return true;
    case "automation":
    case "notice":
    case "malformed":
      return false;
  }
};

type Answerable = Extract<MailAuthorKind, "seat" | "operator">;

/**
 * The sender as a mail header names it, and where `junto msg reply` sends an
 * answer. Only a seat or the operator has one.
 */
export type MailHeaderSender =
  | { readonly kind: Answerable; readonly label: string; readonly replyTarget?: string }
  | { readonly kind: Exclude<MailAuthorKind, Answerable>; readonly label: string; readonly replyTarget?: never };
