import type { KeyEventLike } from "../../shared/key-table";
import { keyIs } from "./key-match";

/**
 * Quick thread's seat field: what a keydown means there, read from the key
 * table ("Inside quick thread"), so the help and the screen say the same,
 * and what a screen reader hears after it. The path runs without the mouse:
 * a seat, another seat, the message, send.
 *
 * The seat field is a combobox: the keyboard stays in it, and the option the
 * arrows land on is its active descendant. Tab is the house combobox's
 * (lib/combobox): it moves on. The message is a thread input and sends as
 * every thread does ("inThread.send"). Escape is the modal stack's. A key
 * with no intent here is left to the field.
 */

export type QuickThreadIntent =
  /** Move the active option down or up. */
  | "next"
  | "previous"
  /** Pick the active option and move the keyboard to the message; a region narrows the list instead. */
  | "pick"
  /** Pick the active option and stay in the seat field for another. */
  | "pickAnother"
  /** Nothing to pick, a seat already chosen: on to the message. */
  | "write"
  /** Enter with nothing to pick and no seat chosen: say why nothing happened. */
  | "nothing"
  /** Take the last chosen seat off. */
  | "unpick";

export type QuickThreadKeyState = {
  /** What the seat field holds; empty when nothing is typed. */
  readonly query: string;
  /** An option is active in the seat list. */
  readonly active: boolean;
  /** How many seats are chosen. */
  readonly chosen: number;
};

type QuickThreadKeyEvent = KeyEventLike & {
  readonly defaultPrevented?: boolean;
  readonly isComposing?: boolean;
};

/** What a keydown in the seat field means, or null when it is the field's own. */
export const quickThreadIntentOf = (
  event: QuickThreadKeyEvent,
  state: QuickThreadKeyState,
  mac?: boolean,
): QuickThreadIntent | null => {
  if (event.defaultPrevented || event.isComposing) return null;
  if (keyIs(event, "inQuickThread.move", mac)) return event.key === "ArrowDown" ? "next" : "previous";
  if (keyIs(event, "inQuickThread.another", mac)) return state.active ? "pickAnother" : null;
  if (keyIs(event, "inQuickThread.pick", mac)) {
    if (state.active) return "pick";
    if (state.query === "" && state.chosen > 0) return "write";
    return state.chosen === 0 ? "nothing" : null;
  }
  if (keyIs(event, "inQuickThread.unpick", mac)) return state.query === "" && state.chosen > 0 ? "unpick" : null;
  return null;
};

// --- what a screen reader hears ----------------------------------------------

/** The count, for the combobox's description: "2 seats chosen". */
export const chosenSeatsSpoken = (chosen: number): string =>
  chosen === 0 ? "No seat chosen" : chosen === 1 ? "1 seat chosen" : `${chosen} seats chosen`;

export type QuickThreadChange =
  | { readonly kind: "added"; readonly seat: string; readonly chosen: number }
  | { readonly kind: "removed"; readonly seat: string; readonly chosen: number }
  | { readonly kind: "narrowed"; readonly region: string; readonly seats: number }
  /** Enter with no seat chosen; `query` is what the seat field holds. */
  | { readonly kind: "nothing"; readonly query: string }
  /** Enter in the message with no seat chosen yet. */
  | { readonly kind: "noSeat" };

/** The line the polite live region says after a change in Quick thread. */
export const quickThreadSpoken = (change: QuickThreadChange): string => {
  switch (change.kind) {
    case "added":
      return `${change.seat} added, ${chosenSeatsSpoken(change.chosen).toLowerCase()}`;
    case "removed":
      return `${change.seat} taken off, ${chosenSeatsSpoken(change.chosen).toLowerCase()}`;
    case "narrowed":
      return `${change.region}, ${change.seats === 1 ? "1 seat" : `${change.seats} seats`}`;
    case "nothing":
      return change.query === "" ? "Pick a seat first" : `No seat matches ${change.query}`;
    case "noSeat":
      return "Pick a seat first";
  }
};

/** The name of a chosen seat's remove control. */
export const unpickSpoken = (seat: string): string => `Take ${seat} off`;
