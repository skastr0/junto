/**
 * The renderer's tasks, artifacts and their threads (junto/ipc.ts): every
 * read from the same ports the CLI verbs use, and every write one
 * ResourceCommand submitted to the same ruler. The handlers register on
 * main's channels as they did; each answer is a core call, and the core
 * decodes the renderer's payload where it uses it.
 *
 * A change is told to the window from the core's own notice
 * (`onResourceChanged`, `onThreadChanged`), so a write made by any surface
 * reaches the window, not only one made here. Main relays both onto the
 * channels the window listens to.
 */
import { Effect, Schema } from "effect";
import type { ArtifactMoveRun, ArtifactMoveRunAnswer, ArtifactMoveRunInput } from "@shared/artifact-move";
import {
  ArtifactApplyInput,
  ArtifactBodyInput,
  ArtifactColourInput,
  ArtifactHistoryInput,
  ArtifactLabelColoursInput,
  ArtifactListInput,
  ArtifactMovesInput,
  ArtifactPendingInput,
  RESOURCE_IPC_CHANNELS,
  TaskAllInput,
  TaskApplyInput,
  TaskContextInput,
  TaskListInput,
  TaskPendingInput,
  ThreadListInput,
  ThreadPostInput,
} from "@shared/resource-ipc";
import { moveArtifacts } from "../../junto/work/artifact-move";
import type { ResourceActor } from "@shared/resource-command";
import { onResourceChanged, onThreadChanged } from "../../junto/work/resource-changes";
import {
  allTasks,
  applyArtifact,
  applyTask,
  artifactBody,
  artifactHistory,
  artifactLabelColours,
  artifactMoves,
  colourArtifactLabel,
  listArtifacts,
  listTasks,
  listThreads,
  pendingArtifacts,
  pendingTasks,
  postThread,
  taskContext,
  type ResourceAuthoring,
} from "../../junto/work/resource-ipc";
import { workResourcePorts as withPorts } from "../../junto/work/resource-ports";
import {
  RESOURCE_CHANGED,
  RESOURCE_THREAD_CHANGED,
  type ResourceChangedPush,
  type ResourceThreadChangedPush,
} from "../channels";
import { coreOps, type CoreOp } from "../ops";
import { publish } from "../push";

declare module "../ops" {
  interface CoreOps {
    "ipc.resource.task.list": CoreOp<{ readonly input: unknown }, unknown>;
    "ipc.resource.task.all": CoreOp<{ readonly input: unknown }, unknown>;
    "ipc.resource.task.context": CoreOp<{ readonly input: unknown }, unknown>;
    "ipc.resource.task.apply": CoreOp<{ readonly input: unknown }, unknown>;
    "ipc.resource.task.pending": CoreOp<{ readonly input: unknown }, unknown>;
    "ipc.resource.artifact.list": CoreOp<{ readonly input: unknown }, unknown>;
    "ipc.resource.artifact.history": CoreOp<{ readonly input: unknown }, unknown>;
    "ipc.resource.artifact.moves": CoreOp<{ readonly input: unknown }, unknown>;
    "ipc.resource.artifact.body": CoreOp<{ readonly input: unknown }, unknown>;
    "ipc.resource.artifact.apply": CoreOp<{ readonly input: unknown }, unknown>;
    "ipc.resource.artifact.pending": CoreOp<{ readonly input: unknown }, unknown>;
    "ipc.resource.artifact.labelColours": CoreOp<{ readonly input: unknown }, unknown>;
    "ipc.resource.artifact.colour": CoreOp<{ readonly input: unknown }, unknown>;
    "ipc.resource.thread.list": CoreOp<{ readonly input: unknown }, unknown>;
    "ipc.resource.thread.post": CoreOp<{ readonly input: unknown }, unknown>;
    "ipc.resource.move": CoreOp<{ readonly input: ArtifactMoveRunInput; readonly by: ResourceActor }, ArtifactMoveRunAnswer>;
  }
}

/** The renderer's payload, decoded strictly where it is used. */
const decoded = <S extends Schema.Top>(schema: S, input: unknown) =>
  Schema.decodeUnknownEffect(schema as never)(input, { onExcessProperty: "error" }) as Effect.Effect<
    S["Type"],
    Schema.SchemaError
  >;

