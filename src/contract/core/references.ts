/**
 * The app briefing and references the window reads and writes. The store
 * lives with the core, its author is the operator, and each committed change
 * is published on the references channel, which main forwards to every window.
 *
 * Main decodes what the window sends and names the place (the app, or one
 * region of one canvas), so the core is only ever handed a place and a name.
 * A read that cannot be answered fails the call; a write the store refuses
 * answers with the reason in words.
 */
import { Context, Layer, Schema } from "effect";
import { Rpc, RpcGroup, type RpcClient, type RpcClientError } from "effect/rpc";
import {
  AppBriefing,
  AppBriefingWriteResult,
  ReferenceDeleteResult,
  ReferencePlace,
  ReferenceSummary,
  ReferenceWriteResult,
  StoredReference,
} from "../../shared/references";
import { coreClient } from "./link";

/** A read failed in the store, or a write could not be saved; the words are the operator's to read. */
export class ReferencesUnavailable extends Schema.TaggedError<ReferencesUnavailable>()("ReferencesUnavailable", {
  message: Schema.String,
}) {}

export const ReferencesRpcs = RpcGroup.make(
  Rpc.make("ReferencesBriefingRead", { success: Schema.NullOr(AppBriefing), error: ReferencesUnavailable }),
  Rpc.make("ReferencesBriefingWrite", { payload: { body: Schema.String }, success: AppBriefingWriteResult }),
  Rpc.make("ReferencesList", {
    payload: { place: ReferencePlace },
    success: Schema.Array(ReferenceSummary),
    error: ReferencesUnavailable,
  }),
  Rpc.make("ReferencesRead", {
    payload: { place: ReferencePlace, name: Schema.String },
    success: Schema.NullOr(StoredReference),
    error: ReferencesUnavailable,
  }),
  Rpc.make("ReferencesWrite", {
    payload: {
      place: ReferencePlace,
      name: Schema.String,
      description: Schema.optional(Schema.String),
      body: Schema.String,
    },
    success: ReferenceWriteResult,
  }),
  Rpc.make("ReferencesDelete", {
    payload: { place: ReferencePlace, name: Schema.String },
    success: ReferenceDeleteResult,
  }),
).annotateRpcs(Rpc.ParseOptions, { onExcessProperty: "error" });

/** Main's client of the references group. A call fails with `RpcClientError` when the core it asked left before it answered. */
export class ReferencesCore extends Context.Service<
  ReferencesCore,
  RpcClient.FromGroup<typeof ReferencesRpcs, RpcClientError.RpcClientError>
>()("@junto/contract/ReferencesCore") {
  static readonly layer = Layer.effect(ReferencesCore, coreClient(ReferencesRpcs));
}
