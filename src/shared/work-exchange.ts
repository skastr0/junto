/**
 * The row exchange between two machines (docs/machines.md, rules 2 and 4 to 6).
 *
 * A row is a work fact, identified by its writer and sequence. Two machines
 * tell each other how far they are caught up, per canvas and writer, and each
 * sends the other what it lacks and is entitled to. The machine that edits a
 * canvas also sends each other machine its copy of it. Everything here is
 * pure: the frames, the closed list of rows that may cross, and the three
 * questions a receiver asks before it takes a row.
 *
 * A canvas is named in a frame by its name and its id. Two machines can each
 * have a canvas of one name; the id says which one a frame is about.
 */
import { Schema } from "effect";
import type { ActorSeatId } from "./actor-seat";
import {
  AgentSignalAttachment,
  AgentSignalDetail,
  AgentSignalKind,
  AgentSignalResponseText,
  AgentSignalSuggestions,
  AgentSignalText,
  SignalForm,
  SignalSource,
  WorkTiming,
} from "./agent-signals";
import { CanvasCopy } from "./canvas-copy";
import { commandRowEntitled } from "./command-row";
import { InstallationId } from "./installation-id";
import { purgeReaches } from "./shot-purge";
import { AUTOMATION_SEAT_ID, mailAuthorOf, type MailAuthor } from "./mail-author";
import { Seq } from "./model";
import { WorkCanvasName } from "./work-reference";
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
 * The rows that may cross machines: mail to a seat and its receipts, resource
 * commands and the editing machine's rulings on them. A fact of any other
 * kind, or one that leans on another fact, never crosses. Every reference
 * inside a row names the row's own canvas: its author, for a receipt the
 * mailbox and the mail it answers, for a command the canvas it is for.
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
        case "command.queued":
          return fact.body.command.canvasName === sink.canvasName || "a command is written on the canvas it is for";
        case "ruling.applied":
        case "ruling.refused":
          return true;
        case "shot.purged":
          return fact.item.kind === "purge" || "a purge is of a comment";
        case "seat.control":
          return fact.item.sink.nodeId === fact.body.seat || "a control is written at the seat it governs";
        case "seat.control.settled":
          return (
            fact.item.sink.nodeId === fact.body.automationNode || "a settled row answers at the automation's node"
          );
        case "automation.firing":
          return (
            fact.item.sink.nodeId === fact.body.automationNode || "a firing is written at the automation's node"
          );
        default:
          return "this kind of row does not cross machines";
      }
    }),
  ),
);
export type ExchangeFact = typeof ExchangeFact.Type;

const CanvasId = Schema.String.pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(128)));

