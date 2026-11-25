/**
 * Is the operator's answer held: kept from its seat because the seat withdrew
 * the signal before the answer arrived? One rule, run by delivery before it
 * types a mail and by any read that shows the mail (`answerHeld`), so the two
 * cannot drift (remote-security's terms for Race C, step 77).
 *
 * The answer mail and the withdrawal cross on different channels, so either
 * may land first; delivery decides on what this machine holds then. The rule
 * reads both faces of the crossing, so a read on either machine agrees: the
 * seat's machine holds the signal withdrawn, the editing machine holds it
 * answered with the seat's `withdrawnAt` beside it, and on both the answer
 * goes unreceipted. The editing machine's Boat keeper reads it too, and never
 * wakes a machine for an answer that machine will hold. An answer
 * typed while the signal was still open is correct, and the withdrawal came
 * after it. A held mail stays readable in its thread, marked in fixed words,
 * and is never stamped delivered: the operator learns of the crossing from
 * the signal's `withdrawnAt` on the editing machine, never from a receipt.
 *
 * Pure, no Node imports.
 */
import type { AgentSignal } from "./wire/agent-signals";
import type { Message } from "./work-model";
import { isMessageDelivered, isMessageRead } from "./message-delivery";
import { OPERATOR_SEAT_ID } from "./work-reference";

/** The fixed words a held answer is marked with, wherever it is shown or logged. */
export const ANSWER_HELD_WORDS = "withdrawn before the answer arrived";

/** The mailbox the mail is in: the seat it was sent to. */
export type AnswerHeldMailbox = {
  readonly canvasName: string;
  readonly nodeId: string;
};

/**
 * Held only when every one holds: the mail is the operator's (its stored
 * author, `metadata.fromSeat`, so no seat can silence another seat's mail);
 * it names a signal (`metadata.agentSignalId`) that this machine holds as
 * `signal`; that signal is the mailbox seat's own, raised by no automation;
 * it is withdrawn (the seat's machine), or answered with `withdrawnAt` (the
 * editing machine); and the mail has no delivery or read receipt. On the
 * editing machine an answer typed before the withdrawal whose receipt has not
 * crossed yet also reads held until the receipt lands; it needs no wake. Anything
 * else is ordinary mail and is delivered as it is today: an id this machine
 * does not hold, another seat's signal, or one still open.
 */
export const answerHeld = (
  mailbox: AnswerHeldMailbox,
  message: Message,
  signal: Pick<AgentSignal, "signalId" | "canvasName" | "nodeId" | "state" | "source" | "withdrawnAt"> | undefined,
): boolean => {
  const metadata = message.metadata;
  if (signal === undefined || metadata === undefined) return false;
  return (
    metadata.fromSeat === OPERATOR_SEAT_ID &&
    metadata.agentSignalId === signal.signalId &&
    signal.canvasName === mailbox.canvasName &&
    signal.nodeId === mailbox.nodeId &&
    signal.source === undefined &&
    (signal.state === "withdrawn" || (signal.state === "answered" && signal.withdrawnAt !== undefined)) &&
    !isMessageDelivered(message) &&
    !isMessageRead(message)
  );
};

/** The signal id a mail names as the one it answers, when it names one. */
export const answeredSignalIdOf = (message: Pick<Message, "metadata">): string | undefined => {
  const id = message.metadata?.agentSignalId;
  return typeof id === "string" && id.length > 0 ? id : undefined;
};
