import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import {
  claimFocus,
  isOperatorTyping,
  pickPrimaryFocusControl,
  recentGestureKind,
  setFocusFence,
} from "./focus-ownership";

/**
 * The modal stack: one order for every open modal shell, so "topmost" has a
 * single answer. Shells (FocusSurface, ui Dialog, OperatorModalShell) join it
 * through useModalLayer and get the same three behaviours from it:
 *
 * - Escape reaches only the topmost modal.
 * - Tab cycles inside the topmost modal.
 * - Closing returns focus to where it was when the modal opened.
 *
 * Order is by layer first (see styles/layers.css), then by open order.
 */

export type ModalLayer = "working" | "working-dialog" | "operator" | "operator-dialog";

const LAYER_RANK: Record<ModalLayer, number> = {
  working: 1,
  "working-dialog": 2,
  operator: 3,
  // A dialog opened from inside an operator modal: above it.
  "operator-dialog": 4,
};

export type ModalEntry = {
  readonly layer: ModalLayer;
  readonly container: () => HTMLElement | null;
  /** Tab stays inside this modal. */
  readonly trap: boolean;
  /** Escape arrived for this modal. False: it is not this modal's to take. */
  readonly onEscape: () => boolean;
  /** Close this modal outright, whatever Escape means inside it. */
  readonly onClose: () => void;
};

type Stacked = ModalEntry & { readonly seq: number };

const stack: Stacked[] = [];
let nextSeq = 0;

/** Pure order: the highest layer wins, the latest opened breaks a tie. */
export const topOf = <T extends { readonly layer: ModalLayer; readonly seq: number }>(
  entries: ReadonlyArray<T>,
): T | undefined => {
  let top: T | undefined;
  for (const entry of entries) {
    if (
      !top ||
      LAYER_RANK[entry.layer] > LAYER_RANK[top.layer] ||
      (LAYER_RANK[entry.layer] === LAYER_RANK[top.layer] && entry.seq > top.seq)
    ) {
      top = entry;
    }
  }
  return top;
};

export const topModal = (): ModalEntry | undefined => topOf(stack);

/** The layer of the front modal, or null with nothing open: the canvas is in front. */
export const frontModalLayer = (): ModalLayer | null => topOf(stack)?.layer ?? null;

/**
 * Close the front modal: the topmost one, by layer then by open order. This
 * is what "front" means for a close command. Unlike Escape it does not ask
 * the modal: a terminal keeps Escape for its program, but it still closes.
 * Returns false when nothing is open.
 */
export const closeFrontModal = (): boolean => {
  const top = topOf(stack);
  if (!top) return false;
  top.onClose();
  return true;
};

/** True while any modal of this layer is open. */
export const isModalLayerOpen = (layer: ModalLayer): boolean =>
  stack.some((entry) => entry.layer === layer);

/** What counts as a tab stop, for every shell and floating panel. */
export const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[contenteditable]:not([contenteditable='false'])",
  "[tabindex]:not([tabindex='-1'])",
].join(", ");

type TabStop = { readonly getClientRects?: () => { readonly length: number } };

/**
 * Where Tab lands inside a modal. Returns null when the browser's own move
 * already stays inside, so the trap only acts at the two ends.
 */
export const nextTabStop = <T extends TabStop>(
  stops: ReadonlyArray<T>,
  active: unknown,
  backwards: boolean,
): T | null => {
  const visible = stops.filter(
    (stop) => typeof stop.getClientRects !== "function" || stop.getClientRects().length > 0,
  );
  const first = visible[0];
  const last = visible[visible.length - 1];
  if (!first || !last) return null;
  const index = visible.indexOf(active as T);
  if (index < 0) return backwards ? last : first;
  if (backwards) return active === first ? last : null;
  return active === last ? first : null;
};

const isPageRoot = (node: unknown): boolean =>
  node === null || node === document.body || node === document.documentElement;

