export const CANVAS_NAME_MAX_LENGTH = 64;

/** Canonical on-disk / locator spelling. */
export const CANONICAL_CANVAS_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Human input may use ASCII case; the repository canonicalizes it to lowercase. */
export const CANVAS_NAME_INPUT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export const isCanonicalCanvasName = (value: string): boolean =>
  value.length <= CANVAS_NAME_MAX_LENGTH && CANONICAL_CANVAS_NAME_PATTERN.test(value);
