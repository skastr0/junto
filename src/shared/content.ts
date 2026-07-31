import { Schema } from "effect";

/**
 * Content is a data-plane object.  Work records carry only this metadata;
 * bytes travel through the content store/transfer plane and never through a
 * task, message, or artifact JSON snapshot.
 */

/** Canonical lower-case SHA-256 digest used as the immutable object identity. */
export const ContentSha256 = Schema.String.pipe(
  Schema.pattern(/^[a-f0-9]{64}$/),
  Schema.brand("ContentSha256"),
);
export type ContentSha256 = typeof ContentSha256.Type;

/**
 * Byte length is represented as a JSON-safe non-negative integer.  There is
 * intentionally no product-sized ceiling here: storage admission, disk
 * reserve, and transfer backpressure belong to their owning planes.
 */
export const ContentByteLength = Schema.Number.pipe(
  Schema.int(),
  Schema.nonNegative(),
  Schema.filter(Number.isSafeInteger, {
    message: () => "content byteLength must be a safe integer",
  }),
  Schema.brand("ContentByteLength"),
);
export type ContentByteLength = typeof ContentByteLength.Type;

/** MIME/media type metadata.  Parameters are preserved as authored. */
export const ContentMediaType = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(255),
  Schema.pattern(/^[^\u0000-\u001f\u007f]+$/),
  Schema.brand("ContentMediaType"),
);
export type ContentMediaType = typeof ContentMediaType.Type;

/** Display-only metadata; it is never a path or an object identity. */
export const ContentDisplayName = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(255),
  Schema.pattern(/^[^\u0000-\u001f\u007f]+$/),
  Schema.brand("ContentDisplayName"),
);
export type ContentDisplayName = typeof ContentDisplayName.Type;

/** Stable identity of bytes, independent of media type and display metadata. */
export const ContentIdentity = Schema.Struct({
  sha256: ContentSha256,
  byteLength: ContentByteLength,
});
export type ContentIdentity = typeof ContentIdentity.Type;

/**
 * Portable reference to one immutable content object.
 *
 * There is deliberately no host path, URL, station id, or inline byte field.
 * A digest/length pair is sufficient to verify the bytes; media type and
 * display name are descriptive metadata carried with the reference.
 */
export const ContentRef = Schema.Struct({
  ...ContentIdentity.fields,
  mediaType: ContentMediaType,
  displayName: Schema.optionalWith(ContentDisplayName, { exact: true }),
});
export type ContentRef = typeof ContentRef.Type;

/**
 * The immutable object descriptor is intentionally the same shape as its
 * portable reference.  The bytes themselves stay outside JSON; callers use
 * the name when they need to distinguish object/manifest terminology from a
 * reference in a larger value.
 */
export const ContentObject = ContentRef;
export type ContentObject = ContentRef;

/**
 * Local manifest projection.  This shape is intentionally tagged so a path
 * cannot be mistaken for portable content metadata.  It is never persisted in
 * a Work record or sent across a Station boundary.
 */
export const ContentLocalPathProjection = Schema.Struct({
  kind: Schema.Literal("local-path"),
  ref: ContentRef,
  path: Schema.String.pipe(
    Schema.minLength(1),
    Schema.maxLength(4_096),
    Schema.pattern(/^[^\u0000]+$/),
  ),
});
export type ContentLocalPathProjection = typeof ContentLocalPathProjection.Type;

/** Short alias for callers that describe the projection as a content path. */
export const ContentPathProjection = ContentLocalPathProjection;
export type ContentPathProjection = ContentLocalPathProjection;

export const ContentAvailabilityReason = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(1_024),
  Schema.pattern(/^[^\u0000-\u001f\u007f]+$/),
  Schema.brand("ContentAvailabilityReason"),
);
export type ContentAvailabilityReason = typeof ContentAvailabilityReason.Type;

export const ContentTimestamp = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(64),
  Schema.brand("ContentTimestamp"),
);
export type ContentTimestamp = typeof ContentTimestamp.Type;

/** A verified receipt is valid only when observed identity equals the ref. */
export const ContentReceipt = Schema.Struct({
  ref: ContentRef,
  state: Schema.Literal("verified"),
  verifiedSha256: ContentSha256,
  verifiedByteLength: ContentByteLength,
  verifiedAt: ContentTimestamp,
}).pipe(
  Schema.filter(
    ({ ref, verifiedSha256, verifiedByteLength }) =>
      (ref.sha256 === verifiedSha256 && ref.byteLength === verifiedByteLength) ||
      "verified receipt does not match its ContentRef",
  ),
);
export type ContentReceipt = typeof ContentReceipt.Type;

