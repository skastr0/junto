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

/** Why a nudge the operator asked for was not typed. Nothing reached the seat. */
export type OnboardNudgeRefusal = "dialog" | "draft" | "unreadable" | "unavailable";

export const onboardNudgeRefusal = (reason: OnboardNudgeRefusal): string => {
  switch (reason) {
    case "dialog":
      return "This seat is showing a dialog. Answer it first, then send the nudge.";
    case "draft":
      return "There is a draft in this seat's composer. Send or clear it first.";
    case "unreadable":
      return "Junto cannot read this seat's input box right now. Check its terminal.";
    case "unavailable":
      return "This seat's terminal is not ready to be typed into yet.";
  }
};
