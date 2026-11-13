/**
 * Keyboard panning for the canvas camera.
 *
 * The pure part lives in `@shared/canvas-keyboard-pan` so the GPU canvas
 * engine and this canvas share one set of speeds and one focus gate. This
 * module re-exports it for the existing callers.
 */

export * from "@shared/canvas-keyboard-pan";
