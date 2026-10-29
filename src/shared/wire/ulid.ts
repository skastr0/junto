/**
 * The shape of a ULID: 26 characters of Crockford base32. Effect-free, so the
 * preload and node refs check it without pulling in Schema; `work-ids.ts`
 * builds its branded ids on the same pattern. A wire module with no import
 * at all (0.11.3); `src/shared/ulid.ts` re-exports it.
 */
export const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/u;

export const isUlid = (text: string): boolean => ULID_PATTERN.test(text);
