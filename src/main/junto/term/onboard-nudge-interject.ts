/**
 * How the onboarding nudge reaches a seat: interjected through the drive's
 * mail gate, whatever the seat is doing, the way mail is typed.
 *
 * Two things stand before the drive, and both must be right for a nudge that
 * is due mid-turn:
 *
 *  - Mail readiness is a latch: a seat's terminal is "ready" from the first
 *    moment its TUI is up and settled idle, and that moment is only recorded
 *    when something looks. Mail looks when it has mail for the seat. A fresh
 *    seat nobody has mailed is first looked at when its first turn starts,
 *    mid-turn, where a first look can never say ready. So readiness is looked
 *    at on every seat event (`watchSeatReadiness`), and the idle moment before
 *    the operator's first message is on record when the nudge comes due.
 *
 *  - The drive's gate holds for the operator's fresh keystrokes, a draft, a
 *    dialog or an unread box, and announces when the hold clears; the
 *    supervisor listens for that and sends what it was holding.
 */
import type { AgentSeatStateEvent } from "@shared/agent-seat-state";
import type { OnboardNudgeRefusal } from "@shared/seat-onboarding-status";
import type { MailWriteOutcome } from "./drive";

export type OnboardNudgeOutcome = "written" | OnboardNudgeRefusal;

export const makeOnboardNudgeInterject =
  (deps: {
    readonly suspended: () => boolean;
    /** The seat's terminal can take a paste now (mail readiness). */
    readonly mailReady: (bindingId: string) => boolean;
    readonly writeMail: (bindingId: string, text: string) => Promise<MailWriteOutcome>;
  }) =>
  async (bindingId: string, text: string): Promise<OnboardNudgeOutcome> => {
    if (deps.suspended() || !deps.mailReady(bindingId)) return "unavailable";
    // The drive's mail gate is the one check on the input box: it types only
    // into an available one and says why it did not.
    const outcome = await deps.writeMail(bindingId, text);
    return outcome === "lost" ? "unavailable" : outcome;
  };

/**
 * Look at a seat's mail readiness whenever its state is told, so the first
 * ready moment of a generation is recorded when it happens rather than when
 * something first has a reason to type. Returns the unsubscribe.
 */
export const watchSeatReadiness = (input: {
  readonly subscribeSeatState: (listener: (event: AgentSeatStateEvent) => void) => () => void;
  readonly mailReady: (bindingId: string) => boolean;
}): (() => void) =>
  input.subscribeSeatState((event) => {
    if (event.state !== "gone") input.mailReady(event.bindingId);
  });
