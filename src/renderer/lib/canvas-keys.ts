/**
 * The keys the canvas binds on the document itself, outside the key table.
 * React Flow's delete chord is one: it listens on the document, so an open
 * modal has to turn it off rather than stop it per surface.
 */

/** React Flow's delete chord, or null while a focus surface or any modal owns the keyboard. */
export const canvasDeleteKeyCode = (
  focusSurfaceOpen: boolean,
  modalOpen: boolean,
): string[] | null => (focusSurfaceOpen || modalOpen ? null : ["Backspace", "Delete"]);
