import type {
  MouseEventHandler,
  PointerEventHandler,
} from "react";

/**
 * Activate primary-pointer controls on pointer-up while preserving native
 * keyboard button activation. Pointer-originated clicks are ignored to avoid
 * firing the same action twice.
 */
export const activateOnPointerUp = (
  action: () => void,
): {
  readonly onPointerUp: PointerEventHandler<HTMLButtonElement>;
  readonly onClick: MouseEventHandler<HTMLButtonElement>;
} => ({
  onPointerUp: (event) => {
    if (event.button === 0) action();
  },
  onClick: (event) => {
    if (event.detail === 0) action();
  },
});

/** Selectors for controls that should not bubble into surface/pane activation. */
const INTERACTIVE_SELECTOR =
  "button, a, input, select, textarea, [role='button']";

/**
 * True when the event target is (or is inside) a control that owns its own
 * gesture — Pin / Kill / Close / Unclaim, etc.
 *
 * Duck-typed (has `closest`) so unit tests need no DOM global and SSR stays safe.
 */
export const isInteractiveTarget = (target: EventTarget | null): boolean => {
  if (target == null || typeof target !== "object") return false;
  if (!("closest" in target)) return false;
  const closest = (target as { closest?: unknown }).closest;
  if (typeof closest !== "function") return false;
  return Boolean(
    (closest as (sel: string) => unknown).call(target, INTERACTIVE_SELECTOR),
  );
};

/**
 * Pane/surface activation on mousedown, ignoring interactive descendants so
 * chrome button gestures do not reorder the workbench before click fires.
 * Keyboard activation of those buttons is unchanged.
 */
export const activateSurfaceOnMouseDown = (
  onActivate: (() => void) | undefined,
): MouseEventHandler<HTMLElement> => (event) => {
  if (isInteractiveTarget(event.target)) return;
  onActivate?.();
};
