/**
 * The loom seed, kept beside the canvas in parts: a meta row, a row per card
 * and a row per wire. The renderer loads it before the planner's first plan
 * and saves only what changed after the planner settles.
 */
import { Context, Layer, Schema } from "effect";
import { Rpc, RpcGroup, type RpcClient, type RpcClientError } from "effect/rpc";
import { coreClient } from "./link";

/** The seed could not be read or written; the planner routes as a first plan. */
export class LoomSeedUnavailable extends Schema.TaggedError<LoomSeedUnavailable>()("LoomSeedUnavailable", {
  message: Schema.String,
}) {}

export const LoomSeedMeta = Schema.Struct({
  routerVersion: Schema.Number,
  fingerprint: Schema.Number,
  specsKey: Schema.String,
  geometryKey: Schema.Number,
});

export const LoomSeedCard = Schema.Struct({
  nodeId: Schema.String,
  x: Schema.Number,
  y: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
  obstacle: Schema.Boolean,
});

export const LoomSeedWire = Schema.Struct({
  wireId: Schema.String,
  specKey: Schema.String,
  fact: Schema.String,
});

export const LoomSeedSnapshot = Schema.Struct({
  meta: Schema.NullOr(LoomSeedMeta),
  cards: Schema.Array(LoomSeedCard),
  wires: Schema.Array(LoomSeedWire),
});

export const LoomSeedChanges = Schema.Struct({
  meta: LoomSeedMeta,
  cards: Schema.Array(LoomSeedCard),
  wires: Schema.Array(LoomSeedWire),
  removedCards: Schema.Array(Schema.String),
  removedWires: Schema.Array(Schema.String),
});

export const LoomSeedSaved = Schema.Boolean;

export const LoomSeedRpcs = RpcGroup.make(
  Rpc.make("LoomSeedLoad", {
    payload: { canvas: Schema.String },
    success: LoomSeedSnapshot,
    error: LoomSeedUnavailable,
  }),
  Rpc.make("LoomSeedSave", {
    payload: {
      canvas: Schema.String,
      meta: LoomSeedMeta,
      cards: Schema.Array(LoomSeedCard),
      wires: Schema.Array(LoomSeedWire),
      removedCards: Schema.Array(Schema.String),
      removedWires: Schema.Array(Schema.String),
    },
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
