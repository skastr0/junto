/**
 * Subsequence fuzzy ranking for palette search. No edit distance, no
 * query-interpolated regex, no third-party matcher.
 *
 * Identity fields use the full tier ladder. Metadata fields accept a
 * contiguous substring only, so prose cannot outrank a name hit.
 */

export type MatchFields = {
  readonly identity: readonly string[];
  /** Contiguous substring matches only; never fuzzy. */
  readonly metadata?: readonly string[];
};

export type FuzzyHit = {
  readonly score: number;
};

export type RankedMatch<T> = {
  readonly item: T;
  /** Original input position, used to break equal-score ties. */
  readonly index: number;
  readonly score: number;
};

const EXACT = 6000;
const PREFIX = 5000;
const WORD_PREFIX = 4000;
const ACRONYM = 3000;
const SUBSTRING = 2000;
const SUBSEQUENCE = 1000;

const WORD_SEPARATOR = /[^\p{L}\p{N}]+/u;

const wordsOf = (value: string): readonly string[] =>
  value.split(WORD_SEPARATOR).filter(Boolean);

const isSubsequence = (needle: string, haystack: string): boolean => {
  let offset = 0;
  for (const char of haystack) {
    if (char !== needle[offset]) continue;
    offset += 1;
    if (offset === needle.length) return true;
  }
  return false;
};

const identityScore = (token: string, field: string): number => {
  if (!token || !field) return 0;
  if (field === token) return EXACT;
  if (field.startsWith(token)) return PREFIX;
  const words = wordsOf(field);
  if (words.some((word) => word.startsWith(token))) return WORD_PREFIX;
  if (token.length >= 2) {
    const initials = words.map((word) => word[0] ?? "").join("");
    if (initials.includes(token)) return ACRONYM;
  }
  if (field.includes(token)) return SUBSTRING;
  if (isSubsequence(token, field)) return SUBSEQUENCE;
  return 0;
};

const metadataScore = (token: string, field: string): number => {
  if (!token || !field) return 0;
  return field.includes(token) ? SUBSTRING : 0;
};

const bestTokenScore = (token: string, fields: MatchFields): number => {
  let best = 0;
  for (const field of fields.identity) {
    best = Math.max(best, identityScore(token, field.toLowerCase()));
  }
  for (const field of fields.metadata ?? []) {
    best = Math.max(best, metadataScore(token, field.toLowerCase()));
  }
  return best;
};

/**
 * Score one query against discrete fields. Tokens never span field
 * boundaries; every token must hit at least one field.
 */
export const fuzzyMatch = (
  query: string,
  fields: MatchFields,
): FuzzyHit | null => {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return null;
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;

  let score = 0;
  for (const token of tokens) {
    const tokenScore = bestTokenScore(token, fields);
    if (tokenScore === 0) return null;
    score += tokenScore;
  }
  return { score };
};

/**
 * Rank items that match `query`. An empty query preserves input order and
 * never calls the matcher.
 */
export const rankMatches = <T>(
  items: readonly T[],
  query: string,
  fieldsOf: (item: T) => MatchFields,
): readonly RankedMatch<T>[] => {
  if (!query.trim()) {
    return items.map((item, index) => ({ item, index, score: 0 }));
  }

  const ranked: RankedMatch<T>[] = [];
  items.forEach((item, index) => {
    const hit = fuzzyMatch(query, fieldsOf(item));
    if (!hit) return;
    ranked.push({ item, index, score: hit.score });
  });
  ranked.sort((left, right) => right.score - left.score || left.index - right.index);
  return ranked;
};
