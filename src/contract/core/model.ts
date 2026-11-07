/**
 * The window's model reads, and its one model write: the canvas list, a
 * canvas opened, a command, the compiled actor refs. Main decodes the
 * renderer's arguments at its edge, so the core is only ever handed a canvas
 * name or a command. A refusal or a store failure fails the call with its
 * words, as the window shows them.
 */
import { Context, Layer, Schema } from "effect";
import { Rpc, RpcGroup, type RpcClient, type RpcClientError } from "effect/rpc";
import { CanvasName, Command, Opened, Seq } from "../../shared/model";
import { ActorRef } from "../../shared/work-reference";
import { coreClient } from "./link";

/** What the canvas list answers: a name and when it last changed. */
export const CanvasSummary = Schema.Struct({ name: Schema.String, modifiedAt: Schema.String });
export type CanvasSummary = typeof CanvasSummary.Type;

/** The canvas a read is about, as the window names it. */
export const ModelCanvasQuery = Schema.Struct({ canvas: CanvasName });
export type ModelCanvasQuery = typeof ModelCanvasQuery.Type;

/** What a canvas command did, and how many tasks it could not give back to a restored seat. */
export const ModelCommandResult = Schema.Struct({
  seq: Seq,
  tasksKept: Schema.optionalKey(Schema.Number),
});
export type ModelCommandResult = typeof ModelCommandResult.Type;

/** The model refused, or could not be read or written; the window shows the words. */
export class ModelFailed extends Schema.TaggedError<ModelFailed>()("ModelFailed", {
  message: Schema.String,
}) {}

export const ModelRpcs = RpcGroup.make(
  Rpc.make("ModelCanvases", { success: Schema.Array(CanvasSummary), error: ModelFailed }),
  Rpc.make("ModelOpen", { payload: ModelCanvasQuery, success: Opened, error: ModelFailed }),
  Rpc.make("ModelCommand", { payload: { command: Command }, success: ModelCommandResult, error: ModelFailed }),
  Rpc.make("ModelActorRefs", { payload: ModelCanvasQuery, success: Schema.Array(ActorRef), error: ModelFailed }),
).annotate(Rpc.ParseOptions, { onExcessProperty: "error" });

/** Main's client of the model group. A call fails with `RpcClientError` when the core it asked left before it answered. */
export class ModelCore extends Context.Service<ModelCore, RpcClient.FromGroup<typeof ModelRpcs, RpcClientError.RpcClientError>>()(
  "@junto/contract/ModelCore",
) {
  static readonly layer = Layer.effect(ModelCore, coreClient(ModelRpcs));
}
