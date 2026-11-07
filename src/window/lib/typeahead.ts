import { fuzzyMatch } from "./fuzzy-match";

export type TypeaheadBuffer = {
  readonly text: string;
  readonly at: number;
};

export const TYPEAHEAD_EXPIRY_MS = 700;

/**
 * Fold a qualified printable key into the buffer. Callers must reject
 * composition, modifiers, and Space before this runs.
 *
 * Repeated presses of the same character keep a one-character buffer so
 * they cycle prefix hits instead of searching "aa", "aaa", …
 */
export const typeaheadAccept = (
  buffer: TypeaheadBuffer,
  key: string,
  now: number,
): TypeaheadBuffer => {
  const expired = now - buffer.at > TYPEAHEAD_EXPIRY_MS;
  const previous = expired ? "" : buffer.text;
  const nextChar = key.toLowerCase();
  if (previous === nextChar) return { text: nextChar, at: now };
  return { text: previous + nextChar, at: now };
};

/**
 * Next label index for the current buffer. Prefix hits win; fuzzy fallback
 * runs only when the buffer has at least two characters. `current = -1`
 * means no current item. `null` leaves focus unchanged.
 */
export const typeaheadIndex = (
  labels: readonly string[],
  buffer: string,
  current: number,
): number | null => {
  const count = labels.length;
  if (count === 0 || buffer.length === 0) return null;

  const start = current < 0 ? 0 : current + 1;
  const order: number[] = [];
  for (let step = 0; step < count; step += 1) {
    order.push((start + step) % count);
  }

  const needle = buffer.toLowerCase();
  for (const index of order) {
    if (labels[index]!.toLowerCase().startsWith(needle)) return index;
  }

  if (buffer.length < 2) return null;

  let bestIndex: number | null = null;
  let bestScore = -1;
  for (const index of order) {
    const hit = fuzzyMatch(buffer, { identity: [labels[index]!] });
    if (!hit) continue;
    if (hit.score > bestScore) {
      bestScore = hit.score;
      bestIndex = index;
    }
  }
  return bestIndex;
};
