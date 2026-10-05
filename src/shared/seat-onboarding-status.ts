/**
 * Whether a seat's agent has onboarded: `junto onboard` ran, from the seat's
 * own process, in the harness session the seat is running now. The status
 * belongs to the harness session, so a resumed session keeps it and a fresh
 * one starts without it.
 *
 * Pure module, no Node imports (renderer-safe).
 */

export type SeatOnboardingStatus = "onboarded" | "not-onboarded";

/** One seat's status, keyed like seat state: by terminal binding. */
export type SeatOnboardingEvent = {
  readonly bindingId: string;
  readonly status: SeatOnboardingStatus;
  readonly at: number;
};

export const SEAT_ONBOARDING_LABEL: Readonly<Record<SeatOnboardingStatus, string>> = {
  onboarded: "Onboarded",
  "not-onboarded": "Not onboarded",
};

export type SeatOnboardNudgeResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

/**
 * Why the operator's nudge was not typed, in the operator's words. The
 * reasons are the drive's pre-write refusals: nothing reached the seat.
 */
export const onboardNudgeRefusal = (reason: string): string => {
  switch (reason) {
    case "seat-busy":
      return "The agent is mid-turn. Send the nudge when the turn ends.";
    case "composer-not-empty":
      return "There is a draft in this seat's composer. Send or clear it first.";
    case "operator-active":
      return "You are typing in this seat. Try again in a moment.";
    case "composer-unreadable":
    case "not-ready":
      return "Junto cannot read this seat's composer right now, so it will not type into it.";
    case "written-unresolved":
      return "An earlier prompt is still waiting in this seat's composer.";
    default:
      return "Junto could not send the nudge.";
  }
};
