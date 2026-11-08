/**
 * Canonical JSON for the work plane.
 *
 * One serialization, shared by the journal (record hashing, record bodies) and
 * the projection (JSON columns). Keys are sorted and `undefined` members are
 * dropped, so the same semantic value always produces the same bytes and the
 * same content hash on every installation.
 */
const normalizeJson = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Readonly<Record<string, unknown>>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      )
      .map(([key, nested]) => [key, normalizeJson(nested)]),
  );
};

export const canonicalJson = (value: unknown): string =>
  JSON.stringify(normalizeJson(value));
