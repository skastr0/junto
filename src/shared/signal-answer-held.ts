/**
 * Is the operator's answer held: kept from its seat because the seat withdrew
 * the signal before the answer arrived? One rule, run by delivery before it
 * types a mail and by any read that shows the mail (`answerHeld`), so the two
 * cannot drift (remote-security's terms for Race C, step 77).
 *
 * The answer mail and the withdrawal cross on different channels, so either
 * may land first; delivery decides on what this machine holds then. An answer
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
 * it is withdrawn; and the mail has no delivery or read receipt. Anything
 * else is ordinary mail and is delivered as it is today: an id this machine
 * does not hold, another seat's signal, or one still open.
 */
export const answerHeld = (
  mailbox: AnswerHeldMailbox,
  message: Message,
  signal: Pick<AgentSignal, "signalId" | "canvasName" | "nodeId" | "state" | "source"> | undefined,
): boolean => {
  const metadata = message.metadata;
  if (signal === undefined || metadata === undefined) return false;
  return (
    metadata.fromSeat === OPERATOR_SEAT_ID &&
    metadata.agentSignalId === signal.signalId &&
    signal.canvasName === mailbox.canvasName &&
    signal.nodeId === mailbox.nodeId &&
    signal.source === undefined &&
    signal.state === "withdrawn" &&
    !isMessageDelivered(message) &&
    !isMessageRead(message)
  );
};

/** The signal id a mail names as the one it answers, when it names one. */
export const answeredSignalIdOf = (message: Pick<Message, "metadata">): string | undefined => {
  const id = message.metadata?.agentSignalId;
  return typeof id === "string" && id.length > 0 ? id : undefined;
};
