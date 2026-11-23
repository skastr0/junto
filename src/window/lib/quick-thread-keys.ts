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
  /** Choose the active option, a seat or a whole region, and move the keyboard to the message. */
  | "pick"
  /** Choose the active option and stay in the seat field for another. */
  | "pickAnother"
  /** The active option is a region: show only its seats, to pick some of them. */
  | "narrow"
  /** Nothing to pick, a seat already chosen: on to the message. */
  | "write"
  /** Enter with nothing to pick and nowhere to go: say why nothing happened. */
  | "nothing"
  /** Take the last chosen seat or region off, a region as one token. */
  | "unpick"
  /** Show every seat again: the list was narrowed to a region. Before any seat comes off. */
  | "widen";

export type QuickThreadKeyState = {
  /** What the seat field holds; empty when nothing is typed. */
  readonly query: string;
  /** An option is active in the seat list. */
  readonly active: boolean;
  /** What the active option is; a seat when not said. */
  readonly activeKind?: "seat" | "region";
  /** How many recipients are chosen, seats and regions. */
  readonly chosen: number;
  /** The list is narrowed to a region. */
  readonly narrowed?: boolean;
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
  if (keyIs(event, "inQuickThread.narrow", mac)) return state.active && state.activeKind === "region" ? "narrow" : null;
  if (keyIs(event, "inQuickThread.another", mac)) return state.active ? "pickAnother" : null;
  if (keyIs(event, "inQuickThread.pick", mac)) {
    if (state.active) return "pick";
    if (state.query === "" && state.chosen > 0) return "write";
    // No seat chosen, or a query that matches nothing: say why.
    return "nothing";
  }
  if (keyIs(event, "inQuickThread.unpick", mac)) {
    if (state.query !== "") return null;
    // The region goes before any seat does.
    if (state.narrowed === true) return "widen";
    return state.chosen > 0 ? "unpick" : null;
  }
  return null;
};

// --- what a screen reader hears ----------------------------------------------

const counted = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * The count, for the combobox's description: "2 seats chosen", "1 region
 * and 2 seats chosen". A region counts as one; its own count is the
 * region token's to say.
 */
export const chosenSeatsSpoken = (seats: number, regions = 0): string => {
  if (seats === 0 && regions === 0) return "No seat chosen";
  if (regions === 0) return `${counted(seats, "seat", "seats")} chosen`;
  if (seats === 0) return `${counted(regions, "region", "regions")} chosen`;
  return `${counted(regions, "region", "regions")} and ${counted(seats, "seat", "seats")} chosen`;
};

export type QuickThreadChange =
  /** `seat` is the name of what was chosen, a seat or a region; `regions` counts the regions among `chosen`. */
  | { readonly kind: "added"; readonly seat: string; readonly chosen: number; readonly regions?: number }
  | { readonly kind: "removed"; readonly seat: string; readonly chosen: number; readonly regions?: number }
  | { readonly kind: "narrowed"; readonly region: string; readonly seats: number }
  /** The region was taken off: every seat shows again. */
  | { readonly kind: "widened"; readonly region: string }
  /** Enter with no seat chosen; `query` is what the seat field holds. */
  | { readonly kind: "nothing"; readonly query: string }
  /** Enter in the message with no seat chosen yet. */
  | { readonly kind: "noSeat" };

/** The line the polite live region says after a change in Quick thread. */
export const quickThreadSpoken = (change: QuickThreadChange): string => {
  switch (change.kind) {
    case "added":
      return `${change.seat} added, ${chosenOf(change)}`;
    case "removed":
      return `${change.seat} taken off, ${chosenOf(change)}`;
    case "narrowed":
      return `${change.region}, ${change.seats === 1 ? "1 seat" : `${change.seats} seats`}`;
    case "widened":
      return `Every seat, not only ${change.region}`;
    case "nothing":
      return change.query === "" ? "Pick a seat first" : `No seat matches ${change.query}`;
    case "noSeat":
      return "Pick a seat first";
  }
};

function chosenOf(change: { readonly chosen: number; readonly regions?: number }): string {
  const regions = change.regions ?? 0;
  return chosenSeatsSpoken(change.chosen - regions, regions).toLowerCase();
}

/** The name of a chosen seat's remove control. */
export const unpickSpoken = (seat: string): string => `Take ${seat} off`;
