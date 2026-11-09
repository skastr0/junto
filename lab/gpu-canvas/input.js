// Wheel and pointer input, stamped with the time the event was made so the
// engine can report how old an input was when its frame started.

export function bindInput(element, sink) {
  const stamp = (event) => performance.timeOrigin + event.timeStamp;
  element.addEventListener(
    "wheel",
    (event) => {
      sink({ type: "wheel", dx: event.deltaX, dy: event.deltaY, ctrl: event.ctrlKey || event.metaKey, x: event.offsetX, y: event.offsetY, t: stamp(event) });
    },
    { passive: true },
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
