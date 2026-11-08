

/**
 * Pure canonical JSON and semantic hashing for Work records.
 *
 * Keys are sorted and `undefined` members are dropped.
 * `originAt` and `contentSha256` are excluded from semantic hash calculations.
 */
export const canonicalJson = (value: unknown): string => {
  const normalizeJson = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(normalizeJson);
    if (v === null || typeof v !== "object") return v;
    return Object.fromEntries(
      Object.entries(v as Readonly<Record<string, unknown>>)
        .filter(([, nested]) => nested !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, nested]) => [key, normalizeJson(nested)]),
    );
  };
  return JSON.stringify(normalizeJson(value));
};
