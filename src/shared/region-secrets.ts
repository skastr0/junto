/**
 * The rules for Junto's own secret store, in one renderer-safe place: the
 * store, the region screen and the overseer CLI all refuse the same things.
 *
 * Pure module, no Node imports.
 */

/** A secret id is a UUID. Ids are lowercased when saved. */
export const SECRET_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/** Largest value the store takes, in UTF-8 bytes. */
export const SECRET_VALUE_MAX_BYTES = 64 * 1024;

/** Why a value cannot be saved, in plain words, or undefined when it can. */
export const secretValueProblem = (value: string): string | undefined => {
  if (value.length === 0) return "A secret cannot be empty.";
  if (value.includes("\u0000")) return "A secret cannot contain a NUL character.";
  if (new TextEncoder().encode(value).length > SECRET_VALUE_MAX_BYTES) {
    return `A secret can be at most ${String(SECRET_VALUE_MAX_BYTES / 1024)} KB.`;
  }
  return undefined;
};
