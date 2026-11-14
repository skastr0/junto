import { useEffect, useRef } from "react";
import { isOperatorModalOpen } from "./operator-modal";

/**
 * A canvas menu closes on Escape, or on a press anywhere outside a canvas
 * menu surface. The press closes it in the capture phase, before any surface
 * that the press itself opens: the GPU canvas opens a menu from the pointer
 * machine on the same `pointerdown` that dismisses the previous one, and a
 * bubble-phase dismiss listener then found the menu mounted and closed it
 * again inside that one dispatch, so a right click on the GPU canvas never
 * showed a menu at all.
 *
 * The listeners are put on once per opening and read the latest `dismiss`
 * through a ref. They must not be re-subscribed when the callback changes:
 * owners pass a new one on every render, and another Escape listener on the
 * window (App's, which clears the selection) re-renders the owner in the
 * middle of the keypress. A listener taken off the window during dispatch
 * is never called, so the selection went and the menu stayed open.
 */
export const useMenuDismiss = (active: boolean, dismiss: () => void): void => {
  const latest = useRef(dismiss);
  latest.current = dismiss;
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // An operator modal above the canvas owns Escape while it is open.
      if (isOperatorModalOpen()) return;
      event.preventDefault();
      latest.current();
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest("[data-canvas-menu-surface]")
      ) return;
      latest.current();
    };
    // focus-law: Escape-only dismissal of the open canvas menu.
    window.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [active]);
};
