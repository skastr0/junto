/**
 * Wheel transactions for a canvas, as Firefox scopes them
 * (`mousewheel.transaction.timeout` 1500 ms and
 * `mousewheel.transaction.ignoremovedelay` 100 ms): a wheel gesture belongs
 * to the element it started on.
 *
 * Panning moves the board under a still pointer, so a card, a terminal, a wire
 * label or an editor arrives under it mid-gesture. Without a transaction that
 * element takes the next wheel event, scrolls itself or swallows it, and the
 * pan stops dead. With one, once the canvas takes a gesture's first event,
 * every later event of that gesture is the canvas's, whatever lies under the
 * pointer. The transaction ends after 1500 ms with no wheel event, or when
 * the pointer itself moves more than 100 ms after the last wheel event (the
 * operator went somewhere else on purpose).
 */

export const WHEEL_TRANSACTION_TIMEOUT_MS = 1500;
export const WHEEL_TRANSACTION_IGNORE_MOVE_MS = 100;

export type WheelLatch = {
  /** The canvas took a wheel event at `at`: it opens or extends its transaction. */
  readonly took: (at: number) => void;
  /** True while a wheel event at `at` belongs to the canvas's open transaction. */
  readonly holds: (at: number) => boolean;
  /** The pointer moved at `at`: past the ignore delay, that ends the transaction. */
  readonly moved: (at: number) => void;
};

export const createWheelLatch = (): WheelLatch => {
  let last: number | null = null;
  return {
    took: (at) => {
      last = at;
    },
    holds: (at) => last !== null && at - last <= WHEEL_TRANSACTION_TIMEOUT_MS,
    moved: (at) => {
      if (last !== null && at - last > WHEEL_TRANSACTION_IGNORE_MOVE_MS) last = null;
    },
  };
};

export type WheelLatchHost = {
  /** The canvas's box on screen, or null while it is not mounted. */
  readonly surface: () => DOMRect | null;
  /** True for a target the canvas already takes wheel events from itself. */
  readonly ownTarget: (target: EventTarget | null) => boolean;
  /** Hand a wheel event the canvas did not receive to the canvas. */
  readonly forward: (event: WheelEvent) => void;
};

const inside = (box: DOMRect, event: WheelEvent): boolean =>
  event.clientX >= box.left && event.clientX < box.right && event.clientY >= box.top && event.clientY < box.bottom;

/**
 * Watch the window for the canvas's transactions. A wheel event over the
 * canvas's box that something else would take, while the canvas's
 * transaction is open, is stopped before it reaches that element and handed
 * to the canvas. The canvas reports each event it takes with `latch.took`.
 */
export const installWheelLatch = (
  host: WheelLatchHost,
  win: Window = window,
  now: () => number = () => performance.now(),
): { readonly latch: WheelLatch; readonly dispose: () => void } => {
  const latch = createWheelLatch();
  const onWheel = (event: WheelEvent): void => {
    if (host.ownTarget(event.target)) return;
    const at = now();
    if (!latch.holds(at)) return;
    const box = host.surface();
    if (box === null || !inside(box, event)) return;
    event.preventDefault();
    event.stopPropagation();
    latch.took(at);
    host.forward(event);
  };
  const onMove = (): void => latch.moved(now());
  // Capture, so the element under the pointer never sees an event the canvas
  // owns; non-passive, so the page does not scroll it either.
  win.addEventListener("wheel", onWheel, { capture: true, passive: false });
  win.addEventListener("pointermove", onMove, { capture: true, passive: true });
  return {
    latch,
    dispose: () => {
      win.removeEventListener("wheel", onWheel, { capture: true });
      win.removeEventListener("pointermove", onMove, { capture: true });
    },
  };
};

/** The same wheel event, to dispatch at another target. */
export const copyWheel = (event: WheelEvent): WheelEvent =>
  new WheelEvent("wheel", {
    deltaX: event.deltaX,
    deltaY: event.deltaY,
    deltaZ: event.deltaZ,
    deltaMode: event.deltaMode,
    clientX: event.clientX,
    clientY: event.clientY,
    screenX: event.screenX,
    screenY: event.screenY,
    ctrlKey: event.ctrlKey,
    shiftKey: event.shiftKey,
    altKey: event.altKey,
    metaKey: event.metaKey,
    bubbles: true,
    cancelable: true,
  });
