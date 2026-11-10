// Wheel and pointer input, stamped with the time the event was made so the
// engine can report how old an input was when its frame started.

export function bindInput(element, sink) {
  const stamp = (event) => performance.timeOrigin + event.timeStamp;
  // The canvas takes the wheel for itself. Left to Chromium, a wheel becomes a
  // scroll gesture, and during one its compositor holds some frames a third of
  // a refresh to wait for scroll input and not others; each switch lands a
  // frame on the other side of the display's cut-off, so one refresh shows two
  // pictures and the next none.
  element.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      sink({ type: "wheel", dx: event.deltaX, dy: event.deltaY, ctrl: event.ctrlKey || event.metaKey, x: event.offsetX, y: event.offsetY, t: stamp(event) });
    },
    { passive: false },
  );
  let down = false;
  element.addEventListener("pointerdown", (event) => {
    down = true;
    element.setPointerCapture(event.pointerId);
  });
  element.addEventListener("pointerup", () => {
    down = false;
  });
  element.addEventListener("pointermove", (event) => {
    if (down) sink({ type: "drag", dx: event.movementX, dy: event.movementY, t: stamp(event) });
    else sink({ type: "move", x: event.offsetX, y: event.offsetY });
  });
}
