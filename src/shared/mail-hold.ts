/**
 * Why mail waits in the mailbox with nothing typed. The composer says three
 * of them (see `composer-availability.ts`); the seat's status says the rest,
 * once delivery is admitted against it (`term/drive/mail-admission.ts`).
 *
 *   draft        the operator is composing in the input box
 *   dialog       the harness is asking something: a permission, a question,
 *                a dialog
 *   unreadable   the probes cannot read the input box
 *   busy         the seat is starting, compacting or retrying, and typed text
 *                would be lost to it
 *   stopped      the seat hit a usage limit or an error that stops it
 *   unsupported  the seat's harness has no way to take mail in its state
 */
import { Schema } from "effect";
import type { ComposerHold } from "./composer-availability";

export type SeatMailHold = "busy" | "stopped" | "unsupported";

/** Every hold, on the wire as in the model. */
export const MailHold = Schema.Literals(["draft", "dialog", "unreadable", "busy", "stopped", "unsupported"]);
export type MailHold = typeof MailHold.Type;

// The Schema names exactly the composer's holds and the seat's.
const sameHolds: [MailHold] extends [ComposerHold | SeatMailHold] ? ([ComposerHold | SeatMailHold] extends [MailHold] ? true : false) : false = true;
void sameHolds;
