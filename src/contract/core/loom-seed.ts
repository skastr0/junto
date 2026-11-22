/**
 * The loom's settled routes, kept beside the canvas and read by the planner's
 * worker before its first plan. Derived local data: one seed per canvas at a
 * router version, never journalled and never sent to another machine.
 */
import { Context, Layer, Schema } from "effect";
import { Rpc, RpcGroup, type RpcClient, type RpcClientError } from "effect/rpc";
import { coreClient } from "./link";

/** The seed could not be read or written; the planner routes as a first plan. */
export class LoomSeedUnavailable extends Schema.TaggedError<LoomSeedUnavailable>()("LoomSeedUnavailable", {
  message: Schema.String,
}) {}

export const LoomSeedStored = Schema.Struct({
  routerVersion: Schema.Number,
  seedJson: Schema.String,
});

export const LoomSeedSaved = Schema.Boolean;

export const LoomSeedRpcs = RpcGroup.make(
  Rpc.make("LoomSeedLoad", {
    payload: { canvas: Schema.String },
    success: Schema.NullOr(LoomSeedStored),
    error: LoomSeedUnavailable,
  }),
  Rpc.make("LoomSeedSave", {
    payload: { canvas: Schema.String, routerVersion: Schema.Number, seedJson: Schema.String },
    success: LoomSeedSaved,
    error: LoomSeedUnavailable,
  }),
).annotateRpcs(Rpc.ParseOptions, { onExcessProperty: "error" });

/** Main's client of the loom-seed group. */
export class LoomSeedCore extends Context.Service<
  LoomSeedCore,
  RpcClient.FromGroup<typeof LoomSeedRpcs, RpcClientError.RpcClientError>
>()("@junto/contract/LoomSeedCore") {
  static readonly layer = Layer.effect(LoomSeedCore, coreClient(LoomSeedRpcs));
}