/** How far the sender of this frame is caught up, per canvas and writer. */
export const HaveFrame = Schema.Struct({
  kind: Schema.Literal("have"),
  canvases: Schema.Array(
    Schema.Struct({
      canvasName: WorkCanvasName,
      canvasId: CanvasId,
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
  canvasId: CanvasId,
  writer: InstallationId,
  facts: Schema.Array(ExchangeFact).pipe(Schema.check(Schema.isMaxLength(EXCHANGE_MAX_FACTS_PER_FRAME))),
  through: ExchangeThrough,
});
export type RowsFrame = typeof RowsFrame.Type;

/**
 * A canvas, cut for the machine this frame is sent to. Only the machine that
 * edits a canvas sends its copy.
 */
export const CopyFrame = Schema.Struct({ kind: Schema.Literal("copy"), copy: CanvasCopy });
export type CopyFrame = typeof CopyFrame.Type;

/**
 * The answer to a copy this machine will not hold: it already has a canvas of
 * that name which is not this one, its own or another machine's.
 */
export const CopyRefusedFrame = Schema.Struct({
  kind: Schema.Literal("copy-refused"),
  canvasName: WorkCanvasName,
  canvasId: CanvasId,
  seq: Seq,
  reason: Schema.Literal("a-canvas-of-that-name"),
});
export type CopyRefusedFrame = typeof CopyRefusedFrame.Type;

export const EXCHANGE_MAX_SIGNALS_PER_FRAME = 32;
/** What one signal may name when it crosses: more than this, and the rest stay where it was raised. */
export const EXCHANGE_MAX_SIGNAL_ATTACHMENTS = 64;
/**
 * The largest file a crossing signal may name. A seat may attach a file of
 * any size, but the editing machine pulls what crosses when the operator
 * opens it, so a larger file stays on the seat's machine, unnamed here.
 */
export const EXCHANGE_MAX_SIGNAL_FILE_BYTES = 1024 * 1024 * 1024;

/** The files an attachment names, each within the crossing cap. */
export const signalAttachmentCrosses = (attachment: AgentSignalAttachment): boolean => {
  const files = !("kind" in attachment) ? [attachment.ref] : attachment.kind === "compare" ? [attachment.before, attachment.after] : [];
  return files.every((ref) => ref.byteLength <= EXCHANGE_MAX_SIGNAL_FILE_BYTES);
};
/**
 * The most a signals frame says, encoded, under the link's 1 MiB frame. A
 * signal that does not fit alone crosses without what it attached.
 */
export const EXCHANGE_SIGNALS_FRAME_BUDGET = 768 * 1024;

const Epoch = Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThanOrEqualTo(0)));

/**
 * A seat's signal to the operator, as its writer states it. The machine the
 * seat lives on writes the raise and a withdrawal; the machine that edits the
 * canvas writes an answer or a dismissal. What the seat attached crosses with
 * the raise as references, never bytes: the editing machine pulls a file from
 * the seat's machine when the operator opens it (content-pull.ts, owner kind
 * `signal`), and judges what it is from the bytes that arrive, never from the
 * reference's stated type.
 */
export const ExchangeSignal = Schema.Struct({
  signalId: Schema.String.pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(64))),
  nodeId: Schema.String.pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(1024))),
  kind: AgentSignalKind,
  text: AgentSignalText,
  detail: Schema.optionalKey(AgentSignalDetail),
  /**
   * Who raised it, when its work is due and what reply it asks for: the
   * operator's window may be on another machine, so a form or a due time has
   * to cross with the signal or the operator sees work with nothing to fill.
   */
  source: Schema.optionalKey(SignalSource),
  work: Schema.optionalKey(WorkTiming),
  form: Schema.optionalKey(SignalForm),
  /** The seat's pre-baked replies. */
  suggestions: Schema.optionalKey(AgentSignalSuggestions),
  /** What the seat attached, in its order, with the raise. */
  attachments: Schema.optionalKey(
    Schema.Array(AgentSignalAttachment).pipe(
      Schema.check(Schema.isMaxLength(EXCHANGE_MAX_SIGNAL_ATTACHMENTS)),
      Schema.check(Schema.makeFilter((attachments) => attachments.every(signalAttachmentCrosses) || "a crossing signal names a file over the crossing cap")),
    ),
  ),
  createdAt: Epoch,
  closing: Schema.optionalKey(
    Schema.Union([
      Schema.Struct({ state: Schema.Literals(["withdrawn", "dismissed"]), closedAt: Epoch }),
      Schema.Struct({
        state: Schema.Literal("answered"),
        closedAt: Epoch,
        response: Schema.Struct({ text: AgentSignalResponseText, at: Epoch }),
      }),
    ]),
  ),
});
export type ExchangeSignal = typeof ExchangeSignal.Type;

/** Signals of the seats of one canvas, each as the sender of this frame may state it. */
export const SignalsFrame = Schema.Struct({
  kind: Schema.Literal("signals"),
  canvasName: WorkCanvasName,
  canvasId: CanvasId,
  signals: Schema.Array(ExchangeSignal).pipe(Schema.check(Schema.isMaxLength(EXCHANGE_MAX_SIGNALS_PER_FRAME))),
});
export type SignalsFrame = typeof SignalsFrame.Type;

