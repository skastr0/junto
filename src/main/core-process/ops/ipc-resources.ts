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
import type { IpcMain } from "electron";
import { Effect, Schema } from "effect";
import type { ArtifactMoveRun, ArtifactMoveRunAnswer, ArtifactMoveRunInput } from "@shared/artifact-move";
import { productResourceKindEnabled } from "@shared/features";
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
  liveResourceIpcPorts,
  pendingArtifacts,
  pendingTasks,
  postThread,
  taskContext,
  type ResourceAuthoring,
  type ResourceIpcPorts,
} from "../../junto/work/resource-ipc";
import { WorkService } from "../../junto/work/service";
import { coreRunner } from "../../core-runner";
import type { CoreClient } from "../client";
import { coreOps, type CoreOp } from "../ops";
import { publish } from "../push";

/** A resource's rows changed, from any surface: main broadcasts it to the window. */
export const RESOURCE_CHANGED = "resource.changed";
/** A comment landed on a resource whose own rows did not change. */
export const RESOURCE_THREAD_CHANGED = "resource.threadChanged";

/** What crosses on the two notices: the window's own channel and what it carries. */
export type ResourceChangedPush = { readonly channel: string; readonly canvasName: string };
export type ResourceThreadChangedPush = ResourceChangedPush & { readonly kind: string };

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

/**
 * The ports, built on the work service the core holds: a canvas read and a
 * node's comments, both read only.
 */
const withPorts = <A, E>(
  use: (ports: ResourceIpcPorts) => Effect.Effect<A, E>,
): Effect.Effect<A, E, WorkService> =>
  Effect.map(WorkService, (work) =>
    liveResourceIpcPorts(
      (canvasName: string) =>
        work.readTopology(canvasName).pipe(
          Effect.map((read) => read.canvas),
          Effect.mapError(() => ({
            type: "InternalError" as const,
            message: `canvas ${canvasName} could not be read`,
            details: { retryable: true },
          })),
        ),
      (canvasName: string, nodeId: string) =>
        work.readMailbox(canvasName, nodeId).pipe(
          Effect.mapError(() => ({
            type: "InternalError" as const,
            message: `the comments on ${nodeId} could not be read`,
            details: { retryable: true },
          })),
        ),
    ),
  ).pipe(Effect.flatMap(use));

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

/**
 * Main's side: the same channels, each answer one core call under the same
 * authoring label, and the two notices broadcast as they come. A product this
 * build turns off still registers nothing.
 */
export const registerResourceIpcCore = (
  ipc: Pick<IpcMain, "handle">,
  core: CoreClient,
  broadcast: (channel: string, payload: unknown) => void,
  enabled: { readonly task: boolean; readonly artifact: boolean; readonly file: boolean },
  authoring: { readonly task: ResourceAuthoring; readonly artifact: ResourceAuthoring; readonly thread: ResourceAuthoring },
): (() => void) => {
  const live = {
    task: enabled.task && productResourceKindEnabled("task"),
    artifact: enabled.artifact && productResourceKindEnabled("artifact"),
    file: enabled.file,
  };
  const on = <O>(
    channel: string,
    call: (input: unknown) => Promise<O>,
    authored?: ResourceAuthoring,
  ): void => {
    ipc.handle(channel, (_event, input: unknown) => {
      const operation = () => call(input);
      return authored === undefined ? operation() : (authored(operation) as Promise<O>);
    });
  };
  const task = RESOURCE_IPC_CHANNELS.task;
  if (live.task) {
    on(task.list, (input) => core.call("ipc.resource.task.list", { input }));
    on(task.all, (input) => core.call("ipc.resource.task.all", { input }));
    on(task.context, (input) => core.call("ipc.resource.task.context", { input }));
    on(task.apply, (input) => core.call("ipc.resource.task.apply", { input }), authoring.task);
    on(task.pending, (input) => core.call("ipc.resource.task.pending", { input }));
  }
  const artifact = RESOURCE_IPC_CHANNELS.artifact;
  if (live.artifact) {
    on(artifact.list, (input) => core.call("ipc.resource.artifact.list", { input }));
    on(artifact.history, (input) => core.call("ipc.resource.artifact.history", { input }));
    on(artifact.moves, (input) => core.call("ipc.resource.artifact.moves", { input }));
    on(artifact.body, (input) => core.call("ipc.resource.artifact.body", { input }));
    on(artifact.apply, (input) => core.call("ipc.resource.artifact.apply", { input }), authoring.artifact);
    on(artifact.pending, (input) => core.call("ipc.resource.artifact.pending", { input }));
    on(artifact.labelColours, (input) => core.call("ipc.resource.artifact.labelColours", { input }));
    on(artifact.colour, (input) => core.call("ipc.resource.artifact.colour", { input }), authoring.artifact);
  }
  const thread = RESOURCE_IPC_CHANNELS.thread;
  if (live.task || live.artifact || live.file) {
    on(thread.list, (input) => core.call("ipc.resource.thread.list", { input }));
    on(thread.post, (input) => core.call("ipc.resource.thread.post", { input }), authoring.thread);
  }
  void broadcast;
  return () => undefined;
};

/**
 * The operator's artifact move, run here, where the store is. The overseer's
 * `artifact.move` and the window's "Move to..." reach the same `moveArtifacts`;
 * the window crosses the port, the overseer is already in this process.
 */
export const coreArtifactMove: ArtifactMoveRun = (input, by) =>
  coreRunner.runPromise(withPorts((ports) => moveArtifacts(ports, input, by)));