export const ContentMissing = Schema.Struct({
  ref: ContentRef,
  state: Schema.Literal("missing"),
  reason: ContentAvailabilityReason,
});
export type ContentMissing = typeof ContentMissing.Type;

export const ContentCorrupt = Schema.Struct({
  ref: ContentRef,
  state: Schema.Literal("corrupt"),
  reason: ContentAvailabilityReason,
  observedSha256: Schema.optionalWith(ContentSha256, { exact: true }),
  observedByteLength: Schema.optionalWith(ContentByteLength, { exact: true }),
});
export type ContentCorrupt = typeof ContentCorrupt.Type;

export const ContentUnavailable = Schema.Struct({
  ref: ContentRef,
  state: Schema.Literal("unavailable"),
  reason: ContentAvailabilityReason,
});
export type ContentUnavailable = typeof ContentUnavailable.Type;

/**
 * Explicit fail-closed availability states.  Only `verified` permits a
 * consumer to open bytes; every other state requires a reason and is not an
 * empty-file success.
 */
export const ContentAvailability = Schema.Union(
  ContentReceipt,
  ContentMissing,
  ContentCorrupt,
  ContentUnavailable,
);
export type ContentAvailability = typeof ContentAvailability.Type;

/**
 * Ref-only work part. RawPart remains readable as a legacy union member, but
 * new durable task/message/artifact writes must use this shape.
 */
export const ContentPart = Schema.Struct({
  kind: Schema.Literal("content"),
  ref: ContentRef,
});
export type ContentPart = typeof ContentPart.Type;

/** Strict decoder used by ingress adapters that accept only a ref part. */
export const decodeContentPart = Schema.decodeUnknownEither(ContentPart, {
  onExcessProperty: "error",
});

/** Runtime narrowing helper for mixed legacy/new Part arrays. */
export const isContentPart = (value: unknown): value is ContentPart => {
  try {
    Schema.decodeUnknownSync(ContentPart, { onExcessProperty: "error" })(value);
    return true;
  } catch {
    return false;
  }
};

const INLINE_BINARY_KEYS = new Set(["bytesBase64", "dataBase64"]);

/**
 * Detects inline binary fields in a prospective control payload.  Work
 * records are JSON values, so this intentionally walks only plain objects and
 * arrays and fails closed on any known inline-byte field at any depth.
 */
export const hasInlineBinaryPayload = (value: unknown): boolean => {
  const seen = new WeakSet<object>();
  const visit = (candidate: unknown): boolean => {
    if (candidate === null || typeof candidate !== "object") return false;
    if (seen.has(candidate)) return false;
    seen.add(candidate);
    if (Array.isArray(candidate)) return candidate.some(visit);
    for (const [key, nested] of Object.entries(candidate)) {
      if (INLINE_BINARY_KEYS.has(key)) return true;
      if (visit(nested)) return true;
    }
    return false;
  };
  return visit(value);
};

/** Schema-filter compatible guard for the Work/control record boundary. */
export const validateNoInlineBinaryPayload = (
  value: unknown,
): string | undefined =>
  hasInlineBinaryPayload(value)
    ? "binary media must be carried by ContentRef, never inline Base64"
    : undefined;

/**
 * Admission guard for new durable part arrays.
 *
 * RawPart is intentionally still decodable for installed history, but it is
 * not an admissible representation for a new task/message/artifact write.
 * ContentPart carries only immutable identity and descriptive metadata; the
 * bytes remain in the content service/data plane.
 */
export const validateDurableParts = (
  parts: ReadonlyArray<unknown>,
  field = "parts",
): string | undefined => {
  if (!Array.isArray(parts)) return `${field} must be an array`;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (hasInlineBinaryPayload(part)) {
      return `${field}[${index}] binary media must be carried by ContentRef, never inline Base64`;
    }
    if (
      part !== null &&
      typeof part === "object" &&
      !Array.isArray(part) &&
      (part as { readonly kind?: unknown }).kind === "content"
    ) {
      try {
        Schema.decodeUnknownSync(ContentPart, {
          onExcessProperty: "error",
        })(part);
      } catch {
        return `${field}[${index}] is not a valid ContentRef part`;
      }
    }
  }
  return undefined;
};

export const decodeContentRef = Schema.decodeUnknownEither(ContentRef, {
  onExcessProperty: "error",
});

export {
  asContentParts,
  collectContentRefsFromArtifact,
  collectContentRefsFromMessage,
  collectContentRefsFromParts,
  collectContentRefsFromTask,
  isVerifiedContentReceipt,
  taskContentIsRunnable,
  taskContentPendingMessage,
  taskContentReadiness,
  unavailableContentResolver,
  type ContentAvailabilityResolver,
  type TaskContentReadiness,
} from "./content-readiness";
