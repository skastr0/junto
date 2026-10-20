import { Schema } from "effect";
import { ContentStageArgs, type ContentStageResult } from "./content-stage";
import { CanvasName } from "./model/base";
import { ContentRef } from "./wire/content-ref";

/**
 * Files the operator attaches to mail: a thread mail or a signal answer.
 *
 * The bytes go into the Mac content store first, in pieces, through the same
 * staging a seat uses (`content.stage`), with the operator as the seat that
 * staged them. The mail then names each file by `ContentRef`, and main claims
 * it for that mail. The seat reads one line per file in the delivered mail,
 * with an absolute path it can open (`attachmentMailLines`).
 *
 * Nothing in an attachment is ever executed or opened by Junto: a file is
 * bytes, an image is drawn as a thumbnail. Pure, no Node imports.
 */

/** The most files one mail carries. */
export const OPERATOR_ATTACHMENTS_MAX = 10;

/** The most bytes one attached file holds. */
export const OPERATOR_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

/** Image types a composer and a thread draw as a thumbnail; anything else is a file chip. */
export const ATTACHMENT_THUMBNAIL_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/heic",
]);

export const isThumbnailType = (mediaType: string): boolean =>
  ATTACHMENT_THUMBNAIL_TYPES.has(mediaType.toLowerCase());

/** The files on one operator mail, as the send names them. */
export const OperatorAttachments = Schema.Array(ContentRef).pipe(
  Schema.check(Schema.isMaxLength(OPERATOR_ATTACHMENTS_MAX)),
);
export type OperatorAttachments = typeof OperatorAttachments.Type;

/**
 * One piece of an operator upload from the desktop: the canvas the mail is
 * for, and the same piece a seat sends to `content.stage`.
 */
export const OperatorContentPut = Schema.Struct({
  canvasName: CanvasName,
  stage: ContentStageArgs,
});
export type OperatorContentPut = typeof OperatorContentPut.Encoded;

export type OperatorContentPutResult =
  | { readonly ok: true; readonly result: ContentStageResult }
  | { readonly ok: false; readonly message: string };

/** A size as a reader says it: bytes, KB or MB. */
export const attachmentSizeLabel = (byteLength: number): string => {
  if (byteLength < 1024) return `${byteLength} ${byteLength === 1 ? "byte" : "bytes"}`;
  if (byteLength < 1024 * 1024) return `${Math.round(byteLength / 1024)} KB`;
  return `${(byteLength / (1024 * 1024)).toFixed(1)} MB`;
};

/** The name a file is shown and delivered under. */
export const attachmentDisplayName = (ref: Pick<ContentRef, "displayName">): string =>
  ref.displayName?.trim() || "file";

/**
 * The delivered mail's lines for its files, one per file: its name, type and
 * size, and the absolute local path the seat reads it from.
 */
export const attachmentMailLines = (
  refs: ReadonlyArray<ContentRef>,
  pathOf: (ref: ContentRef) => string,
): string[] =>
  refs.map(
    (ref) =>
      `Attached: ${attachmentDisplayName(ref)} (${ref.mediaType}, ${attachmentSizeLabel(ref.byteLength)}): ${pathOf(ref)}`,
  );
