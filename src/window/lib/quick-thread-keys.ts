import type { KeyEventLike } from "../../shared/key-table";
import { keyIs } from "./key-match";

/**
 * Quick thread's keys: what a keydown means in its seat field or its
 * message, read from the key table ("Inside quick thread"), so the help and
 * the screen say the same. The path runs without the mouse: a seat, another
 * seat, the message, send.
 *
 * The seat field is a combobox: the keyboard stays in it, and the option the
 * arrows land on is its active descendant. Escape is the modal stack's,
 * never this screen's. A key with no intent here is left to the field.
 */

export type QuickThreadField = "seats" | "message";

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
  /** Take the last chosen seat off. */
  | "unpick"
  /** One new thread per chosen seat. */
  | "send";

export type QuickThreadKeyState = {
  /** What the seat field holds; empty when nothing is typed. */
  readonly query: string;
  /** An option is active in the seat list. */
  readonly active: boolean;
  /** How many seats are chosen. */
  readonly chosen: number;
  /** The message has something to send: text, files or images. */
  readonly ready: boolean;
};

type QuickThreadKeyEvent = KeyEventLike & {
  readonly defaultPrevented?: boolean;
  readonly isComposing?: boolean;
};

const seatIntent = (event: QuickThreadKeyEvent, state: QuickThreadKeyState, mac?: boolean): QuickThreadIntent | null => {
  if (keyIs(event, "inQuickThread.move", mac)) return event.key === "ArrowDown" ? "next" : "previous";
  if (keyIs(event, "inQuickThread.another", mac)) return state.active ? "pickAnother" : null;
  if (keyIs(event, "inQuickThread.pick", mac)) {
    if (state.active) return "pick";
    // Enter with nothing to pick moves on; Tab then is plain Tab.
    return event.key === "Enter" && state.query === "" && state.chosen > 0 ? "write" : null;
  }
  if (keyIs(event, "inQuickThread.unpick", mac)) return state.query === "" && state.chosen > 0 ? "unpick" : null;
  return null;
};

/** What a keydown means to Quick thread, or null when it is the field's own. */
export const quickThreadIntentOf = (
  event: QuickThreadKeyEvent,
  field: QuickThreadField,
  state: QuickThreadKeyState,
  mac?: boolean,
): QuickThreadIntent | null => {
  if (event.defaultPrevented || event.isComposing) return null;
  if (field === "seats") return seatIntent(event, state, mac);
  return keyIs(event, "inQuickThread.send", mac) && state.chosen > 0 && state.ready ? "send" : null;
};
