import { observable } from "@legendapp/state";

/**
 * Operator modals: the surfaces that must always be reachable, above every
 * working modal (search, the needs-you feed). One slot holds the open one, so
 * opening a second swaps it and two never stack.
 *
 * The host (OperatorModalHost) renders the slot; the shell
 * (OperatorModalShell) owns the frame, focus and Escape. The chords that open
 * them are in the key table.
 */

export type OperatorModalId = "search" | "feed";

export const operatorModal$ = observable<{ open: OperatorModalId | null }>({ open: null });

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
  markOperatorModalAsk();
  operatorModal$.open.set(id);
};

/** Close the layer, or only `id` if it is the one that is open. */
export const closeOperatorModal = (id?: OperatorModalId): void => {
  const open = operatorModal$.open.peek();
  if (open === null || (id !== undefined && open !== id)) return;
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
