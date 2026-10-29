/**
 * The keys the canvas binds on the document itself, outside the key table.
 * React Flow's delete chord is one: it listens on the document, so what is in
 * front of the canvas has to be told no rather than have the chord unbound.
 *
 * Unbinding is what raised the bug this file exists to prevent: React Flow
 * remembers the keys it saw while a chord was bound, and turning the chord
 * off leaves them in that set. After the chord came back, the first
 * Backspace matched nothing, because the set still held the chords that
 * opened and closed the modal. So the chord stays bound for the life of the
 * canvas, and the delete is refused where it is ruled on.
 */

/**
 * React Flow's delete chord. One array for the life of the canvas: a new one
 * on every render re-registers its document listener.
 */
export const CANVAS_DELETE_KEY_CODE: string[] = ["Backspace", "Delete"];

/** True while something in front of the canvas owns the keyboard: a focus surface, or any modal. */
export const canvasKeyboardTaken = (focusSurfaceOpen: boolean, modalOpen: boolean): boolean =>
  focusSurfaceOpen || modalOpen;
