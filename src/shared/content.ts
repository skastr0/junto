import { Schema } from "effect";

/**
 * Content is a data-plane object.  Work records carry only this metadata;
 * bytes travel through the content store/transfer plane and never through a
 * task, message, or artifact JSON snapshot.
 */

/** Canonical lower-case SHA-256 digest used as the immutable object identity. */
export const ContentSha256 = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  Schema.brand("ContentSha256"),
);
export type ContentSha256 = typeof ContentSha256.Type;

/**
 * Byte length is represented as a JSON-safe non-negative integer.  There is
 * intentionally no product-sized ceiling here: storage admission, disk
 * reserve, and transfer backpressure belong to their owning planes.
 */
export const ContentByteLength = Schema.Number.pipe(
  Schema.check(Schema.isInt()),
  Schema.check(Schema.isGreaterThanOrEqualTo(0)),
  Schema.check(Schema.makeFilter(Number.isSafeInteger, {
    message: "content byteLength must be a safe integer",
  })),
  Schema.brand("ContentByteLength"),
);
export type ContentByteLength = typeof ContentByteLength.Type;

/** MIME/media type metadata.  Parameters are preserved as authored. */
export const ContentMediaType = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(255)),
  Schema.check(Schema.isPattern(/^[^\u0000-\u001f\u007f]+$/)),
  Schema.brand("ContentMediaType"),
);
export type ContentMediaType = typeof ContentMediaType.Type;

/** Display-only metadata; it is never a path or an object identity. */
export const ContentDisplayName = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(255)),
  Schema.check(Schema.isPattern(/^[^\u0000-\u001f\u007f]+$/)),
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
  displayName: Schema.optionalKey(ContentDisplayName),
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
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(4_096)),
    Schema.check(Schema.isPattern(/^[^\u0000]+$/)),
  ),
});
export type ContentLocalPathProjection = typeof ContentLocalPathProjection.Type;

/** Short alias for callers that describe the projection as a content path. */
export const ContentPathProjection = ContentLocalPathProjection;
export type ContentPathProjection = ContentLocalPathProjection;

export const ContentAvailabilityReason = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(1_024)),
  Schema.check(Schema.isPattern(/^[^\u0000-\u001f\u007f]+$/)),
  Schema.brand("ContentAvailabilityReason"),
);
export type ContentAvailabilityReason = typeof ContentAvailabilityReason.Type;

export const ContentTimestamp = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(64)),
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
  Schema.check(Schema.makeFilter(({ ref, verifiedSha256, verifiedByteLength }) =>
    (ref.sha256 === verifiedSha256 && ref.byteLength === verifiedByteLength) ||
    "verified receipt does not match its ContentRef",)),
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
  observedSha256: Schema.optionalKey(ContentSha256),
  observedByteLength: Schema.optionalKey(ContentByteLength),
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
export const ContentAvailability = Schema.Union([ContentReceipt,
ContentMissing,
ContentCorrupt,
ContentUnavailable,]);
export type ContentAvailability = typeof ContentAvailability.Type;

/** Work part that names bytes in the content store (no inline payload). */
export const ContentPart = Schema.Struct({
  kind: Schema.Literal("content"),
  ref: ContentRef,
});
export type ContentPart = typeof ContentPart.Type;

/** Strict decoder used by ingress adapters that accept only a ref part. */
export const decodeContentPart = Schema.decodeUnknownResult(ContentPart, {
  onExcessProperty: "error",
});

/** Runtime narrowing helper for mixed Part arrays. */
export const isContentPart = (value: unknown): value is ContentPart => {
  try {
    Schema.decodeUnknownSync(ContentPart, { onExcessProperty: "error" })(value);
    return true;
  } catch {
    return false;
  }
};

export const decodeContentRef = Schema.decodeUnknownResult(ContentRef, {
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
