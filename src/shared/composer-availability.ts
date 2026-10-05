/**
 * Composer availability: may Junto type into this seat's input box now?
 *
 * One predicate for everything that types into a seat without the operator
 * asking: mail and the onboarding nudge. Two readings decide, and either one
 * is enough to hold:
 *
 *   seat attention        → dialog      the harness is asking something;
 *                                       never typed into, whatever the
 *                                       composer probes read
 *   composer empty        → available   the probes prove an empty input box
 *   composer draft        → draft       text is in the box; the caller decides
 *                                       whose it is
 *   composer unread       → unreadable  startup, a transition, or chrome the
 *                                       probes do not know
 *
 * Attention is checked first and is one-directional: it can only hold. The
 * composer reading is still needed without it, because a dialog can sit on a
 * seat whose state reads idle (Claude's folder-trust and login prompts do),
 * and there the unread box is what keeps a paste and Enter out of it.
 */

export type ComposerAvailability = "available" | "draft" | "dialog" | "unreadable";

/** Why a seat's input box is not typeable. */
export type ComposerHold = Exclude<ComposerAvailability, "available">;

export const composerAvailability = (
  verdict: "empty" | "draft" | null,
  seatState: string | undefined,
): ComposerAvailability => {
  if (seatState === "attention") return "dialog";
  if (verdict === "empty") return "available";
  if (verdict === "draft") return "draft";
  return "unreadable";
};
