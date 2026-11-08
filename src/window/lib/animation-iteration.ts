/**
 * No `animationiteration` listener is ever registered in this window.
 *
 * While one listener for that event exists anywhere in a document, Chromium
 * wakes the main thread at each iteration of each CSS animation on the page
 * to dispatch it, and every wake is a main-thread frame with a style pass.
 * With none, a composited animation loops on the compositor alone. React
 * registers a listener for every event it knows on each root and portal
 * container (document.body among them), this one included, though nothing in
 * Junto listens for it. On the operator's board that was 68 events a second
 * driving 31 main-thread frames a second (77 ms/s, live trace), for rings and
 * pings that turn on the compositor. Idle probe with the registration
 * refused: 0 events, 0 main-thread frames, every animation still at 120 fps.
 *
 * Installed before React makes a root. A loop count is read from the
 * animation's own timing (Animation.currentTime), never from this event.
 */
export const ITERATION_EVENT_TYPES: ReadonlySet<string> = new Set([
  "animationiteration",
  "webkitAnimationIteration",
  "webkitanimationiteration",
]);

const REFUSES = Symbol.for("junto.refusesAnimationIteration");

type Add = EventTarget["addEventListener"] & { [REFUSES]?: true };

export const refuseAnimationIterationListeners = (target: EventTarget = EventTarget.prototype): void => {
  const add = target.addEventListener as Add;
  if (add[REFUSES]) return;
  const guarded: Add = function (this: EventTarget, type, listener, options) {
    if (ITERATION_EVENT_TYPES.has(type)) return;
    add.call(this, type, listener, options);
  };
  guarded[REFUSES] = true;
  target.addEventListener = guarded;
};
