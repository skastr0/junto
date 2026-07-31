/**
 * HTTP byte-range parsing for content protocol streaming.
 * Only single ranges are accepted (no multipart/byteranges).
 */

export type ParsedByteRange =
  | { readonly kind: "full" }
  | {
      readonly kind: "partial";
      /** Inclusive start offset. */
      readonly start: number;
      /** Inclusive end offset. */
      readonly end: number;
      readonly length: number;
    }
  | { readonly kind: "unsatisfiable" };

/**
 * Parse a single `Range: bytes=…` header against a known object size.
 * Returns `full` when the header is absent; unsatisfiable for malformed or
 * out-of-bounds requests.
 */
export const parseByteRangeHeader = (
  header: string | null | undefined,
  size: number,
): ParsedByteRange => {
  if (header === null || header === undefined || header.trim() === "") {
    return { kind: "full" };
  }
  if (!Number.isSafeInteger(size) || size < 0) {
    return { kind: "unsatisfiable" };
  }
  if (size === 0) {
    // Empty object: only a full read is meaningful.
    return header.trim() === "" ? { kind: "full" } : { kind: "unsatisfiable" };
  }

  const trimmed = header.trim();
  // Reject multi-range requests — browsers seeking media send single ranges.
  if (trimmed.includes(",")) return { kind: "unsatisfiable" };

  const match = /^bytes=(\d*)-(\d*)$/u.exec(trimmed);
  if (match === null) return { kind: "unsatisfiable" };

  const startRaw = match[1] ?? "";
  const endRaw = match[2] ?? "";

  if (startRaw === "" && endRaw === "") return { kind: "unsatisfiable" };

  let start: number;
  let end: number;

  if (startRaw === "") {
    // Suffix form: bytes=-N → last N bytes
    const suffix = Number(endRaw);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) {
      return { kind: "unsatisfiable" };
    }
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(startRaw);
    if (!Number.isSafeInteger(start) || start < 0 || start >= size) {
      return { kind: "unsatisfiable" };
    }
    if (endRaw === "") {
      end = size - 1;
    } else {
      end = Number(endRaw);
      if (!Number.isSafeInteger(end) || end < start) {
        return { kind: "unsatisfiable" };
      }
      if (end >= size) end = size - 1;
    }
  }

  return {
    kind: "partial",
    start,
    end,
    length: end - start + 1,
  };
};
