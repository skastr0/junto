/**
 * Modifier presses stay inside the terminal.
 *
 * xyflow's key hooks listen on the window and the document and act on Shift
 * (its selection key) and Cmd (its zoom key) even when the press comes from a
 * text field. Each flip makes the canvas re-register its blocking wheel
 * listener (@xyflow/system XYPanZoom.update), and Chromium records wheel
 * handler regions in paint, so the whole board repaints: about 20 ms a press
 * on a 358-node board, lab measured, for every capital letter and every Cmd
 * shortcut typed in a terminal.
 *
 * Junto's own global key listeners ignore modifier-only keys
 * (focus-ownership.ts, modal-stack.ts), so nothing of ours needs these.
 * Only keydown stops. The keyup still travels, so a Shift pressed on the
 * canvas and released in the terminal is never left held down in xyflow,
 * and a keyup for a press xyflow never saw changes no state.
 */
const MODIFIER_ONLY_KEYS: ReadonlySet<string> = new Set(["Shift", "Meta", "Control", "Alt"]);

export const isModifierOnlyKey = (key: string): boolean => MODIFIER_ONLY_KEYS.has(key);

/** Stop modifier-only keydown at the terminal host. Returns the detach. */
export const attachTerminalModifierFence = (host: HTMLElement): (() => void) => {
  const onKeyDown = (event: KeyboardEvent): void => {
    if (isModifierOnlyKey(event.key)) event.stopPropagation();
  };
  host.addEventListener("keydown", onKeyDown);
  return () => host.removeEventListener("keydown", onKeyDown);
};