export const ExchangeFrame = Schema.Union([HaveFrame, RowsFrame, CopyFrame, CopyRefusedFrame, SignalsFrame]);
export type ExchangeFrame = typeof ExchangeFrame.Type;

export const decodeExchangeFrame = Schema.decodeUnknownResult(ExchangeFrame, { onExcessProperty: "error" });

/** A frame as it goes on the wire, in the shape an older build still reads. */
export const encodeExchangeFrame = Schema.encodeSync(ExchangeFrame);

/** Where the seats of one canvas live, as one machine holds it. */
export type CanvasPlacement = {
  /** Which canvas of that name this is. */
  readonly canvasId: string;
  /** The machine that may change the canvas; it keeps all of it. */
  readonly editor: InstallationId;
  /**
   * The canvas's committed authority list as this machine's log states it,
   * oldest position first (0.11/06 F3): the machines that keep the canvas
   * whole and relay its rows. Absent reads as the editor alone, which is
   * every canvas until the operator lists a fallback.
   */
  readonly authorities?: ReadonlyArray<InstallationId>;
  /** Does this machine hold the canvas: it edits it, one of its seats or automations is on it, or it is departing. */
  readonly holds: (machine: InstallationId) => boolean;
  /** The seat at a node: its identity and the machine it lives on. Undefined for a node that is no seat. */
  readonly seatOf: (
    nodeId: string,
  ) => { readonly seatId: ActorSeatId; readonly machine: InstallationId } | undefined;
  /** A node's name as this machine's copy of the canvas gives it, for the words of a notice written here. */
  readonly nameOf?: (nodeId: string) => string | undefined;
  /**
   * The machine an automation of an Automations node runs on, by its id.
   * Undefined for an automation this machine does not know there.
   */
  readonly automationOf?: (nodeId: string, automationId: string) => InstallationId | undefined;
  /**
   * A machine that lost its last seat or automation here and has not yet been
   * told: it still holds the canvas, so it takes the rulings that moved them
   * (an automation's runner stops only when its move is folded there).
   */
  readonly departing?: (machine: InstallationId) => boolean;
};

/**
 * The machine that rules the canvas now. Until fleet state (plan 0.11/06)
 * lands, that is the machine that edits it; this is the one place that changes.
 */
export const authorityOf = (placement: Pick<CanvasPlacement, "editor">): InstallationId => placement.editor;

/**
 * The canvas's committed authority list, oldest position first (0.11/06 F3):
 * who keeps it whole and relays its rows, as this machine's log states it.
 * `authorityOf` names who rules; this names who may take over, keep and
 * relay. A placement that names none is the editor alone.
 */
export const authoritiesOf = (placement: Pick<CanvasPlacement, "editor" | "authorities">): ReadonlyArray<InstallationId> =>
  placement.authorities === undefined || placement.authorities.length === 0 ? [placement.editor] : placement.authorities;

/**
 * What a machine may state of a signal to a peer, or nothing. The machine the
 * seat lives on tells the machine that edits the canvas of the raise and of a
 * withdrawal. The editing machine tells the seat's machine of an answer or a
 * dismissal. No other pair exchanges a signal.
 */
