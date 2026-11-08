/**
 * Which panel sizes a surface remembers: only the ones the operator dragged.
 *
 * A panel's size changes for many reasons that are not the operator's: a
 * window squeezed narrower, a layout pass, the rail beside it, the maximize
 * toggle, the first measure after it opens. Recording them all (a bare
 * ResizeObserver) froze whatever box the panel was squeezed into as the
 * operator's size and forced it back as an inline width on every later open,
 * long after the window was wide again. Only a press on the panel's resize
 * grip starts a size worth keeping, and only the size it ends at is kept.
 */

/** The native resize grip is the panel's bottom-right corner, about this wide. */
export const RESIZE_GRIP_PX = 20;

export type PanelSize = { readonly width: number; readonly height: number };

export const inResizeGrip = (rect: DOMRect, clientX: number, clientY: number): boolean =>
  clientX >= rect.right - RESIZE_GRIP_PX &&
  clientX <= rect.right &&
  clientY >= rect.bottom - RESIZE_GRIP_PX &&
  clientY <= rect.bottom;

/** A remembered size never exceeds the frame the panel opens in. */
export const clampToFrame = (size: number, frame: number): number => (frame > 0 ? Math.min(size, frame) : size);

const sizeOf = (panel: HTMLElement): PanelSize => ({ width: panel.offsetWidth, height: panel.offsetHeight });

/**
 * Call `onResize` with the size the operator dragged the panel to, once, when
 * the drag ends; call `onReset` when they double-click the grip (the panel is
 * the target: the grip belongs to its own box). Nothing else is reported.
 * Returns the cleanup.
 */
export function watchOperatorResize(
  panel: HTMLElement,
  { onResize, onReset }: { readonly onResize: (size: PanelSize) => void; readonly onReset: () => void },
): () => void {
  // A maximized panel is the surface's box, not the operator's.
  const maximized = (): boolean => panel.closest('[data-maximized="true"]') !== null;
  let drag: PanelSize | null = null;

  const onDown = (event: PointerEvent): void => {
    if (maximized() || !inResizeGrip(panel.getBoundingClientRect(), event.clientX, event.clientY)) return;
    drag = sizeOf(panel);
  };
  const onUp = (): void => {
    if (drag === null) return;
    const start = drag;
    drag = null;
    const end = sizeOf(panel);
    // A press in the corner that moved nothing is not a resize.
    if (end.width !== start.width || end.height !== start.height) onResize(end);
  };
  const onDouble = (event: MouseEvent): void => {
    if (event.target !== panel || maximized()) return;
    if (inResizeGrip(panel.getBoundingClientRect(), event.clientX, event.clientY)) onReset();
  };

  panel.addEventListener("pointerdown", onDown, true);
  panel.addEventListener("dblclick", onDouble);
  // The drag ends wherever the pointer is let go, or the window loses it.
  window.addEventListener("pointerup", onUp, true);
  window.addEventListener("pointercancel", onUp, true);
  window.addEventListener("mouseup", onUp, true);
  window.addEventListener("blur", onUp);
  return () => {
    panel.removeEventListener("pointerdown", onDown, true);
    panel.removeEventListener("dblclick", onDouble);
    window.removeEventListener("pointerup", onUp, true);
    window.removeEventListener("pointercancel", onUp, true);
    window.removeEventListener("mouseup", onUp, true);
    window.removeEventListener("blur", onUp);
  };
}
