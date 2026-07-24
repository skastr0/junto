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
