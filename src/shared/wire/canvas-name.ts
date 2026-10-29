/**
 * A canvas's name as a locator spells it. A wire module with no import at all
 * (0.11.3), so node refs and the phone check it alike; `src/shared/canvas-name.ts`
 * re-exports it.
 */
export const CANVAS_NAME_MAX_LENGTH = 64;

/** Canonical on-disk / locator spelling. */
export const CANONICAL_CANVAS_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Human input may use ASCII case; the repository canonicalizes it to lowercase. */
export const CANVAS_NAME_INPUT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export const isCanonicalCanvasName = (value: string): boolean =>
  value.length <= CANVAS_NAME_MAX_LENGTH && CANONICAL_CANVAS_NAME_PATTERN.test(value);
