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
import type { MailHold } from "./mail-hold";

/** How long held mail waits before its seat's fact is told. */
export const MAIL_WAITING_AFTER_MS = 30 * 60_000;

export type MailWaitingFact = {
  readonly canvasName: string;
  readonly nodeId: string;
  /** Mails held on this seat for MAIL_WAITING_AFTER_MS or more; 0 clears the fact. */
  readonly count: number;
  /** Epoch ms when the oldest of them first waited. Absent when cleared. */
  readonly heldSince?: number;
  /** Why the oldest of them waits now. Absent when cleared. */
  readonly hold?: MailHold;
};