export const signalStatedTo = (
  from: InstallationId,
  to: InstallationId,
  signal: ExchangeSignal,
  placement: CanvasPlacement,
): ExchangeSignal | undefined => {
  const home = placement.seatOf(signal.nodeId)?.machine;
  if (home === undefined || from === to) return undefined;
  const { closing, ...raised } = signal;
  if (from === home && to === placement.editor) {
    return closing?.state === "withdrawn" ? signal : raised;
  }
  if (from === placement.editor && to === home) {
    // The seat's machine wrote what was attached; the operator's closing is all it lacks.
    const { attachments: _attachments, ...closed } = signal;
    return closing !== undefined && closing.state !== "withdrawn" ? closed : undefined;
  }
  return undefined;
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
 * Who wrote this row, by kind. Mail and a command may have an operator or an
 * automation author; a receipt under either identity is malformed. A ruling
 * is the editing machine's own row and has no author here: its writer is
 * checked before any author is.
 */
export const rowAuthorOf = (fact: ExchangeFact): MailAuthor => {
  const { body } = fact;
  switch (body.operation) {
    case "message.append":
      return mailAuthorOf(body.sentBy, fact.item.sink.nodeId);
    case "delivery.accepted": {
      const author = mailAuthorOf(body.receipt.actor);
      return author.kind === "seat" ? author : { kind: "malformed" };
    }
    case "command.queued": {
      // A command names its actor's kind outright, so no identity stands in for it.
      const { actor } = body.command;
      switch (actor.kind) {
        case "seat":
          return mailAuthorOf(actor).kind === "seat"
            ? { kind: "seat", seatId: actor.seatId, nodeId: actor.nodeId }
            : { kind: "malformed" };
        case "operator":
          return { kind: "operator" };
        case "automation":
          // Under the identity automation mail carries, so its node and id are checked the same way.
          return mailAuthorOf({ seatId: AUTOMATION_SEAT_ID, nodeId: actor.nodeId, automationId: actor.automationId });
        default: {
          const unreachable: never = actor;
          return unreachable;
        }
      }
    }
    case "ruling.applied":
    case "ruling.refused":
      return { kind: "malformed" };
    case "shot.purged":
      // Only the operator purges a shot, and only on the machine that edits the canvas.
      return { kind: "operator" };
    case "seat.control":
    case "seat.control.settled":
      // The row's own schema binds its actor to the automation, or to the seat
      // it answers for, so the author is the automation or that seat.
      return mailAuthorOf(body.actor);
    case "automation.firing":
      // Only the automation runs its firings, under the identity automation
      // mail carries, so its node and id are checked the same way.
      return mailAuthorOf({
        seatId: AUTOMATION_SEAT_ID,
        nodeId: body.automationNode,
        automationId: body.automationId,
      });
    default:
      return { kind: "malformed" };
  }
};

/**
 * The one machine this author writes on, or none. A seat writes on the
 * machine it lives on, under that seat's own identity, and an automation on
 * the machine it names, under its node and its id, never on a seat's node.
 * The operator writes only on the machine that edits the canvas, and so does
 * an automation's mail from before 0.11, which names no automation. A
 * resource's notice is written by the machine of the seat it is for, into
 * that seat's mailbox.
 */
export const authorWritesOn = (author: MailAuthor, placement: CanvasPlacement): InstallationId | undefined => {
  switch (author.kind) {
    case "seat": {
      const seat = placement.seatOf(author.nodeId);
      return seat !== undefined && seat.seatId === author.seatId ? seat.machine : undefined;
    }
    case "operator":
      return placement.editor;
    case "automation":
      // Never under a seat's node: a mail would name that seat as its sender.
      // An automation's own machine; mail from before 0.11 names no automation, and was the editor's.
      if (placement.seatOf(author.nodeId) !== undefined) return undefined;
      return author.automationId === undefined ? placement.editor : placement.automationOf?.(author.nodeId, author.automationId);
    case "notice":
      // Written by the machine of the seat whose mailbox it is in, from a node that is no seat's.
      return placement.seatOf(author.nodeId) === undefined ? placement.seatOf(author.mailbox)?.machine : undefined;
    case "malformed":
      return undefined;
    default: {
      const unreachable: never = author;
      return unreachable;
    }
  }
};

/** Was this row written on the machine its author writes on? */
export const writtenByItsAuthor = (
  fact: ExchangeFact,
  placement: CanvasPlacement,
): boolean => {
  const machine = authorWritesOn(rowAuthorOf(fact), placement);
  return machine !== undefined && machine === fact.id.route.eventHome;
};

/**
 * Does the machine that edits the canvas refuse this row from every peer? It
 * does for an author only it writes for (the operator, an automation that
 * names no automation) and for one no machine writes for. A seat's row, an
 * automation's and a notice it judges against where that seat or automation
 * was at the canvas count the row states (`judgedAt`).
 */
export const editorTakesFromNoPeer = (fact: ExchangeFact): boolean => {
  const author = rowAuthorOf(fact);
  switch (author.kind) {
    case "seat":
    case "notice":
      return false;
    case "automation":
      return author.automationId === undefined;
    case "operator":
    case "malformed":
      return true;
    default: {
      const unreachable: never = author;
      return unreachable;
    }
  }
};

/**
 * The seat or automation whose placement the editing machine judges a row
 * by: the author seat itself, under its own identity, an automation by its
 * node and id, or for a notice the seat whose mailbox it is in, by node. A
 * notice's own node must hold no seat now nor at the stated count
 * (`seatless`), nor may an automation's. None for an author only the editing
 * machine writes, or no machine does.
 */
export const judgedAt = (
  fact: ExchangeFact,
  placement: CanvasPlacement,
):
  | { readonly nodeId: string; readonly seatId?: ActorSeatId; readonly seatless?: string; readonly automationId?: undefined }
  | { readonly nodeId: string; readonly automationId: string }
  | undefined => {
  const author = rowAuthorOf(fact);
  switch (author.kind) {
    case "seat":
      return { nodeId: author.nodeId, seatId: author.seatId };
    case "notice":
      return placement.seatOf(author.nodeId) === undefined
        ? { nodeId: author.mailbox, seatless: author.nodeId }
        : undefined;
    case "automation":
      return author.automationId === undefined || placement.seatOf(author.nodeId) !== undefined
        ? undefined
        : { nodeId: author.nodeId, automationId: author.automationId };
    case "operator":
    case "malformed":
      return undefined;
    default: {
      const unreachable: never = author;
      return unreachable;
    }
  }
};

/** Who wrote the mail a receipt answers: its node, and for an automation its id. */
export type ReceiptMailAuthor = { readonly nodeId: string; readonly automationId?: string };

/**
 * Is this machine entitled to the row? The machine that rules the canvas
 * (`authorityOf`) gets every row of it. Any other machine gets the mail
 * addressed to its seats, the receipts for mail its seats or automations
 * wrote, every ruling, and every shot purge (`purgeReaches`); never another
 * machine's command, which stays pending only where it was written.
 * `mailAuthor` is the author of the mail a receipt answers, when the caller
 * holds that mail.
 */
export const entitledTo = (
  machine: InstallationId,
  fact: ExchangeFact,
  placement: CanvasPlacement,
  mailAuthor?: ReceiptMailAuthor,
): boolean => {
  const authority = authorityOf(placement);
  if (machine === authority) return true;
  switch (fact.body.operation) {
    case "command.queued":
    case "ruling.applied":
    case "ruling.refused":
      return commandRowEntitled(machine, authority, fact.body);
    case "shot.purged":
      return purgeReaches(machine);
    case "seat.control":
      // For the seat's machine; the listed machines already took it above.
      return placement.seatOf(fact.body.seat)?.machine === machine;
    case "seat.control.settled":
      // For the automation's machine, where its firing waits to resolve.
      return placement.automationOf?.(fact.body.automationNode, fact.body.automationId) === machine;
    case "automation.firing":
      // For the machine that edits the canvas, and for the listed machines
      // once fleet state lists them (0.11/06).
      return authoritiesOf(placement).includes(machine);
  }
  if (fact.body.operation === "message.append") {
    return placement.seatOf(fact.item.sink.nodeId)?.machine === machine;
  }
  if (mailAuthor === undefined) return false;
  const home = mailAuthor.automationId === undefined
    ? placement.seatOf(mailAuthor.nodeId)?.machine
    : placement.automationOf?.(mailAuthor.nodeId, mailAuthor.automationId);
  return home === machine;
};