/**
 * The subject of the working modal `from` sits in: the field the operator
 * types into there (a terminal, a composer), or null when the modal has
 * none. Chrome around a subject only borrows the keyboard: when what it
 * opened closes, the keyboard goes back to the subject, not to the button.
 */
export const subjectOf = (from: Element | null): HTMLElement | null => {
  const surface = from?.closest?.("[data-focus-surface]") ?? null;
  if (!surface) return null;
  // A surface with several subjects (a grid of terminals): the one last in
  // use, never just the first on screen.
  const last = lastSubject.get(surface);
  if (last && last.isConnected && surface.contains(last)) return last;
  const primary = pickPrimaryFocusControl(surface);
  return primary !== null && isOperatorTyping(primary) ? primary : null;
};

const lastSubject = new WeakMap<Element, HTMLElement>();

// The element text actually goes into. Narrower than isOperatorTyping, which
// counts a whole terminal surface, header buttons included, as typing ground.
const TEXT_ENTRY_SELECTOR =
  "textarea, [contenteditable]:not([contenteditable='false']), input:not([type='button']):not([type='submit']):not([type='reset']):not([type='checkbox']):not([type='radio']):not([type='range']):not([type='file'])";

/** A field the operator types into took focus inside `surface`: it is the subject in use. */
export const noteSubjectInUse = (surface: Element, field: HTMLElement): void => {
  if (field.matches(TEXT_ENTRY_SELECTOR)) lastSubject.set(surface, field);
};

/**
 * Read as something opens: did the opener only borrow the keyboard? A
 * pointer press on a button moves focus there as a side effect, so the
 * keyboard still belongs to the subject. Reaching the button with the
 * keyboard and pressing Enter is the operator putting focus there on
 * purpose, and it comes back there.
 */
export const openerBorrowedKeyboard = (): boolean => recentGestureKind() === "pointer";

/**
 * Something opened from `opener` has closed. Unless the operator has put
 * focus somewhere on purpose since, return the keyboard: to the subject of
 * the opener's modal when the opener only borrowed it, else to the opener.
 */
export const returnKeyboardFrom = (opener: Element | null, borrowed: boolean): void => {
  if (!opener) return;
  const active = document.activeElement;
  if (!isPageRoot(active) && active !== opener && !opener.contains(active)) return;
  const target = (borrowed ? subjectOf(opener) : null) ?? (opener as HTMLElement);
  if (target.isConnected) claimFocus(target, "open", { preventScroll: true });
};

const takeEscape = (event: KeyboardEvent, top: ModalEntry): void => {
  if (!top.onEscape()) return;
  event.preventDefault();
  event.stopPropagation();
};

/**
 * Focus fell out of every surface (the focused element was removed, or the
 * window was clicked back into). The next key still belongs to the topmost
 * modal: Escape closes it, anything else puts the keyboard back inside it
 * and is then heard there.
 */
const onPageKey = (event: KeyboardEvent): void => {
  // A key another handler already used (a chord that just opened a modal)
  // is spent, and focus may have moved inside since the key was pressed.
  if (event.defaultPrevented || !isPageRoot(document.activeElement)) return;
  if (!isPageRoot(event.target) && event.target !== window) return;
  const top = topModal();
  const container = top?.container();
  if (!top || !container) return;
  if (event.key === "Escape" && top.onEscape()) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  // Anything else, and an Escape the shell itself does not take, goes back
  // inside: the body may have its own rule for it.
  if (!top.trap) return;
  if (event.key === "Meta" || event.key === "Control" || event.key === "Shift" || event.key === "Alt") return;
  if (!claimFocus(container, "gesture", { event, preventScroll: true })) return;
  // The key was meant for the modal: play it again from inside, so the
  // body's own keys (and the Tab trap) still hear it.
  event.preventDefault();
  event.stopPropagation();
  container.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: event.key,
      code: event.code,
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      shiftKey: event.shiftKey,
      repeat: event.repeat,
      bubbles: true,
      cancelable: true,
    }),
  );
};

/**
 * Escape pressed while focus sits somewhere under the topmost modal (a
 * canvas node, the pinned dock). Bubble phase: a field that uses Escape
 * itself stops the event first, as it always could.
 */
