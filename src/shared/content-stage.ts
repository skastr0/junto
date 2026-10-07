import { Schema } from "effect";
import {
  ContentDisplayName,
  ContentIdentity,
  ContentMediaType,
  ContentRef,
} from "./wire/content-ref";

/**
 * `content.stage`: a seat puts a file of its own into the content store,
 * ahead of the record that will name it.
 *
 * Bytes never ride inside the record's own request: one request is bounded
 * by the work socket's frame, and a whole file in one frame is the file in
 * memory twice. So a file crosses in pieces, each its own call, and the
 * record (a signal, today) names the result by `ContentRef`.
 *
 * One op, three moments told apart by its args:
 *
 *   first piece   {bytesBase64}                    -> {stageId, byteLength}
 *   next piece    {stageId, bytesBase64}           -> {stageId, byteLength}
 *   last piece    {stageId?, bytesBase64?, done}   -> {ref}
 *
 * A small file is one call: `{bytesBase64, done}`. Pieces arrive in order;
 * there are no offsets and no resume, and a failed upload is started over.
 * A path never crosses the socket.
 *
 * Pure, no Node imports (CLI safe).
 */

/** The most raw bytes one piece carries. As Base64 it stays under the frame. */
export const CONTENT_STAGE_PIECE_BYTES = 4 * 1024 * 1024;

/** The most Base64 characters a piece of that size encodes to. */
export const CONTENT_STAGE_PIECE_BASE64_LENGTH =
  Math.ceil(CONTENT_STAGE_PIECE_BYTES / 3) * 4;

/** The most uploads one seat may have open at a time. */
export const CONTENT_STAGE_MAX_OPEN_PER_SEAT = 1000;

/** An upload with no new piece for this long is dropped. */
export const CONTENT_STAGE_IDLE_MS = 60 * 60 * 1000;

/** A finished upload nobody claimed is let go after this long. */
export const CONTENT_STAGE_UNCLAIMED_MS = 60 * 60 * 1000;

/** What the owner of a staged, not yet claimed, reference is recorded as. */
export const CONTENT_STAGE_OWNER_PREFIX = "stage:";

export const ContentStageId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^stg_[a-f0-9]{32}$/)),
);
export type ContentStageId = typeof ContentStageId.Type;

const Base64Piece = Schema.String.pipe(
  Schema.check(Schema.isMaxLength(CONTENT_STAGE_PIECE_BASE64_LENGTH)),
);

/** Closes the upload: what the file is, and optionally what it must hash to. */
export const ContentStageDone = Schema.Struct({
  mediaType: ContentMediaType,
  displayName: Schema.optionalKey(ContentDisplayName),
  /** When given, bytes that do not match are refused and nothing is kept. */
  expected: Schema.optionalKey(ContentIdentity),
});
export type ContentStageDone = typeof ContentStageDone.Type;

export const ContentStageArgs = Schema.Struct({
  /** Absent on the first piece; main answers with it. */
  stageId: Schema.optionalKey(ContentStageId),
  /** Standard Base64 of at most `CONTENT_STAGE_PIECE_BYTES` raw bytes. */
  bytesBase64: Schema.optionalKey(Base64Piece),
  done: Schema.optionalKey(ContentStageDone),
}).pipe(
  Schema.check(Schema.makeFilter(({ bytesBase64, done }) =>
    bytesBase64 !== undefined || done !== undefined ||
    "a call carries a piece (bytesBase64), closes the upload (done), or both")),
).annotate({
  parseOptions: { onExcessProperty: "error" },
});
export type ContentStageArgs = typeof ContentStageArgs.Type;

/** The answer to a piece that does not close the upload. */
export const ContentStageOpen = Schema.Struct({
  stageId: ContentStageId,
  /** Bytes received so far. */
  byteLength: Schema.Number,
});
export type ContentStageOpen = typeof ContentStageOpen.Type;

/** The answer to `done`: the file, as the content store holds it. */
export const ContentStageClosed = Schema.Struct({ ref: ContentRef });
export type ContentStageClosed = typeof ContentStageClosed.Type;

export const ContentStageResult = Schema.Union([ContentStageOpen, ContentStageClosed]);
export type ContentStageResult = typeof ContentStageResult.Type;
