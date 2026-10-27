import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { SurfaceKeyId } from "../../shared/key-table";
import { claimFocus, isOperatorTyping } from "./focus-ownership";
import { keyIs } from "./key-match";
import { topModal } from "./modal-stack";

/**
 * List navigation: the one way a list in Junto moves with the keyboard (the
 * needs-you feed, the artifacts, the tasks). J or Down for the next row, K or
 * Up for the previous, Home and End for the ends, Enter to open. The chords
 * come from the key table ("Inside a list"); a list keeps its own state and
 * its own extra keys, and hands the moves to `useListNav`.
 *
 * They are bare keys, so they act only with the keyboard in the list and not
 * in a field, a menu or a combobox there.
 */

export type ListMove = "next" | "previous" | "first" | "last";
export type ListIntent = ListMove | "open";

const INTENTS: ReadonlyArray<readonly [SurfaceKeyId, ListIntent]> = [
  ["inList.next", "next"],
  ["inList.previous", "previous"],
  ["inList.first", "first"],
  ["inList.last", "last"],
  ["inList.open", "open"],
];

/** Keys that land here belong to the control, never to the list. */
const OWN_KEYS_SELECTOR = "[role='listbox'], [role='combobox'], [role='menu'], [role='textbox']";

type ListKeyEvent = Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "target" | "defaultPrevented"> & {
  readonly code?: string;
  readonly isComposing?: boolean;
};

const closestOf = (target: EventTarget | null, selector: string): Element | null => {
  const closest = (target as { closest?: (selector: string) => Element | null } | null)?.closest;
  return typeof closest === "function" ? closest.call(target, selector) : null;
};

/** What a keydown means to a list, or null when it is not the list's. */
export const listIntentOf = (event: ListKeyEvent): ListIntent | null => {
  if (event.defaultPrevented || event.isComposing) return null;
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  if (isOperatorTyping(event.target)) return null;
  if (closestOf(event.target, OWN_KEYS_SELECTOR) !== null) return null;
  for (const [id, intent] of INTENTS) if (keyIs(event, id)) return intent;
  return null;
};

/**
 * The row a move lands on, clamped to the list. With nothing picked, or the
 * pick gone, next starts at the top and previous at the bottom.
 */
export const stepList = (ids: ReadonlyArray<string>, current: string | null, move: ListMove): string | null => {
  if (ids.length === 0) return null;
  if (move === "first") return ids[0]!;
  if (move === "last") return ids[ids.length - 1]!;
  const index = current === null ? -1 : ids.indexOf(current);
  if (index === -1) return ids[move === "next" ? 0 : ids.length - 1]!;
  return ids[Math.min(ids.length - 1, Math.max(0, index + (move === "next" ? 1 : -1)))]!;
};

/** The attribute a row carries so the keyboard can find it again after a redraw. */
export const LIST_ROW_ATTRIBUTE = "data-list-row";

export type ListNav = {
  /** For the list's container: the moves, heard anywhere inside it. */
  readonly onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
  /** For each row's focusable element. */
  readonly rowProps: (id: string) => { readonly [LIST_ROW_ATTRIBUTE]: string };
};

export const useListNav = ({
  ids,
  selected,
  onSelect,
  onOpen,
  follow = true,
}: {
  /** The rows in reading order, only those a move can land on. */
  readonly ids: ReadonlyArray<string>;
  readonly selected: string | null;
  readonly onSelect: (id: string) => void;
  /** Enter on a row. Absent: Enter is left to the row itself. */
  readonly onOpen?: (id: string) => void;
  /** Put the keyboard on the row a move lands on. Off for a list whose rows are not focusable. */
  readonly follow?: boolean;
}): ListNav => {
  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>): void => {
    const intent = listIntentOf(event.nativeEvent);
    if (intent === null) return;
    // The row with the keyboard counts as the pick, so Tab then a move reads naturally.
    const rowId = closestOf(event.target, `[${LIST_ROW_ATTRIBUTE}]`)?.getAttribute(LIST_ROW_ATTRIBUTE);
    const from = rowId != null && ids.includes(rowId) ? rowId : selected;
    if (intent === "open") {
      if (onOpen === undefined || from === null) return;
      event.preventDefault();
      onOpen(from);
      return;
    }
    const next = stepList(ids, from, intent);
    if (next === null) return;
    event.preventDefault();
    onSelect(next);
    if (!follow) return;
    // A pick can redraw the list, its container included: find the row again once it shows.
    requestAnimationFrame(() => {
      const scope = topModal()?.container() ?? document.body;
      const row = scope.querySelector<HTMLElement>(`[${LIST_ROW_ATTRIBUTE}="${CSS.escape(next)}"]`);
      claimFocus(row, "gesture", { preventScroll: false });
      row?.scrollIntoView({ block: "nearest" });
    });
  };
  return { onKeyDown, rowProps: (id) => ({ [LIST_ROW_ATTRIBUTE]: id }) };
};
