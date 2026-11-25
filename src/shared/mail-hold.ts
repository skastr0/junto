/**
 * Why mail waits in the mailbox with nothing typed. The composer says three
 * of them (see `composer-availability.ts`); the seat's status says three more,
 * once delivery is admitted against it (`term/drive/mail-admission.ts`); and
 * delivery says the last, once its tries to start the seat are spent.
 *
 *   draft        the operator is composing in the input box
 *   dialog       the harness is asking something: a permission, a question,
 *                a dialog
 *   unreadable   the probes cannot read the input box
 *   busy         the seat is starting, compacting or retrying, and typed text
 *                would be lost to it
 *   stopped      the seat hit a usage limit or an error that stops it
 *   unsupported  the seat's harness has no way to take mail in its state
 *   unstarted    the seat is down and every try to start it for its mail
 *                failed (`MAIL_WAKE_RETRY_MS`)
 */
import { Schema } from "effect";
import type { ComposerHold } from "./composer-availability";

export type SeatMailHold = "busy" | "stopped" | "unsupported";

/** The hold delivery itself tells: the seat could not be started. */
export type WakeMailHold = "unstarted";

/** Every hold, on the wire as in the model. */
export const MailHold = Schema.Literals(["draft", "dialog", "unreadable", "busy", "stopped", "unsupported", "unstarted"]);
export type MailHold = typeof MailHold.Type;

// The Schema names exactly the composer's holds, the seat's and delivery's own.
const sameHolds: [MailHold] extends [ComposerHold | SeatMailHold | WakeMailHold] ? ([ComposerHold | SeatMailHold | WakeMailHold] extends [MailHold] ? true : false) : false = true;
void sameHolds;
