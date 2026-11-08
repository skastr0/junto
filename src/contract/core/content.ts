/**
 * What the window writes and stages through the content core: the operator's
 * attachment pieces, an image put, the portrait overrides, and a page box
 * comment's shot purge. Every answer is plain data; the window broadcasts
 * what it must (a portrait save, a guidance write) after the call.
 *
 * Main decodes what the window sends, so the core is only handed what it can
 * read. A put or a save the core refuses answers in words; only a read of
 * the portrait overrides fails the call.
 */
import { Context, Layer, Schema } from "effect";
import { Rpc, RpcGroup, type RpcClient, type RpcClientError } from "effect/rpc";
import { OperatorContentPut, OperatorContentPutResult } from "../../shared/operator-attachments";
import { PageShotPurged, PageShotPurgeRequest } from "../../shared/page-shot";
import {
  PortraitOverride,
  PortraitOverrideSetResult,
  PortraitOverrides,
  PortraitSeatId,
} from "../../shared/portrait-overrides";
import { ContentRef } from "../../shared/wire/content-ref";
import { coreClient } from "./link";

/** The portrait overrides could not be read from the store. */
export class PortraitOverridesUnavailable extends Schema.TaggedError<PortraitOverridesUnavailable>()(
  "PortraitOverridesUnavailable",
  { message: Schema.String },
) {}

/** An image the window puts: its bytes as Base64, its media type and the name it is shown under. */
export const ContentPutImageInput = Schema.Struct({
  bytesBase64: Schema.String,
  mediaType: Schema.String,
  displayName: Schema.optional(Schema.String),
});
export type ContentPutImageInput = typeof ContentPutImageInput.Type;

/** The reference to the stored image, or why it was refused. */
export const ContentPutImageResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), ref: ContentRef }),
  Schema.Struct({ ok: Schema.Literal(false), error: Schema.String }),
]);
export type ContentPutImageResult = typeof ContentPutImageResult.Type;

export const ContentRpcs = RpcGroup.make(
  /** A file the operator attaches to mail, one piece at a time, staged as the operator on the canvas the mail is written to. */
  Rpc.make("ContentOperatorPut", { payload: OperatorContentPut, success: OperatorContentPutResult }),
  /** Image content put: canvas image nodes and note embeds. The content store only; the document carries ContentRef URLs, never Base64. */
  Rpc.make("ContentPutImage", { payload: ContentPutImageInput, success: ContentPutImageResult }),
  /** The operator's per-seat character customization: an install-local preference like settings. */
  Rpc.make("ContentPortraitOverrides", { success: PortraitOverrides, error: PortraitOverridesUnavailable }),
  /** One seat's override, or null to reset it; a refusal by the store is an answer, not a failure. */
  Rpc.make("ContentPortraitOverrideSet", {
    payload: { seatId: PortraitSeatId, override: Schema.NullOr(PortraitOverride) },
    success: PortraitOverrideSetResult,
  }),
  /** The operator's purge of a page box comment's shot; the window holds the main-authoring gate around this call. */
  Rpc.make("ContentPageShotPurge", { payload: PageShotPurgeRequest, success: PageShotPurged }),
).annotateRpcs(Rpc.ParseOptions, { onExcessProperty: "error" });

/** Main's client of the content group. A call fails with `RpcClientError` when the core it asked left before it answered. */
export class ContentCore extends Context.Service<ContentCore, RpcClient.FromGroup<typeof ContentRpcs, RpcClientError.RpcClientError>>()(
  "@junto/contract/ContentCore",
) {
  static readonly layer = Layer.effect(ContentCore, coreClient(ContentRpcs));
}
