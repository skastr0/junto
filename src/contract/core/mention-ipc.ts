/**
 * The window's backlinks read: where a seat, a task, an artifact or a page
 * is mentioned, read from `work_mentions` and named against the canvas as it
 * is now, a page at a time. Main decodes the renderer's query at its edge.
 * A cursor that does not read, or a canvas that cannot be read, fails with
 * its words. Every added backlink is pushed on its own channel as it commits.
 */
import { Context, Layer, Schema } from "effect";
import { Rpc, RpcGroup, type RpcClient, type RpcClientError } from "effect/rpc";
import { MentionListInput, MentionPage } from "../../shared/mention-ipc";
import { coreClient } from "./link";

/** The mentions could not be read: a bad cursor, or the canvas or its store unreadable. */
export class MentionsUnreadable extends Schema.TaggedError<MentionsUnreadable>()("MentionsUnreadable", {
  message: Schema.String,
}) {}

export const MentionRpcs = RpcGroup.make(
  Rpc.make("MentionList", { payload: MentionListInput, success: MentionPage, error: MentionsUnreadable }),
).annotateRpcs(Rpc.ParseOptions, { onExcessProperty: "error" });

/** Main's client of the mention group. A call fails with `RpcClientError` when the core it asked left before it answered. */
export class MentionCore extends Context.Service<MentionCore, RpcClient.FromGroup<typeof MentionRpcs, RpcClientError.RpcClientError>>()(
  "@junto/contract/MentionCore",
) {
  static readonly layer = Layer.effect(MentionCore, coreClient(MentionRpcs));
}
