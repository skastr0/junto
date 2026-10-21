import { Schema } from "effect";
import { ActorSeatId } from "./actor-seat";
import type { MailSenderStamp } from "./crew";
import { AUTOMATION_SEAT_ID, NOTICE_SEAT_ID, mailAuthorOf, type AutomationNodeId, type MailAuthorKind } from "./mail-author";

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
 * A row from before seat ids, whose `fromSeat` names a node or is absent
 * beside a `senderNodeId`, was a seat's.
 * Without the mailbox a notice reads as malformed; neither takes a reply.
 */
export const storedMailAuthorKindOf = (
  message: { readonly metadata?: Readonly<Record<string, unknown>> | undefined },
  mailbox?: string,
): MailAuthorKind => {
  const fromSeat = message.metadata?.fromSeat;
  const nodeId = message.metadata?.senderNodeId;
  if (!isActorSeatId(fromSeat)) return typeof fromSeat === "string" || typeof nodeId === "string" ? "seat" : "malformed";
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

/** A header sender of `kind`: the reply target kept only when the kind takes a reply. */
export const mailHeaderSender = (kind: MailAuthorKind, label: string, replyTarget?: string): MailHeaderSender => {
  switch (kind) {
    case "seat":
    case "operator":
      return { kind, label, ...(replyTarget === undefined ? {} : { replyTarget }) };
    case "automation":
    case "notice":
    case "malformed":
      return { kind, label };
  }
};

/**
 * The stamp a resource's notice carries, as `mailExtensionMetadata` takes it:
 * written under NOTICE_SEAT_ID from the resource's node. Admission stamps
 * `fromSeat` and `senderNodeId` again from the writer; these let the row
 * read as mail before it is admitted.
 */
export const noticeSenderStamp = (nodeId: string, name: string): MailSenderStamp => ({
  fromSeat: NOTICE_SEAT_ID,
  senderNodeId: nodeId,
  senderName: name,
  senderGeneration: "notice",
  senderHarness: "unknown",
});

/** The stamp an automation's mail carries: written under AUTOMATION_SEAT_ID from its own node. */
export const automationSenderStamp = (nodeId: AutomationNodeId, name: string): MailSenderStamp => ({
  fromSeat: AUTOMATION_SEAT_ID,
  senderNodeId: nodeId,
  senderName: name,
  senderGeneration: "automation",
  senderHarness: "unknown",
});
