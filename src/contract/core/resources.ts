/**
 * The renderer's tasks, artifacts and their threads: every read the window
 * makes of the core's stores and every write it submits to the core's ruler,
 * as one group. Main decodes what the renderer sends closed, at its edge
 * (`src/app/core-process/main-side/resources.ts`), so each payload here is a
 * value that already decoded; the core answers with Schemas both ends decode
 * closed. The handlers are `src/core/ops/ipc-resources.ts`.
 *
 * A write the ruler refuses is an answer (`kind: "refused"`), never a failure.
 * A read the store could not make fails with `ResourceUnavailable`.
 */
import { Context, Layer, Schema } from "effect";
import { Rpc, RpcGroup, type RpcClient, type RpcClientError } from "effect/rpc";
import { ArtifactBody, ArtifactVersionRecord } from "../../shared/artifact";
import { ArtifactMoveRecord } from "../../shared/artifact-move";
import {
  ArtifactApplyInput,
  ArtifactApplyOutcome,
  ArtifactBodyInput,
  ArtifactColourInput,
  ArtifactHeadWire,
  ArtifactHistoryInput,
  ArtifactLabelColoursInput,
  ArtifactLabelColoursWire,
  ArtifactListInput,
  ArtifactMovesInput,
  ArtifactPendingInput,
  ArtifactPendingWriteWire,
  ResourceApplyOutcomeWire,
  SubjectThreadView,
  TaskAllInput,
  TaskApplyInput,
  TaskApplyOutcome,
  TaskCanvasFacts,
  TaskContextInput,
  TaskListInput,
  TaskPendingInput,
  TaskPendingWriteWire,
  TaskViewWire,
  ThreadListInput,
  ThreadPostInput,
  ThreadPostOutcome,
} from "../../shared/resource-ipc";
import { coreClient } from "./link";

/** A read could not be made; the window's call rejects with what the store said. */
export class ResourceUnavailable extends Schema.TaggedError<ResourceUnavailable>()("ResourceUnavailable", {
  message: Schema.String,
}) {}

export const ResourcesRpcs = RpcGroup.make(
  Rpc.make("ResourceTaskList", { payload: TaskListInput, success: Schema.Array(TaskViewWire), error: ResourceUnavailable }),
  Rpc.make("ResourceTaskAll", { payload: TaskAllInput, success: Schema.Array(TaskViewWire), error: ResourceUnavailable }),
  Rpc.make("ResourceTaskContext", { payload: TaskContextInput, success: TaskCanvasFacts, error: ResourceUnavailable }),
  Rpc.make("ResourceTaskApply", { payload: TaskApplyInput, success: TaskApplyOutcome }),
  Rpc.make("ResourceTaskPending", {
    payload: TaskPendingInput,
    success: Schema.Array(TaskPendingWriteWire),
    error: ResourceUnavailable,
  }),
  Rpc.make("ResourceArtifactList", { payload: ArtifactListInput, success: Schema.Array(ArtifactHeadWire), error: ResourceUnavailable }),
  Rpc.make("ResourceArtifactHistory", {
    payload: ArtifactHistoryInput,
    success: Schema.Array(ArtifactVersionRecord),
    error: ResourceUnavailable,
  }),
  Rpc.make("ResourceArtifactMoves", {
    payload: ArtifactMovesInput,
    success: Schema.Array(ArtifactMoveRecord),
    error: ResourceUnavailable,
  }),
  /** One version's body; null when the store does not hold it. */
  Rpc.make("ResourceArtifactBody", { payload: ArtifactBodyInput, success: Schema.NullOr(ArtifactBody), error: ResourceUnavailable }),
  Rpc.make("ResourceArtifactApply", { payload: ArtifactApplyInput, success: ArtifactApplyOutcome }),
  Rpc.make("ResourceArtifactPending", {
    payload: ArtifactPendingInput,
    success: Schema.Array(ArtifactPendingWriteWire),
    error: ResourceUnavailable,
  }),
  Rpc.make("ResourceArtifactLabelColours", {
    payload: ArtifactLabelColoursInput,
    success: ArtifactLabelColoursWire,
    error: ResourceUnavailable,
  }),
  Rpc.make("ResourceArtifactColour", { payload: ArtifactColourInput, success: ResourceApplyOutcomeWire }),
  Rpc.make("ResourceThreadList", { payload: ThreadListInput, success: Schema.Array(SubjectThreadView), error: ResourceUnavailable }),
  Rpc.make("ResourceThreadPost", { payload: ThreadPostInput, success: ThreadPostOutcome }),
).annotate(Rpc.ParseOptions, { onExcessProperty: "error" });

/** Main's client of the resources group. A call fails with `RpcClientError` when the core it asked left before it answered. */
export class ResourcesCore extends Context.Service<ResourcesCore, RpcClient.FromGroup<typeof ResourcesRpcs, RpcClientError.RpcClientError>>()(
  "@junto/contract/ResourcesCore",
) {
  static readonly layer = Layer.effect(ResourcesCore, coreClient(ResourcesRpcs));
}
