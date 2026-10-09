/**
 * The row exchange between two machines (docs/machines.md, rules 4 to 6).
 *
 * A row is a work fact, identified by its writer and sequence. Two machines
 * tell each other how far they are caught up, per canvas and writer, and each
 * sends the other what it lacks and is entitled to. Everything here is pure:
 * the frames, the closed list of rows that may cross, and the three questions
 * a receiver asks before it takes a row.
 */
import { Schema } from "effect";
import type { ActorSeatId } from "./actor-seat";
import { InstallationId } from "./installation-id";
import { WorkCanvasName, OPERATOR_SEAT_ID, operatorActorRef } from "./work-reference";
import { WorkFact } from "./work-protocol";

export const EXCHANGE_MAX_FACTS_PER_FRAME = 64;

const OPERATOR_NODE_ID = operatorActorRef("").nodeId;

/** A sequence a machine is caught up through; zero is "nothing yet". */
export const ExchangeThrough = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^(0|[1-9][0-9]*)$/)),
  Schema.check(Schema.isMaxLength(32)),
);
export type ExchangeThrough = typeof ExchangeThrough.Type;

export const compareSequence = (left: string, right: string): number =>
  left.length !== right.length ? left.length - right.length : left < right ? -1 : left > right ? 1 : 0;

/**
 * The rows that may cross machines: mail to a seat and its receipts. A fact of
 * any other kind, or one that leans on another fact, never crosses. Every
 * reference inside a row names the row's own canvas: its author, and for a
 * receipt the mailbox and the mail it answers.
 */
export const ExchangeFact = WorkFact.pipe(
  Schema.check(
    Schema.makeFilter((fact) => {
      if (fact.basis.kind !== "canvas") return "a row states the canvas its writer saw";
      if (fact.basis.canvasName !== fact.item.sink.canvasName) return "a row states its own canvas";
      if (fact.predecessor !== null) return "a row stands alone";
      const { sink } = fact.item;
      switch (fact.body.operation) {
        case "message.append":
          if (fact.body.destination.kind !== "mailbox") return "only mail to a seat crosses machines";
          return fact.body.sentBy.canvasName === sink.canvasName || "mail is written on the canvas it is sent on";
        case "delivery.accepted": {
          const { receipt } = fact.body;
          return (
            (receipt.deliveredItem.kind === "message" &&
              receipt.deliveredItem.sink.canvasName === sink.canvasName &&
              receipt.deliveredItem.sink.nodeId === sink.nodeId &&
              receipt.actor.canvasName === sink.canvasName &&
              receipt.actor.nodeId === sink.nodeId) ||
            "a receipt is the receiving seat's own, for mail in its own mailbox"
          );
        }
        default:
          return "this kind of row does not cross machines";
      }
    }),
  ),
);
export type ExchangeFact = typeof ExchangeFact.Type;

/** How far the sender of this frame is caught up, per canvas and writer. */
export const HaveFrame = Schema.Struct({
  kind: Schema.Literal("have"),
  canvases: Schema.Array(
    Schema.Struct({
      canvasName: WorkCanvasName,
      writers: Schema.Array(Schema.Struct({ writer: InstallationId, through: ExchangeThrough })),
    }),
  ),
});
export type HaveFrame = typeof HaveFrame.Type;

/**
 * Rows of one writer for one canvas, in sequence order. `through` is the
 * sender's word that the receiver now has every row of that writer and canvas
 * it is entitled to, up to that sequence.
 */
export const RowsFrame = Schema.Struct({
  kind: Schema.Literal("rows"),
  canvasName: WorkCanvasName,
  writer: InstallationId,
  facts: Schema.Array(ExchangeFact).pipe(Schema.check(Schema.isMaxLength(EXCHANGE_MAX_FACTS_PER_FRAME))),
  through: ExchangeThrough,
});
export type RowsFrame = typeof RowsFrame.Type;

export const ExchangeFrame = Schema.Union([HaveFrame, RowsFrame]);
export type ExchangeFrame = typeof ExchangeFrame.Type;

export const decodeExchangeFrame = Schema.decodeUnknownResult(ExchangeFrame, { onExcessProperty: "error" });

/** Where the seats of one canvas live, as one machine holds it. */
export type CanvasPlacement = {
  /** The machine that may change the canvas; it keeps all of it. */
  readonly editor: InstallationId;
  /** Does this machine hold the canvas: it edits it, or one of its seats is on it. */
  readonly holds: (machine: InstallationId) => boolean;
  /** The seat at a node: its identity and the machine it lives on. Undefined for a node that is no seat. */
  readonly seatOf: (
    nodeId: string,
  ) => { readonly seatId: ActorSeatId; readonly machine: InstallationId } | undefined;
};

/** Who a row says wrote it: the receiving seat of a receipt, the sender of mail. */
const authorOf = (fact: ExchangeFact): { readonly seatId: ActorSeatId; readonly nodeId: string } => {
  if (fact.body.operation === "delivery.accepted") return fact.body.receipt.actor;
  if (fact.body.operation !== "message.append") throw new Error("not an exchanged row");
  return fact.body.sentBy;
};

/**
 * May this peer hand over rows written by this writer for this canvas? Only a
 * machine that holds the canvas, and then only the writer itself or the
 * machine that edits that exact canvas.
 */
export const peerMayPassOn = (
  peer: InstallationId,
  writer: InstallationId,
  placement: CanvasPlacement,
): boolean => placement.holds(peer) && (peer === writer || peer === placement.editor);

/**
 * Was this row written where its author lives? Mail and receipts of a seat
 * come only from that seat's machine and carry that seat's own identity; the
 * operator's mail comes only from the machine that edits the canvas.
 */
export const writtenByItsAuthor = (
  fact: ExchangeFact,
  placement: CanvasPlacement,
): boolean => {
  const writer = fact.id.route.eventHome;
  const author = authorOf(fact);
  if (author.seatId === OPERATOR_SEAT_ID || author.nodeId === OPERATOR_NODE_ID) {
    return (
      fact.body.operation === "message.append" &&
      author.seatId === OPERATOR_SEAT_ID &&
      author.nodeId === OPERATOR_NODE_ID &&
      writer === placement.editor
    );
  }
  const seat = placement.seatOf(author.nodeId);
  return seat !== undefined && seat.machine === writer && seat.seatId === author.seatId;
};

/**
 * Is this machine entitled to the row? The editing machine gets every row of
 * its canvas. Any other machine gets the mail addressed to its seats, and the
 * receipts for mail its seats wrote. `mailAuthorNodeId` is the author of the
 * mail a receipt answers, when the caller holds that mail.
 */
export const entitledTo = (
  machine: InstallationId,
  fact: ExchangeFact,
  placement: CanvasPlacement,
  mailAuthorNodeId?: string,
): boolean => {
  if (machine === placement.editor) return true;
  if (fact.body.operation === "message.append") {
    return placement.seatOf(fact.item.sink.nodeId)?.machine === machine;
  }
  return mailAuthorNodeId !== undefined && placement.seatOf(mailAuthorNodeId)?.machine === machine;
};