// The notices a write leaves. Told from here so any surface's write reaches
// the window; main relays both onto the channels the window listens to.
onResourceChanged((domain: string, canvasName: string) =>
  publish(
    RESOURCE_CHANGED,
    { channel: RESOURCE_IPC_CHANNELS[domain as "task" | "artifact"].changed, canvasName } satisfies ResourceChangedPush,
  ),
);
onThreadChanged((kind: string, canvasName: string) =>
  publish(
    RESOURCE_THREAD_CHANGED,
    { channel: RESOURCE_IPC_CHANNELS.thread.changed, canvasName, kind } satisfies ResourceThreadChangedPush,
  ),
);

coreOps({
  "ipc.resource.task.list": ({ input }) =>
    withPorts((ports) =>
      Effect.flatMap(decoded(TaskListInput, input), (ready) => listTasks(ports, ready.canvasName, ready.nodeId)),
    ),
  "ipc.resource.task.all": ({ input }) =>
    withPorts((ports) => Effect.flatMap(decoded(TaskAllInput, input), (ready) => allTasks(ports, ready.canvasName))),
  "ipc.resource.task.context": ({ input }) =>
    withPorts((ports) =>
      Effect.flatMap(decoded(TaskContextInput, input), (ready) => taskContext(ports, ready.canvasName)),
    ),
  "ipc.resource.task.apply": ({ input }) =>
    withPorts((ports) =>
      Effect.flatMap(decoded(TaskApplyInput, input), (ready) =>
        applyTask(ports, ready.canvasName, ready.nodeId, ready.taskId, ready.opId, ready.command),
      ),
    ),
  "ipc.resource.task.pending": ({ input }) =>
    withPorts((ports) =>
      Effect.flatMap(decoded(TaskPendingInput, input), (ready) => pendingTasks(ports, ready.canvasName, ready.nodeId)),
    ),
  "ipc.resource.artifact.list": ({ input }) =>
    withPorts((ports) =>
      Effect.flatMap(decoded(ArtifactListInput, input), (ready) => listArtifacts(ports, ready.canvasName, ready.nodeId)),
    ),
  "ipc.resource.artifact.history": ({ input }) =>
    withPorts((ports) =>
      Effect.flatMap(decoded(ArtifactHistoryInput, input), (ready) =>
        artifactHistory(ports, ready.canvasName, ready.artifactId),
      ),
    ),
  "ipc.resource.artifact.moves": ({ input }) =>
    withPorts((ports) =>
      Effect.flatMap(decoded(ArtifactMovesInput, input), (ready) =>
        artifactMoves(ports, ready.canvasName, ready.artifactId),
      ),
    ),
  "ipc.resource.artifact.body": ({ input }) =>
    withPorts((ports) =>
      Effect.flatMap(decoded(ArtifactBodyInput, input), (ready) =>
        artifactBody(ports, ready.canvasName, ready.artifactId, ready.version),
      ),
    ),
  "ipc.resource.artifact.apply": ({ input }) =>
    withPorts((ports) =>
      Effect.flatMap(decoded(ArtifactApplyInput, input), (ready) =>
        applyArtifact(ports, ready.canvasName, ready.nodeId, ready.artifactId, ready.opId, ready.op),
      ),
    ),
  "ipc.resource.artifact.pending": ({ input }) =>
    withPorts((ports) =>
      Effect.flatMap(decoded(ArtifactPendingInput, input), (ready) =>
        pendingArtifacts(ports, ready.canvasName, ready.nodeId),
      ),
    ),
  "ipc.resource.artifact.labelColours": ({ input }) =>
    withPorts((ports) =>
      Effect.flatMap(decoded(ArtifactLabelColoursInput, input), (ready) =>
        artifactLabelColours(ports, ready.canvasName, ready.nodeId),
      ),
    ),
  "ipc.resource.artifact.colour": ({ input }) =>
    withPorts((ports) =>
      Effect.flatMap(decoded(ArtifactColourInput, input), (ready) =>
        colourArtifactLabel(ports, ready.canvasName, ready.nodeId, ready.opId, ready.label, ready.colour),
      ),
    ),
  "ipc.resource.thread.list": ({ input }) =>
    withPorts((ports) =>
      Effect.flatMap(decoded(ThreadListInput, input), (ready) => listThreads(ports, ready.canvasName, ready.subject)),
    ),
  "ipc.resource.thread.post": ({ input }) =>
    withPorts((ports) =>
      Effect.flatMap(decoded(ThreadPostInput, input), (ready) =>
        postThread(ports, ready.canvasName, ready.subject, ready.post),
      ),
    ),
  "ipc.resource.move": ({ input, by }) => withPorts((ports) => moveArtifacts(ports, input, by)),
});
