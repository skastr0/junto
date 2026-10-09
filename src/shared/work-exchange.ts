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
import { InstallationId } from "./installation-id";
import { WorkCanvasName, OPERATOR_SEAT_ID } from "./work-reference";
import { WorkFact } from "./work-protocol";

export const EXCHANGE_MAX_FACTS_PER_FRAME = 64;

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
 * any other kind, or one that leans on another fact, never crosses.
 */
export const ExchangeFact = WorkFact.pipe(
  Schema.check(
    Schema.makeFilter((fact) => {
      if (fact.basis.kind !== "canvas") return "a row states the canvas its writer saw";
      if (fact.basis.canvasName !== fact.item.sink.canvasName) return "a row states its own canvas";
      if (fact.predecessor !== null) return "a row stands alone";
      switch (fact.body.operation) {
        case "message.append":
          return fact.body.destination.kind === "mailbox" || "only mail to a seat crosses machines";
        case "delivery.accepted": {
          const { receipt } = fact.body;
          return (
            (receipt.deliveredItem.kind === "message" &&
              receipt.deliveredItem.sink.canvasName === receipt.actor.canvasName &&
              receipt.deliveredItem.sink.nodeId === receipt.actor.nodeId) ||
            "a receipt is the receiving seat's own"
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
  /** The machine a seat lives on, by node id; undefined for a node that is no seat. */
  readonly machineOf: (nodeId: string) => InstallationId | undefined;
};

/** The node whose machine must be the writer of this row. */
const authorOf = (fact: ExchangeFact): { readonly operator: boolean; readonly nodeId: string } => {
  if (fact.body.operation === "delivery.accepted") {
    return { operator: false, nodeId: fact.body.receipt.actor.nodeId };
  }
  if (fact.body.operation !== "message.append") throw new Error("not an exchanged row");
  return {
    operator: fact.body.sentBy.seatId === OPERATOR_SEAT_ID,
    nodeId: fact.body.sentBy.nodeId,
  };
};

/**
 * May this peer hand over rows written by this writer for this canvas? Only
 * the writer itself, or the machine that edits that exact canvas.
 */
export const peerMayPassOn = (
  peer: InstallationId,
  writer: InstallationId,
  placement: CanvasPlacement,
): boolean => peer === writer || peer === placement.editor;

/**
 * Was this row written where its author lives? Mail and receipts of a seat
 * come only from that seat's machine; the operator's mail only from the
 * machine that edits the canvas.
 */
export const writtenByItsAuthor = (
  fact: ExchangeFact,
  placement: CanvasPlacement,
): boolean => {
  const writer = fact.id.route.eventHome;
  const author = authorOf(fact);
  return author.operator
    ? writer === placement.editor
    : placement.machineOf(author.nodeId) === writer;
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
    return placement.machineOf(fact.item.sink.nodeId) === machine;
  }
  return mailAuthorNodeId !== undefined && placement.machineOf(mailAuthorNodeId) === machine;
};
