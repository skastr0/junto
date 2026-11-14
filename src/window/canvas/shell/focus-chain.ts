/**
 * The keyboard focus chain on the GPU canvas: Tab moves the cyan ring from
 * card to card, Shift+Tab moves it back, and Escape or a lost keyboard lets
 * it go. The ring is `state$.focusedNodeId`; the feed derives it into the
 * selection fact and the engine paints it (`paint/*.ts`, `FOCUS`).
 *
 * The walk only runs while the canvas element itself holds the keyboard, so
 * Tab inside the bottom bar, a menu or a field keeps its ordinary meaning.
 * The order is lib/canvas-focus-order.ts: reading order, regions left out.
 */

import { canvasOwnsKeyboard } from "../../lib/canvas-keyboard-pan";
import { focusOrder, stepFocus } from "../../lib/canvas-focus-order";
import { deepActiveElement, isOperatorTyping } from "../../lib/focus-ownership";
import { state$ } from "../../lib/state";
import { modelStore } from "../../lib/use-model";

/** The card ids on the open canvas, in Tab order. */
const cardsInOrder = (): ReadonlyArray<string> => {
  const name = state$.canvasName.peek();
  if (name === "") return [];
  return focusOrder(modelStore.canvasOf(name).nodes.values());
};

/** The card the selection is on alone, if it is on one card. */
const soleSelected = (): string => {
  const many = state$.selectedNodeIds.peek();
  if (many.length === 1) return many[0]!;
  return many.length === 0 ? state$.selectedNodeId.peek() : "";
};

/** Install the chain on the canvas element; returns the way to stop it. */
export const installCanvasFocusChain = (canvas: HTMLElement): (() => void) => {
  const clear = (): void => {
    if (state$.focusedNodeId.peek() !== "") state$.focusedNodeId.set("");
  };

  // Capture, so Escape drops the ring before the window's own Escape (which
  // clears the selection) and Tab never moves the browser's focus away.
  // focus-law: refused while the operator types, and while a surface in front
  // owns the keyboard.
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || event.isComposing) return;
    if (event.key !== "Tab" && event.key !== "Escape") return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (deepActiveElement() !== canvas) return;
    if (isOperatorTyping(event.target) || !canvasOwnsKeyboard(document)) return;

    if (event.key === "Escape") {
      if (state$.focusedNodeId.peek() === "") return;
      event.preventDefault();
      event.stopPropagation();
      clear();
      return;
    }

    const order = cardsInOrder();
    if (order.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    const direction = event.shiftKey ? -1 : 1;
    const focused = state$.focusedNodeId.peek();
    const selected = soleSelected();
    // The first Tab lands on the card already selected, if there is one;
    // after that the ring walks from where it is.
    const next = focused === "" && selected !== "" && order.includes(selected)
      ? selected
      : stepFocus(order, focused, direction);
    if (next !== undefined) state$.focusedNodeId.set(next);
  };

  window.addEventListener("keydown", onKeyDown, { capture: true });
  canvas.addEventListener("blur", clear);
  window.addEventListener("blur", clear);
  // A press on the canvas takes the keyboard back to the pointer: the ring
  // goes, and the selection is what the press is about.
  canvas.addEventListener("pointerdown", clear, { passive: true });

  return () => {
    window.removeEventListener("keydown", onKeyDown, { capture: true });
    canvas.removeEventListener("blur", clear);
    window.removeEventListener("blur", clear);
    canvas.removeEventListener("pointerdown", clear);
  };
};