const onOutsideEscape = (event: KeyboardEvent): void => {
  if (event.key !== "Escape" || isPageRoot(event.target) || event.target === window) return;
  const top = topModal();
  const container = top?.container();
  if (!top || !container) return;
  if (event.target instanceof Node && container.contains(event.target)) return;
  takeEscape(event, top);
};

/**
 * The fence the focus authority asks: while the topmost modal traps the
 * keyboard, a claim may land inside it or in something floating above the
 * app (its popovers and menus), never in a modal under it or in the app
 * itself. A surface still finishing its own open cannot pull focus back out
 * of a modal that opened over it.
 */
const fenceAllows = (target: HTMLElement): boolean => {
  const top = topOf(stack);
  const container = top?.container();
  if (!top || !top.trap || !container || container.contains(target)) return true;
  for (const entry of stack) {
    if (entry !== top && entry.container()?.contains(target)) return false;
  }
  const app = document.getElementById("root");
  return !(app !== null && app.contains(target) && !app.contains(container));
};

let listening = false;
const ensureListening = (): void => {
  if (listening || typeof window === "undefined") return;
  listening = true;
  setFocusFence(fenceAllows);
  // focus-law: acts only while a modal is open and focus sits on the page itself, never in a field.
  window.addEventListener("keydown", onPageKey, { capture: true });
  // focus-law: Escape-only close of the topmost modal.
  window.addEventListener("keydown", onOutsideEscape);
};

// What floats above a modal and stays live with it: popovers, menus and
// tooltips portal to the body as its siblings.
const FLOATING_SELECTOR =
  "[data-layer='popover'], [data-layer='operator-popover'], [data-popover-layer]:not([data-layer]), [data-canvas-menu-surface], [role='tooltip'], [role='menu'], [role='listbox'], script, style, link";

const INERT_MARK = "data-modal-inert";

/**
 * Everything under the front modal is inert: not focusable, not clickable,
 * and not read by a screen reader. Under a modal that takes the whole
 * window, that is the app and every other modal. Under a docked surface,
 * which shares the window with live chrome, it is the canvas it covers, so
 * Tab can never land on something that cannot be seen.
 */
const syncInert = (): void => {
  if (typeof document === "undefined") return;
  const want = new Set<Element>();
  const top = topOf(stack);
  const container = top?.container() ?? null;
  if (top && container) {
    if (top.trap) {
      for (const child of Array.from(document.body.children)) {
        if (child.contains(container) || child.matches(FLOATING_SELECTOR)) continue;
        want.add(child);
      }
    } else {
      // The canvas itself, wherever it sits in the tree: the surface may be
      // wrapped (an error boundary), so its siblings are not the place to look.
      for (const canvas of Array.from(document.querySelectorAll(".react-flow"))) {
        if (!canvas.contains(container) && !container.contains(canvas)) want.add(canvas);
      }
    }
  }
  for (const marked of Array.from(document.querySelectorAll(`[${INERT_MARK}]`))) {
    if (want.has(marked)) continue;
    marked.removeAttribute("inert");
    marked.removeAttribute(INERT_MARK);
  }
  for (const element of want) {
    // Never take over an inert someone else set.
    if (element.hasAttribute(INERT_MARK) || element.hasAttribute("inert")) continue;
    element.setAttribute("inert", "");
    element.setAttribute(INERT_MARK, "");
  }
};

/** Join the stack. `leave` takes the modal out; `isTop` asks if it is topmost. */
export const pushModal = (
  entry: ModalEntry,
): { readonly leave: () => void; readonly isTop: () => boolean } => {
  ensureListening();
  const stacked: Stacked = { ...entry, seq: nextSeq++ };
  stack.push(stacked);
  syncInert();
  return {
    leave: () => {
      const index = stack.indexOf(stacked);
      if (index >= 0) stack.splice(index, 1);
      syncInert();
    },
    isTop: () => topOf(stack) === stacked,
  };
};

