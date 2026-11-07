/**
 * The window's status reads: the authority banner, a canvas digest, usage,
 * and the kernel snapshot. Each answer is plain data. The authority read
 * answers null when the plane is off or cannot be read, so a ship window
 * shows none of it; a digest that cannot be read fails with its words.
 */
import { Context, Layer, Schema } from "effect";
import { Rpc, RpcGroup, type RpcClient, type RpcClientError } from "effect/rpc";
import { AuthorityWindowData } from "../../shared/authority";
import { UsageState } from "../../shared/usage";
import { ItemId, NodeId } from "../../shared/wire/ids";
import { coreClient } from "./link";

/** A canvas's digest, as the window compares it. */
export const DigestResult = Schema.Struct({ digest: Schema.String });
export type DigestResult = typeof DigestResult.Type;

/** Why a seat is blocked: one task it holds is waiting for input (`execution-graph.ts`). */
const BlockedReason = Schema.Struct({
  kind: Schema.Literal("task"),
  /** The task node the task sits on. */
  taskNodeId: NodeId,
  taskId: ItemId,
  detail: Schema.String,
  /** Epoch ms the task began waiting, when the task domain carries it. */
  since: Schema.optionalKey(Schema.Number),
});

/** The kernel's live projection of each canvas's execution graph, as it travels. */
export const KernelSnapshot = Schema.Struct({
  canvases: Schema.Record(
    Schema.String,
    Schema.Struct({
      execution: Schema.optionalKey(Schema.Struct({
        blocked: Schema.Array(Schema.String),
        reasonsByNodeId: Schema.Record(Schema.String, Schema.Array(BlockedReason)),
      })),
    }),
  ),
});

/** A canvas digest could not be read. */
export class StatusUnavailable extends Schema.TaggedError<StatusUnavailable>()("StatusUnavailable", {
  message: Schema.String,
}) {}

export const StatusRpcs = RpcGroup.make(
  Rpc.make("StatusAuthority", { success: Schema.NullOr(AuthorityWindowData) }),
  Rpc.make("StatusDigest", { payload: { name: Schema.String }, success: DigestResult, error: StatusUnavailable }),
  Rpc.make("StatusUsageCurrent", { success: UsageState }),
  Rpc.make("StatusUsageRefresh", { success: UsageState }),
  Rpc.make("StatusKernel", { success: KernelSnapshot }),
).annotateRpcs(Rpc.ParseOptions, { onExcessProperty: "error" });

/** Main's client of the status group. A call fails with `RpcClientError` when the core it asked left before it answered. */
export class StatusCore extends Context.Service<StatusCore, RpcClient.FromGroup<typeof StatusRpcs, RpcClientError.RpcClientError>>()(
  "@junto/contract/StatusCore",
) {
  static readonly layer = Layer.effect(StatusCore, coreClient(StatusRpcs));
}
