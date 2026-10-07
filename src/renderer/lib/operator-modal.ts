import { observable } from "@legendapp/state";

/**
 * Operator modals: the surfaces that must always be reachable, above every
 * working modal (search, the needs-you feed). One slot holds the open one, so
 * opening a second swaps it and two never stack.
 *
 * The host (OperatorModalHost) renders the slot; the shell
 * (OperatorModalShell) owns the frame, focus and Escape. The chords that open
 * them are in the key table.
 *
 * A modal can also open another in its place and be come back to (the feed
 * opens a review from a card): see openOperatorModalFrom. That is still one
 * modal at a time: a swap out and a swap back, never a stack.
 */

export type OperatorModalId = "search" | "feed" | "git";

export const operatorModal$ = observable<{ open: OperatorModalId | null }>({ open: null });

/**
 * What a modal remembers of where it was left, so it can come back to the
 * same place. A modal with no entry here cannot be returned to.
 */
export type OperatorModalPlaces = {
  /** The card the operator was on, the cards open at the time, and how far the list was scrolled. */
  readonly feed: {
    readonly itemId: string;
    readonly expanded: ReadonlyArray<string>;
    readonly scrollTop: number;
  };
};

type ReturnableModalId = keyof OperatorModalPlaces;

type Detour = {
  [From in ReturnableModalId]: {
    readonly from: From;
    readonly to: OperatorModalId;
    readonly place: OperatorModalPlaces[From];
  };
}[ReturnableModalId];

// The modal that was left for another, while that other one is open.
let detour: Detour | null = null;
// The place a modal is coming back to, until that modal takes it.
let returning: Omit<Detour, "to"> | null = null;

// Where the keyboard was when the first operator modal opened. A swap keeps
// it, so closing the second modal still returns to the original place.
let opener: Element | null = null;

/** Where focus returns when the operator layer closes. */
export const operatorModalOpener = (): Element | null => opener;

export const OPERATOR_MODAL_OPEN_MEASURE = "operator-modal-open";
const OPEN_MARK = "operator-modal-open:start";

/** The operator asked for a modal: start the open clock. */
const markOperatorModalAsk = (): void => {
  if (typeof performance === "undefined") return;
  performance.clearMarks(OPEN_MARK);
  performance.mark(OPEN_MARK);
};

export const isOperatorModalOpen = (id?: OperatorModalId): boolean => {
  const open = operatorModal$.open.peek();
  return id === undefined ? open !== null : open === id;
};

export const openOperatorModal = (id: OperatorModalId): void => {
  if (operatorModal$.open.peek() === id) return;
  if (operatorModal$.open.peek() === null) {
    opener = typeof document === "undefined" ? null : document.activeElement;
  }
  // The operator went somewhere by their own chord. Back to the modal that
  // was left: it still comes back to its place. Anywhere else: the way back
  // is forgotten.
  returning = detour !== null && detour.from === id ? { from: detour.from, place: detour.place } as typeof returning : null;
  detour = null;
  markOperatorModalAsk();
  operatorModal$.open.set(id);
};

/**
 * Open `to` in place of the modal that is open now, and remember where that
 * one was left. When `to` closes, by Escape, its close button or the close
 * shortcut, the first modal opens again and takes its place back
 * (takeOperatorModalPlace). One modal at a time: this swaps, it never stacks.
 * Does nothing unless `from` is the modal that is open.
 */
export const openOperatorModalFrom = <From extends ReturnableModalId>(
  from: From,
  to: OperatorModalId,
  place: OperatorModalPlaces[From],
): void => {
  if (operatorModal$.open.peek() !== from || to === from) return;
  detour = { from, to, place } as Detour;
  returning = null;
  markOperatorModalAsk();
  operatorModal$.open.set(to);
};

/**
 * The place this modal is coming back to, once: call it as the modal mounts.
 * Undefined on an ordinary open, where the modal starts as it always does.
 */
export const takeOperatorModalPlace = <Id extends ReturnableModalId>(
  id: Id,
): OperatorModalPlaces[Id] | undefined => {
  if (returning === null || returning.from !== id) return undefined;
  const place = returning.place as OperatorModalPlaces[Id];
  returning = null;
  return place;
};

/**
 * Close the layer, or only `id` if it is the one that is open. A modal that
 * was opened from another one closes back to it.
 */
export const closeOperatorModal = (id?: OperatorModalId): void => {
  const open = operatorModal$.open.peek();
  if (open === null || (id !== undefined && open !== id)) return;
  if (detour !== null && detour.to === open) {
    returning = { from: detour.from, place: detour.place } as typeof returning;
    const back = detour.from;
    detour = null;
    markOperatorModalAsk();
    operatorModal$.open.set(back);
    return;
  }
  detour = null;
  returning = null;
  operatorModal$.open.set(null);
};

/** A modal's own chord closes it; another modal's chord swaps to it. */
export const toggleOperatorModal = (id: OperatorModalId): void => {
  if (operatorModal$.open.peek() === id) closeOperatorModal();
  else openOperatorModal(id);
};

/**
 * The modal's first frame is on screen: record ask to paint as a
 * performance measure named OPERATOR_MODAL_OPEN_MEASURE, with the modal id in
 * its detail.
 */
export const measureOperatorModalPainted = (id: OperatorModalId): void => {
  if (typeof performance === "undefined") return;
  if (performance.getEntriesByName(OPEN_MARK, "mark").length === 0) return;
  performance.measure(OPERATOR_MODAL_OPEN_MEASURE, { start: OPEN_MARK, detail: { modal: id } });
  performance.clearMarks(OPEN_MARK);
};
