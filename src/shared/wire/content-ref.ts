import { Schema } from "effect";

/**
 * The portable reference to one immutable content object, and the fields it
 * is made of. It lives with the wire modules because a signal carries its
 * attachments as these references; `src/shared/content.ts` re-exports it.
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