/** Test seam: forget every open modal. */
export const resetModalStack = (): void => {
  stack.length = 0;
  syncInert();
};

/**
 * One modal shell's membership of the stack. Spread `onKeyDown` on the shell
 * root: it gives the body's own handlers first say, then applies Escape and
 * the Tab trap, and for an isolating modal keeps every key from reaching the
 * layers underneath.
 */
export const useModalLayer = ({
  layer,
  containerRef,
  trap = true,
  isolate = true,
  onEscape,
  onClose,
  returnFocusTo,
  keepFocusOnClose,
  onKeyDown,
}: {
  readonly layer: ModalLayer;
  readonly containerRef: RefObject<HTMLElement | null>;
  /**
   * False for a surface that shares the screen with live chrome (a docked
   * work surface beside the pinned dock): it joins the Escape order only.
   */
  readonly trap?: boolean;
  /**
   * No key pressed inside reaches the layers underneath. False for working
   * modals, whose bodies still use app-wide shortcuts.
   */
  readonly isolate?: boolean;
  /**
   * Escape for this modal, when nothing inside it took the key first.
   * Return false when the key is not this modal's (a terminal keeps Escape).
   */
  readonly onEscape: () => boolean | void;
  /** Close this modal, for closeFrontModal. */
  readonly onClose: () => void;
  /**
   * Where focus goes on close. Default: whatever held it when the shell
   * first rendered. Pass null to leave focus alone.
   */
  readonly returnFocusTo?: Element | null;
  /** Asked at close: true when a sibling modal is taking over and focus stays put. */
  readonly keepFocusOnClose?: () => boolean;
  /** The body's keys, called before Escape and the Tab trap. */
  readonly onKeyDown?: (event: ReactKeyboardEvent<HTMLElement>) => void;
}): { readonly onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void } => {
  // Read during the first render: children claim focus in their effects,
  // which run before this hook's own.
  const openerRef = useRef<Element | null | undefined>(undefined);
  const borrowedRef = useRef(false);
  if (openerRef.current === undefined) {
    openerRef.current = returnFocusTo !== undefined ? returnFocusTo : document.activeElement;
    borrowedRef.current = openerBorrowedKeyboard();
  }
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const keepFocusRef = useRef(keepFocusOnClose);
  keepFocusRef.current = keepFocusOnClose;

  const isTopRef = useRef<() => boolean>(() => true);

  useEffect(() => {
    const { leave, isTop } = pushModal({
      layer,
      trap,
      container: () => containerRef.current,
      onEscape: () => onEscapeRef.current() !== false,
      onClose: () => onCloseRef.current(),
    });
    isTopRef.current = isTop;
    const opener = openerRef.current;
    return () => {
      leave();
      // The shell is gone by now. Give focus back only if nothing else took
      // it: an action that opened a surface keeps the keyboard it claimed.
      if (!opener || keepFocusRef.current?.() === true) return;
      returnKeyboardFrom(opener, borrowedRef.current);
    };
  }, [layer, trap, containerRef]);

  return {
    onKeyDown: (event) => {
      const container = containerRef.current;
      // A popover or menu this modal opened portals outside it but still
      // bubbles here through React: its keys are its own.
      const inside = container !== null && event.target instanceof Node && container.contains(event.target);
      // A modal with another one above it is not the one being worked in:
      // its keys wait. Escape travels on to the window, which sends it to
      // the topmost modal.
      if (inside && isTopRef.current()) {
        onKeyDown?.(event);
        if (event.key === "Escape" && !event.defaultPrevented) {
          if (onEscapeRef.current() !== false) {
            event.preventDefault();
            event.stopPropagation();
          }
        } else if (trap && event.key === "Tab" && !event.defaultPrevented && container) {
          const stops = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
          const target = nextTabStop(stops, document.activeElement, event.shiftKey);
          if (target) {
            event.preventDefault();
            claimFocus(target, "gesture", { event });
          }
        }
      }
      if (isolate) event.stopPropagation();
    },
  };
};
