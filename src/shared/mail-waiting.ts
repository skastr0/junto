/**
 * Mail waiting on a seat for long enough that someone should look: the fact
 * the operator feed shows, one per seat, while held mail there has waited
 * MAIL_WAITING_AFTER_MS or more. It clears when that mail is typed or stops
 * waiting (read, gone, or its seat moved to another machine).
 *
 * A fact, not a signal: main never raises a signal for a seat. It names the
 * seat, how many mails wait, since when, and why the oldest waits; never a
 * mail's text, sender or id. Pure, no Node imports.
 */
import { Schema } from "effect";
import type { MailHold } from "./mail-hold";

/** How long held mail waits before its seat's fact is told. */
export const MAIL_WAITING_AFTER_MS = 30 * 60_000;

/** Why held mail waits, as `MailHold` names it: the composer's three holds and the seat's three. */
const MailHoldWire = Schema.Literals(["draft", "dialog", "unreadable", "busy", "stopped", "unsupported"]);

export const MailWaitingFact = Schema.Struct({
  canvasName: Schema.String,
  nodeId: Schema.String,
  /** Mails held on this seat for MAIL_WAITING_AFTER_MS or more; 0 clears the fact. */
  count: Schema.Number,
  /** Epoch ms when the oldest of them first waited. Absent when cleared. */
  heldSince: Schema.optionalKey(Schema.Number),
  /** Why the oldest of them waits now. Absent when cleared. */
  hold: Schema.optionalKey(MailHoldWire),
});
export type MailWaitingFact = typeof MailWaitingFact.Type;

// The wire names exactly the holds the model has.
const sameHolds: [MailHold] extends [typeof MailHoldWire.Type] ? ([typeof MailHoldWire.Type] extends [MailHold] ? true : false) : false = true;
void sameHolds;
