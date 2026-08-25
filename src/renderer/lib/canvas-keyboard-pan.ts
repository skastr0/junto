/**
 * Keyboard panning for the canvas camera.
 *
 * WASD and the arrow keys fly the viewport, but only while the canvas itself
 * owns the keyboard: no focus modal, menu, or dialog on screen, and no input,
 * textarea, contenteditable, or terminal holding focus. Typing always wins —
 * a key that could land in a field is never a pan key.
 *
 * Speed is screen pixels per second, so panning feels identical at every zoom
 * level (the camera moves, the world does not).
 */

export type PanVector = { readonly x: number; readonly y: number };

export const PAN_SPEED_PX_PER_SECOND = 900;
/** Shift flies faster. Same direction, longer stride. */
export const PAN_BOOST_MULTIPLIER = 2.4;
/** A frame longer than this was a stall (tab hidden, GC); do not teleport. */
export const MAX_PAN_FRAME_MS = 64;
/** Ramp to full speed so a tap nudges and a hold glides. */
export const PAN_RAMP_MS = 130;

const KEY_VECTORS: Readonly<Record<string, PanVector>> = {
  w: { x: 0, y: -1 },
  a: { x: -1, y: 0 },
  s: { x: 0, y: 1 },
  d: { x: 1, y: 0 },
  arrowup: { x: 0, y: -1 },
  arrowleft: { x: -1, y: 0 },
  arrowdown: { x: 0, y: 1 },
  arrowright: { x: 1, y: 0 },
};

/**
 * Surfaces that take the keyboard away from the canvas while they are open.
 * Presence in the document is the truth — an open modal blocks panning even
 * when focus sits on the body.
 *
 * The docked add-item host carries the menu marker permanently (it is the
 * trigger, not the menu), so it is excluded; its open deck is a focus surface
 * and blocks through the first selector.
 */
export const PAN_BLOCKING_SURFACE_SELECTOR =
  "[data-focus-surface], [role='dialog'], [data-canvas-menu-surface]:not(.node-deck-host--docked)";

/**
 * Focus holders that mean the operator is typing or driving a node, not
 * flying the camera. `.xterm` covers agent terminals; `.react-flow__node`
 * leaves xyflow's own keyboard node handling alone.
 */
export const PAN_BLOCKING_FOCUS_SELECTOR =
  "input, textarea, select, [contenteditable=''], [contenteditable='true'], .xterm, .react-flow__node";

/** Normalized id for a pan key, or null when the key is not one of ours. */
export const panKeyFor = (key: string): string | null => {
  const id = key.toLowerCase();
  return id in KEY_VECTORS ? id : null;
};

type ModifierState = {
  readonly metaKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly altKey?: boolean;
};

/**
 * Any modifier other than Shift belongs to a command chord (⌘A, ⌥drag,
 * Ctrl+arrow desktop switching). Panning never claims those.
 */
export const panModifiersAllow = (event: ModifierState): boolean =>
  !event.metaKey && !event.ctrlKey && !event.altKey;

type FocusTarget = { readonly closest?: (selector: string) => unknown };
type PanDocument = {
  readonly querySelector: (selector: string) => unknown;
  readonly activeElement?: FocusTarget | null;
  readonly body?: FocusTarget | null;
};

/**
 * True when the canvas has the keyboard to itself. Fail closed: anything we
 * cannot inspect counts as taken.
 */
export const canvasOwnsKeyboard = (doc: PanDocument | null | undefined): boolean => {
  if (!doc || typeof doc.querySelector !== "function") return false;
  if (doc.querySelector(PAN_BLOCKING_SURFACE_SELECTOR)) return false;
  const active = doc.activeElement;
  if (!active) return true;
  if (active === doc.body) return true;
  if (typeof active.closest !== "function") return false;
  return !active.closest(PAN_BLOCKING_FOCUS_SELECTOR);
};

/** Sum of held directions, normalized so diagonals are not faster. */
export const panVectorFor = (keys: Iterable<string>): PanVector => {
  let x = 0;
  let y = 0;
  for (const key of keys) {
    const vector = KEY_VECTORS[key];
    if (!vector) continue;
    x += vector.x;
    y += vector.y;
  }
  if (x === 0 && y === 0) return { x: 0, y: 0 };
  const length = Math.hypot(x, y);
  return { x: x / length, y: y / length };
};

/** 0 → 1 over PAN_RAMP_MS so a tap nudges instead of jumping. */
export const panRamp = (heldMs: number): number => {
  if (heldMs <= 0) return 0;
  if (heldMs >= PAN_RAMP_MS) return 1;
  return heldMs / PAN_RAMP_MS;
};

/**
 * Viewport delta for one frame. The camera moves along `vector`, so the
 * viewport translation is the opposite sign.
 */
export const panViewportDelta = ({
  vector,
  frameMs,
  heldMs,
  boost = false,
}: {
  readonly vector: PanVector;
  readonly frameMs: number;
  readonly heldMs: number;
  readonly boost?: boolean;
}): { readonly x: number; readonly y: number } => {
  if (vector.x === 0 && vector.y === 0) return { x: 0, y: 0 };
  const dt = Math.max(0, Math.min(frameMs, MAX_PAN_FRAME_MS)) / 1000;
  const speed = PAN_SPEED_PX_PER_SECOND * (boost ? PAN_BOOST_MULTIPLIER : 1);
  const step = speed * dt * panRamp(heldMs);
  return { x: -vector.x * step, y: -vector.y * step };
};
